import { describe, it, expect, vi, afterEach } from "vitest";
import {
  streamCompletion, ContextSizeError,
  type ApiStandard, type AuthMode, type StreamChunk, type StreamMessage, type ToolDefinition,
} from "../ai";
import type { ReasoningEffort } from "../ai/reasoning";

/** Build a fetch Response whose body streams the given raw chunks. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function mockFetch(chunks: string[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return sseResponse(chunks);
    })
  );
  return calls;
}

async function collect(opts: {
  chunks: string[];
  standard?: ApiStandard;
  baseUrl?: string;
  maxOutput?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  messages?: StreamMessage[];
  prefix?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<{ received: StreamChunk[]; calls: { url: string; body: Record<string, unknown> }[] }> {
  const calls = mockFetch(opts.chunks);
  const received: StreamChunk[] = [];
  await streamCompletion({
    baseUrl: opts.baseUrl ?? "https://api.example.com/v1",
    apiKey: "test-key",
    standard: opts.standard ?? "openai",
    modelId: "test-model",
    messages: opts.messages ?? [{ role: "user", content: "hi" }],
    prefix: opts.prefix,
    maxOutput: opts.maxOutput,
    reasoningEffort: opts.reasoningEffort,
    tools: opts.tools,
    toolChoice: opts.toolChoice,
    onChunk: (c) => received.push(c),
  });
  return { received, calls };
}

const text = (received: StreamChunk[]) =>
  received
    .filter((c): c is { text: string } => "text" in c)
    .map((c) => c.text)
    .join("");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamCompletion — context size guard", () => {
  it("rejects before sending when the estimated prompt exceeds contextSize", async () => {
    const calls = mockFetch([]);
    await expect(
      streamCompletion({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        standard: "openai",
        modelId: "test-model",
        contextSize: 500,
        messages: [{ role: "user", content: "x".repeat(4000) }], // ~1000 tokens
        onChunk: () => {},
      }),
    ).rejects.toBeInstanceOf(ContextSizeError);
    expect(calls.length).toBe(0); // nothing was sent
  });

  it("sends normally when the prompt fits within contextSize", async () => {
    const calls = mockFetch([`data: [DONE]\n`]);
    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      standard: "openai",
      modelId: "test-model",
      contextSize: 10_000,
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(calls.length).toBe(1);
  });

  it("counts tool schemas toward the estimate, not just message content", async () => {
    // A short message alone fits comfortably, but the agent runtime's tool
    // schemas (name + description + JSON-schema parameters) ride along on
    // every request too and can be several KB for the full toolset — large
    // enough on their own to trip a small model's real context window even
    // when the messages array looks tiny.
    const bigTool: ToolDefinition = {
      type: "function",
      function: {
        name: "read_file",
        description: "x".repeat(2000),
        parameters: { type: "object", properties: {} },
      },
    };
    const calls = mockFetch([]);

    await expect(
      streamCompletion({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        standard: "openai",
        modelId: "test-model",
        contextSize: 500,
        messages: [{ role: "user", content: "hi" }], // trivially small alone
        tools: [bigTool],
        onChunk: () => {},
      }),
    ).rejects.toBeInstanceOf(ContextSizeError);
    expect(calls.length).toBe(0);
  });
});

describe("streamCompletion — OpenAI SSE", () => {
  it("parses content deltas and final usage across chunks", async () => {
    const { received } = await collect({
      chunks: [
        `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n`,
        `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n`,
        `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n`,
        `data: [DONE]\n\n`,
      ],
    });
    expect(text(received)).toBe("Hello");
    expect(received[received.length - 1]).toEqual({ done: true, inputTokens: 10, outputTokens: 5 });
  });

  it("reassembles an SSE line split across network chunks", async () => {
    // One JSON line split mid-token — naive per-chunk parsing would drop it.
    const line = `data: {"choices":[{"delta":{"content":"whole"}}]}\n`;
    const { received } = await collect({
      chunks: [line.slice(0, 20), line.slice(20), `data: [DONE]\n`],
    });
    expect(text(received)).toBe("whole");
  });

  it("accumulates streamed tool_call fragments into complete calls", async () => {
    const { received } = await collect({
      chunks: [
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_","arguments":"{\\"pa"}}]}}]}\n`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"a.md\\"}"}}]}}]}\n`,
        `data: [DONE]\n`,
      ],
    });
    const toolChunk = received.find((c) => "toolCalls" in c) as { toolCalls: unknown[] };
    expect(toolChunk).toBeDefined();
    expect(toolChunk.toolCalls).toEqual([
      { index: 0, id: "call_1", name: "read_file", arguments: '{"path":"a.md"}' },
    ]);
  });

  it("emits done even when the stream ends without [DONE]", async () => {
    const { received } = await collect({
      chunks: [`data: {"choices":[{"delta":{"content":"tail"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}`],
    });
    expect(text(received)).toBe("tail");
    expect(received[received.length - 1]).toEqual({ done: true, inputTokens: 1, outputTokens: 2 });
  });

  it("prepends the model prefix as a leading system instruction", async () => {
    const { calls } = await collect({
      chunks: [`data: [DONE]\n`],
      messages: [
        { role: "system", content: "base system" },
        { role: "user", content: "hi" },
      ],
      prefix: "PREFIX",
    });
    const sent = calls[0].body.messages as { role: string; content: string }[];
    expect(sent[0].role).toBe("system");
    expect(sent[0].content).toBe("PREFIX\n\nbase system");
    expect(sent).toHaveLength(2);
  });

  it("rejects on a mid-stream error event instead of completing silently", async () => {
    // OpenRouter and similar relays return HTTP 200, then deliver a failure
    // (moderation block, upstream outage) as an SSE data event.
    mockFetch([
      `data: {"choices":[{"delta":{"content":"partial"}}]}\n`,
      `data: {"error":{"message":"upstream provider is overloaded"}}\n`,
      `data: [DONE]\n`,
    ]);
    await expect(
      streamCompletion({
        baseUrl: "https://api.example.com/v1",
        apiKey: "k",
        standard: "openai",
        modelId: "m",
        messages: [{ role: "user", content: "hi" }],
        onChunk: () => {},
      }),
    ).rejects.toThrow(/upstream provider is overloaded/);
  });

  it("rejects on a content_filter finish_reason instead of completing as an empty success", async () => {
    // Azure OpenAI and several compat gateways signal a filtered response
    // this way (no error status), often with little or no text.
    mockFetch([
      `data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n`,
      `data: [DONE]\n`,
    ]);
    await expect(
      streamCompletion({
        baseUrl: "https://api.example.com/v1",
        apiKey: "k",
        standard: "openai",
        modelId: "m",
        messages: [{ role: "user", content: "hi" }],
        onChunk: () => {},
      }),
    ).rejects.toThrow(/content_filter/);
  });

  it("flags a length finish_reason as truncated rather than a plain success", async () => {
    const { received } = await collect({
      chunks: [
        `data: {"choices":[{"delta":{"content":"cut off"}}]}\n`,
        `data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n`,
        `data: [DONE]\n`,
      ],
    });
    expect(received[received.length - 1]).toEqual({
      done: true, inputTokens: 1, outputTokens: 2, truncated: true,
    });
  });

  it("reports cached tokens as a subset of input tokens", async () => {
    const { received } = await collect({
      chunks: [
        `data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":80}}}\n`,
        `data: [DONE]\n`,
      ],
    });
    expect(received[received.length - 1]).toEqual({
      done: true, inputTokens: 100, outputTokens: 5, cachedTokens: 80,
    });
  });

  it("omits cachedTokens when the provider reports none", async () => {
    const { received } = await collect({
      chunks: [`data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n`, `data: [DONE]\n`],
    });
    expect(received[received.length - 1]).toEqual({ done: true, inputTokens: 10, outputTokens: 5 });
  });
});

describe("streamCompletion — Gemini SSE", () => {
  it("parses text parts, skips thoughts, and reads usageMetadata", async () => {
    const { received } = await collect({
      standard: "gemini",
      chunks: [
        `data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true},{"text":"Hi "}]}}]}\n`,
        `data: {"candidates":[{"content":{"parts":[{"text":"there"}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}\n`,
      ],
    });
    expect(text(received)).toBe("Hi there");
    expect(received[received.length - 1]).toEqual({ done: true, inputTokens: 7, outputTokens: 3 });
  });

  it("emits complete functionCall parts as tool calls", async () => {
    const { received } = await collect({
      standard: "gemini",
      chunks: [
        `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"list_files","args":{"dir":"writing"}}}]}}]}\n`,
      ],
    });
    const toolChunk = received.find((c) => "toolCalls" in c) as {
      toolCalls: { name: string; arguments: string }[];
    };
    expect(toolChunk.toolCalls).toHaveLength(1);
    expect(toolChunk.toolCalls[0].name).toBe("list_files");
    expect(JSON.parse(toolChunk.toolCalls[0].arguments)).toEqual({ dir: "writing" });
  });

  it("throws a descriptive error when the prompt is safety-blocked", async () => {
    mockFetch([`data: {"promptFeedback":{"blockReason":"SAFETY"}}\n`]);
    await expect(
      streamCompletion({
        baseUrl: "",
        apiKey: "k",
        standard: "gemini",
        modelId: "m",
        messages: [{ role: "user", content: "hi" }],
        onChunk: () => {},
      })
    ).rejects.toThrow(/SAFETY/);
  });

  it("throws when the response (not just the prompt) is safety-blocked mid-generation", async () => {
    // No promptFeedback.blockReason here — the filter trips after some text
    // already streamed, signaled only via candidates[0].finishReason.
    mockFetch([
      `data: {"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"SAFETY"}]}\n`,
    ]);
    await expect(
      streamCompletion({
        baseUrl: "",
        apiKey: "k",
        standard: "gemini",
        modelId: "m",
        messages: [{ role: "user", content: "hi" }],
        onChunk: () => {},
      })
    ).rejects.toThrow(/SAFETY/);
  });

  it("flags a MAX_TOKENS finishReason as truncated rather than a plain success", async () => {
    const { received } = await collect({
      standard: "gemini",
      chunks: [
        `data: {"candidates":[{"content":{"parts":[{"text":"cut off"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":8}}\n`,
      ],
    });
    expect(received[received.length - 1]).toEqual({
      done: true, inputTokens: 4, outputTokens: 8, truncated: true,
    });
  });

  it("folds thinking tokens into output tokens", async () => {
    // candidatesTokenCount alone would undercount a thinking model's real
    // output — thoughtsTokenCount is billed as output too.
    const { received } = await collect({
      standard: "gemini",
      chunks: [
        `data: {"candidates":[{"content":{"parts":[{"text":"answer"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":50,"thoughtsTokenCount":500}}\n`,
      ],
    });
    expect(received[received.length - 1]).toEqual({ done: true, inputTokens: 10, outputTokens: 550 });
  });

  it("reports cached tokens as a subset of input tokens", async () => {
    const { received } = await collect({
      standard: "gemini",
      chunks: [
        `data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":5,"cachedContentTokenCount":80}}\n`,
      ],
    });
    expect(received[received.length - 1]).toEqual({
      done: true, inputTokens: 100, outputTokens: 5, cachedTokens: 80,
    });
  });
});

describe("streamCompletion — reasoning effort", () => {
  const done = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n', "data: [DONE]\n"];

  it("sends nothing at all when the model has no effort set", async () => {
    // The whole safety story rests on this: a model configured before the
    // setting existed must keep producing byte-identical requests, because a
    // field this app volunteers is a field some relay can reject.
    const { calls } = await collect({ chunks: done });
    expect(calls[0].body).not.toHaveProperty("reasoning_effort");
    expect(calls[0].body).not.toHaveProperty("thinking");
  });

  it('sends nothing for "default" too', async () => {
    const { calls } = await collect({ chunks: done, reasoningEffort: "default" });
    expect(calls[0].body).not.toHaveProperty("reasoning_effort");
  });

  it("maps the app's levels onto the protocol's own spelling", async () => {
    for (const [effort, wire] of [
      ["off", "none"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["max", "max"],
    ] as const) {
      const { calls } = await collect({ chunks: done, reasoningEffort: effort });
      expect(calls[0].body.reasoning_effort).toBe(wire);
    }
  });

  it("reaches a compat endpoint too — same wire protocol, same field", async () => {
    const { calls } = await collect({
      chunks: done, standard: "openai_compat", reasoningEffort: "high",
    });
    expect(calls[0].body.reasoning_effort).toBe("high");
  });

  it("lets extraBody override the configured level", async () => {
    // extraBody is the per-request escape hatch; config must not outrank it.
    const calls = mockFetch(done);
    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      standard: "openai",
      modelId: "m",
      reasoningEffort: "max",
      extraBody: { reasoning_effort: "low" },
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(calls[0].body.reasoning_effort).toBe("low");
  });

  it("stays off the wire for families whose translation isn't written yet", async () => {
    // Gemini and Anthropic keep their pre-existing bodies until their own
    // mapping lands — an untranslated level must not leak as an OpenAI field.
    const gemini = await collect({
      chunks: ['data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n'],
      standard: "gemini",
      reasoningEffort: "max",
    });
    expect(gemini.calls[0].body).not.toHaveProperty("reasoning_effort");

    const anthropic = await collect({
      chunks: ['event: message_stop\ndata: {"type":"message_stop"}\n\n'],
      standard: "anthropic",
      reasoningEffort: "max",
    });
    expect(anthropic.calls[0].body).not.toHaveProperty("reasoning_effort");
  });
});

describe("streamCompletion — reasoning content", () => {
  const finish = "data: [DONE]\n";

  it("streams reasoning as its own chunk, never as answer text", async () => {
    // The distinction is load-bearing: `text` chunks are what gets inserted
    // into the manuscript.
    const { received } = await collect({
      chunks: [
        'data: {"choices":[{"delta":{"reasoning_content":"let me think"}}]}\n',
        'data: {"choices":[{"delta":{"content":"the answer"}}]}\n',
        finish,
      ],
    });
    expect(received).toContainEqual({ reasoning: "let me think" });
    expect(text(received)).toBe("the answer");
  });

  it("reads the other spelling in circulation too", async () => {
    const { received } = await collect({
      chunks: ['data: {"choices":[{"delta":{"reasoning":"hmm"}}]}\n', finish],
    });
    expect(received).toContainEqual({ reasoning: "hmm" });
  });

  it("ignores a non-string reasoning field instead of stringifying it", async () => {
    // Some endpoints send a structured `reasoning_details` beside the plain
    // field; coercing an object would put "[object Object]" in the transcript.
    const { received } = await collect({
      chunks: ['data: {"choices":[{"delta":{"reasoning":{"blocks":[]}}}]}\n', finish],
    });
    expect(received.some((c) => "reasoning" in c)).toBe(false);
  });

  it("hands the round's whole reasoning back with the tool calls", async () => {
    const { received } = await collect({
      chunks: [
        'data: {"choices":[{"delta":{"reasoning_content":"I need "}}]}\n',
        'data: {"choices":[{"delta":{"reasoning_content":"the date"}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_date","arguments":"{}"}}]}}]}\n',
        finish,
      ],
    });
    const tools = received.find((c) => "toolCalls" in c) as {
      _reasoning?: { field: string; text: string };
    };
    // Accumulated whole, and tagged with the field it arrived under so the
    // echo can match.
    expect(tools._reasoning).toEqual({ field: "reasoning_content", text: "I need the date" });
  });

  it("echoes a tool-call turn's reasoning back under its own field name", async () => {
    // Required, not optional: thinking endpoints reject a tool-calling history
    // whose reasoning is missing, so a thinking model could otherwise never
    // finish a tool loop.
    const calls = mockFetch([finish]);
    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      standard: "openai_compat",
      modelId: "m",
      messages: [
        { role: "user", content: "what day is it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "get_date", arguments: "{}" } }],
          _reasoning: { field: "reasoning_content", text: "I need the date" },
        },
        { role: "tool", tool_call_id: "c1", content: "2026-08-13" },
      ],
      onChunk: () => {},
    });
    const wire = calls[0].body.messages as Record<string, unknown>[];
    expect(wire[1].reasoning_content).toBe("I need the date");
    // The app's own bookkeeping never reaches the wire.
    expect(wire[1]).not.toHaveProperty("_reasoning");
  });

  it("echoes under whichever field the endpoint used", async () => {
    const calls = mockFetch([finish]);
    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      standard: "openai_compat",
      modelId: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
          _reasoning: { field: "reasoning", text: "thought" },
        },
      ],
      onChunk: () => {},
    });
    const wire = calls[0].body.messages as Record<string, unknown>[];
    expect(wire[0].reasoning).toBe("thought");
    expect(wire[0]).not.toHaveProperty("reasoning_content");
  });

  it("strips internal fields from messages that carry no reasoning", async () => {
    // _geminiModelParts belongs to the other protocol; it used to ride along
    // into OpenAI request bodies untouched.
    const calls = mockFetch([finish]);
    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      standard: "openai",
      modelId: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
          _geminiModelParts: [{ text: "x" }],
        },
      ],
      onChunk: () => {},
    });
    const wire = calls[0].body.messages as Record<string, unknown>[];
    expect(wire[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
    });
  });
});

describe("streamCompletion — endpoints that inline their thinking", () => {
  it("keeps a <think> block out of the answer text", async () => {
    // Some endpoints wrap thinking in tags inside `content` rather than giving
    // it a field. Unsplit it would be inserted into the manuscript.
    const { received } = await collect({
      chunks: [
        'data: {"choices":[{"delta":{"content":"<think>\\nweighing"}}]}\n',
        'data: {"choices":[{"delta":{"content":" it up\\n</think>\\n\\n她推开门。"}}]}\n',
        "data: [DONE]\n",
      ],
    });
    expect(text(received)).toBe("\n\n她推开门。");
    expect(
      received.filter((c): c is { reasoning: string } => "reasoning" in c)
        .map((c) => c.reasoning).join(""),
    ).toBe("\nweighing it up\n");
  });

  it("does not echo inlined thinking back — it has no field of its own", async () => {
    // Reasoning that arrived inside `content` cannot be replayed as a top-level
    // key; inventing one would send a field no endpoint knows.
    const { received } = await collect({
      chunks: [
        'data: {"choices":[{"delta":{"content":"<think>hmm</think>"}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{}"}}]}}]}\n',
        "data: [DONE]\n",
      ],
    });
    const tools = received.find((c) => "toolCalls" in c) as { _reasoning?: unknown };
    expect(tools._reasoning).toBeUndefined();
  });
});

describe("streamCompletion — HTTP 200 failures", () => {
  it("surfaces a status object delivered on a 200 body", async () => {
    // Auth failure, rate limiting and insufficient balance arrive this way on
    // some endpoints. Unhandled, an expired key reads as an empty completion.
    await expect(collect({
      chunks: ['data: {"base_resp":{"status_code":1004,"status_msg":"invalid api key"}}\n'],
    })).rejects.toThrow(/invalid api key/);
  });

  it("treats status_code 0 as the success it is", async () => {
    const { received } = await collect({
      chunks: [
        'data: {"base_resp":{"status_code":0,"status_msg":""},"choices":[{"delta":{"content":"hi"}}]}\n',
        "data: [DONE]\n",
      ],
    });
    expect(text(received)).toBe("hi");
  });
});

describe("streamCompletion — toolChoice", () => {
  const TOOL: ToolDefinition = {
    type: "function",
    function: {
      name: "update_lore_metadata",
      description: "d",
      parameters: { type: "object", properties: {}, required: [] },
    },
  };

  it("forwards a forced tool_choice into the OpenAI body", async () => {
    const calls = mockFetch([`data: [DONE]\n`]);
    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      standard: "openai",
      modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [TOOL],
      toolChoice: { type: "function", function: { name: "update_lore_metadata" } },
      onChunk: () => {},
    });
    expect(calls[0].body.tools).toBeDefined();
    expect(calls[0].body.tool_choice).toEqual({
      type: "function",
      function: { name: "update_lore_metadata" },
    });
  });

  it("maps a forced tool_choice to Gemini's function_calling_config", async () => {
    const calls = mockFetch([`data: {"candidates":[{"content":{"parts":[]}}]}\n`]);
    await streamCompletion({
      baseUrl: "",
      apiKey: "k",
      standard: "gemini",
      modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [TOOL],
      toolChoice: { type: "function", function: { name: "update_lore_metadata" } },
      onChunk: () => {},
    });
    expect(calls[0].body.tool_config).toEqual({
      function_calling_config: {
        mode: "ANY",
        allowed_function_names: ["update_lore_metadata"],
      },
    });
  });

  it("omits Gemini tool_config when toolChoice is auto/unset", async () => {
    const calls = mockFetch([`data: {"candidates":[{"content":{"parts":[]}}]}\n`]);
    await streamCompletion({
      baseUrl: "",
      apiKey: "k",
      standard: "gemini",
      modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [TOOL],
      onChunk: () => {},
    });
    expect(calls[0].body.tools).toBeDefined();
    expect(calls[0].body.tool_config).toBeUndefined();
  });
});

describe("streamCompletion — Anthropic SSE", () => {
  const ANTHROPIC = { standard: "anthropic" as const };

  const TOOL: ToolDefinition = {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  };

  it("parses text deltas and reports usage from message_start + message_delta", async () => {
    const { received } = await collect({
      ...ANTHROPIC,
      chunks: [
        `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n`,
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
    });
    expect(text(received)).toBe("Hello");
    expect(received[received.length - 1]).toEqual({ done: true, inputTokens: 10, outputTokens: 5 });
  });

  it("sums the three disjoint prompt buckets and reports cache reads as cachedTokens", async () => {
    // input_tokens is the UNCACHED remainder here, unlike OpenAI/Gemini where
    // the cached count is a subset of it. Reading input_tokens alone would
    // report 10 for a 910-token prompt.
    const { received } = await collect({
      ...ANTHROPIC,
      chunks: [
        `data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":800,"cache_creation_input_tokens":100}}}\n\n`,
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
    });
    expect(received[received.length - 1]).toEqual({
      done: true,
      inputTokens: 910,
      outputTokens: 7,
      cachedTokens: 800,
    });
  });

  it("flags truncation on stop_reason max_tokens", async () => {
    const { received } = await collect({
      ...ANTHROPIC,
      chunks: [
        `data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"cut"}}\n\n`,
        `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":2}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
    });
    expect(received[received.length - 1]).toMatchObject({ done: true, truncated: true });
  });

  it("reassembles a streamed tool_use from input_json_delta fragments", async () => {
    const { received } = await collect({
      ...ANTHROPIC,
      tools: [TOOL],
      chunks: [
        `data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Paris\\"}"}}\n\n`,
        `data: {"type":"content_block_stop","index":0}\n\n`,
        `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
    });
    const toolChunk = received.find((c) => "toolCalls" in c) as { toolCalls: unknown[] };
    expect(toolChunk.toolCalls).toEqual([
      { index: 0, id: "toolu_1", name: "get_weather", arguments: `{"city":"Paris"}` },
    ]);
  });

  it("emits {} for a tool call that streams no arguments at all", async () => {
    const { received } = await collect({
      ...ANTHROPIC,
      tools: [TOOL],
      chunks: [
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_2","name":"get_weather"}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
    });
    const toolChunk = received.find((c) => "toolCalls" in c) as { toolCalls: { arguments: string }[] };
    // The agent runtime JSON.parses this; "" would be a parse error.
    expect(toolChunk.toolCalls[0].arguments).toBe("{}");
  });

  it("throws on an in-band error event delivered under HTTP 200", async () => {
    await expect(
      collect({
        ...ANTHROPIC,
        chunks: [
          `data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n`,
          `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`,
        ],
      }),
    ).rejects.toThrow(/Overloaded/);
  });

  it("throws rather than reporting a refusal as a short answer", async () => {
    await expect(
      collect({
        ...ANTHROPIC,
        chunks: [
          `data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":1}}\n\n`,
        ],
      }),
    ).rejects.toThrow(/declined this response/);
  });

  it("emits done even when the stream ends without message_stop", async () => {
    const { received } = await collect({
      ...ANTHROPIC,
      chunks: [
        `data: {"type":"message_start","message":{"usage":{"input_tokens":6}}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n`,
      ],
    });
    expect(text(received)).toBe("hi");
    expect(received[received.length - 1]).toMatchObject({ done: true, inputTokens: 6 });
  });

  it("hoists system messages into the top-level system field", async () => {
    const { calls } = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    });
    expect(calls[0].url).toBe("https://api.example.com/v1/messages");
    expect(calls[0].body.system).toBe("be terse");
    expect(calls[0].body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("merges adjacent same-role turns, which Anthropic rejects", async () => {
    const { calls } = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      messages: [
        { role: "user", content: "one" },
        { role: "user", content: "two" },
        { role: "assistant", content: "ok" },
      ],
    });
    expect(calls[0].body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
  });

  it("round-trips a tool call and its result into tool_use / tool_result blocks", async () => {
    const { calls } = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "toolu_9", type: "function", function: { name: "get_weather", arguments: `{"city":"Paris"}` } },
          ],
        },
        { role: "tool", tool_call_id: "toolu_9", content: "sunny" },
        { role: "tool", tool_call_id: "toolu_9b", content: "warm" },
      ],
    });
    expect(calls[0].body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_9", name: "get_weather", input: { city: "Paris" } }],
      },
      // Both results in ONE user message — Anthropic requires a turn's
      // tool_results to arrive together.
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_9", content: "sunny" },
          { type: "tool_result", tool_use_id: "toolu_9b", content: "warm" },
        ],
      },
    ]);
  });

  it("converts a data-URL image part into a base64 image block", async () => {
    const { calls } = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    expect(calls[0].body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ]);
  });

  it("sends max_tokens from maxOutput, falling back to a constant", async () => {
    const withCap = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      maxOutput: 1234,
    });
    expect(withCap.calls[0].body.max_tokens).toBe(1234);

    const without = await collect({ ...ANTHROPIC, chunks: [`data: {"type":"message_stop"}\n\n`] });
    // Required by the Messages API — there is no server-side default to omit to.
    // Roomy because thinking tokens come out of the same budget.
    expect(without.calls[0].body.max_tokens).toBe(32_768);
  });

  it("keeps thinking on even when a tool is forced", async () => {
    // Adaptive thinking supports forced tool use, so the old "disable thinking
    // on the forced-tool path" workaround is gone. Keeping it would have been
    // actively harmful: several models in the supported range reject
    // `thinking: {type: "disabled"}` outright.
    const forced = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      tools: [TOOL],
      toolChoice: { type: "function", function: { name: "get_weather" } },
    });
    expect(forced.calls[0].body.tool_choice).toEqual({ type: "tool", name: "get_weather" });
    expect(forced.calls[0].body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("maps every toolChoice to Anthropic's own spelling", async () => {
    const auto = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      tools: [TOOL],
    });
    expect(auto.calls[0].body.tool_choice).toEqual({ type: "auto" });

    const required = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      tools: [TOOL],
      toolChoice: "required",
    });
    expect(required.calls[0].body.tool_choice).toEqual({ type: "any" });
  });

  it("asks for adaptive thinking with visible text by default", async () => {
    // Two things at once: the supported range (4.6+) speaks adaptive, and the
    // current generation defaults display to "omitted" — which bills the
    // thinking in full and returns an empty string for it.
    const { calls } = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
    });
    expect(calls[0].body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("honours a declared dialect over the family default", async () => {
    const calls = mockFetch([`data: {"type":"message_stop"}\n\n`]);
    await streamCompletion({
      baseUrl: "https://api.anthropic.com",
      apiKey: "k",
      standard: "anthropic_compat",
      modelId: "relay-hosted-claude",
      thinkingDialect: "extended",
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    const thinking = calls[0].body.thinking as Record<string, unknown>;
    expect(thinking.type).toBe("enabled");
    // Bounded below max_tokens: the budget is thinking-only and the response
    // still needs room.
    expect(thinking.budget_tokens).toBeLessThan(calls[0].body.max_tokens as number);
    expect(thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
  });

  it("sends no thinking field when the author declared none", async () => {
    const calls = mockFetch([`data: {"type":"message_stop"}\n\n`]);
    await streamCompletion({
      baseUrl: "https://api.anthropic.com",
      apiKey: "k",
      standard: "anthropic_compat",
      modelId: "m",
      thinkingDialect: "none",
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(calls[0].body).not.toHaveProperty("thinking");
  });

  it("keeps a tiny output cap from starving the response", async () => {
    // budget_tokens must stay under max_tokens; a caller that configured a
    // small cap must not end up with a budget that leaves no room for text.
    const calls = mockFetch([`data: {"type":"message_stop"}\n\n`]);
    await streamCompletion({
      baseUrl: "https://api.anthropic.com",
      apiKey: "k",
      standard: "anthropic",
      modelId: "m",
      thinkingDialect: "extended",
      maxOutput: 4000,
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    const thinking = calls[0].body.thinking as { budget_tokens: number };
    expect(thinking.budget_tokens).toBe(2000);
  });

  it("puts effort in output_config, governing the whole response", async () => {
    const calls = mockFetch([`data: {"type":"message_stop"}\n\n`]);
    await streamCompletion({
      baseUrl: "https://api.anthropic.com",
      apiKey: "k",
      standard: "anthropic",
      modelId: "m",
      reasoningEffort: "medium",
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(calls[0].body.output_config).toEqual({ effort: "medium" });
  });

  it('maps "off" to the lowest effort rather than disabling thinking', async () => {
    // Disabling is rejected outright by several models in the supported range,
    // and the vendor's own advice for spending less is to lower effort.
    const calls = mockFetch([`data: {"type":"message_stop"}\n\n`]);
    await streamCompletion({
      baseUrl: "https://api.anthropic.com",
      apiKey: "k",
      standard: "anthropic",
      modelId: "m",
      reasoningEffort: "off",
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(calls[0].body.output_config).toEqual({ effort: "low" });
    expect(calls[0].body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("streams thinking_delta as reasoning, never as answer text", async () => {
    const { received } = await collect({
      ...ANTHROPIC,
      chunks: [
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"weighing it"}}\n\n`,
        `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"the answer"}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
    });
    expect(received).toContainEqual({ reasoning: "weighing it" });
    expect(text(received)).toBe("the answer");
  });

  it("does not surface signature_delta — it is carry-back, not reading material", async () => {
    const { received } = await collect({
      ...ANTHROPIC,
      chunks: [
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EosnCkYICxIM"}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
    });
    expect(received.some((c) => "reasoning" in c || "text" in c)).toBe(false);
  });

  it("carries a tool round's thinking blocks back verbatim, in order", async () => {
    // Omitting them doesn't error — the API silently turns thinking off for the
    // request. That is the whole reason this is tested rather than trusted.
    const { received } = await collect({
      ...ANTHROPIC,
      chunks: [
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I need the weather"}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EosnCkYICxIM"}}\n\n`,
        `data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque"}}\n\n`,
        `data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}\n\n`,
        `data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
    });
    const call = received.find((c) => "toolCalls" in c) as {
      _thinkingBlocks?: { modelId: string; blocks: Record<string, unknown>[] };
    };
    expect(call._thinkingBlocks?.modelId).toBe("test-model");
    // Both kinds, in the order the model produced them. redacted_thinking is
    // included on purpose: filtering on type === "thinking" drops it and
    // breaks the round trip.
    expect(call._thinkingBlocks?.blocks).toEqual([
      { type: "thinking", thinking: "I need the weather", signature: "EosnCkYICxIM" },
      { type: "redacted_thinking", data: "opaque" },
    ]);
  });

  it("replays those blocks ahead of the tool_use on the next request", async () => {
    const calls = mockFetch([`data: {"type":"message_stop"}\n\n`]);
    const blocks = [
      { type: "thinking", thinking: "reasoned", signature: "sig" },
      { type: "redacted_thinking", data: "opaque" },
    ];
    await streamCompletion({
      baseUrl: "https://api.anthropic.com",
      apiKey: "k",
      standard: "anthropic",
      modelId: "claude-x",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
          _thinkingBlocks: { modelId: "claude-x", blocks },
        },
        { role: "tool", tool_call_id: "toolu_1", content: "20C" },
      ],
      onChunk: () => {},
    });
    const wire = calls[0].body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(wire[1].content).toEqual([
      ...blocks,
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
    ]);
    // The app's own bookkeeping never reaches the wire.
    expect(wire[1]).not.toHaveProperty("_thinkingBlocks");
  });

  it("drops thinking blocks produced by a different model", async () => {
    // The author can switch models mid-conversation. Another model won't
    // reject foreign blocks — it ignores them and bills them as input anyway.
    const calls = mockFetch([`data: {"type":"message_stop"}\n\n`]);
    await streamCompletion({
      baseUrl: "https://api.anthropic.com",
      apiKey: "k",
      standard: "anthropic",
      modelId: "claude-y",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "toolu_1", type: "function", function: { name: "f", arguments: "{}" } }],
          _thinkingBlocks: { modelId: "claude-x", blocks: [{ type: "thinking", thinking: "old" }] },
        },
        { role: "tool", tool_call_id: "toolu_1", content: "r" },
      ],
      onChunk: () => {},
    });
    const wire = calls[0].body.messages as { content: Record<string, unknown>[] }[];
    expect(wire[1].content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "f", input: {} },
    ]);
  });

  it("emits no carrier at all when the model produced no thinking", async () => {
    const { received } = await collect({
      ...ANTHROPIC,
      chunks: [
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"f"}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
    });
    const call = received.find((c) => "toolCalls" in c) as { _thinkingBlocks?: unknown };
    expect(call._thinkingBlocks).toBeUndefined();
  });

  it("sends tool definitions in Anthropic's input_schema shape", async () => {
    const { calls } = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      tools: [TOOL],
    });
    expect(calls[0].body.tools).toEqual([
      {
        name: TOOL.function.name,
        description: TOOL.function.description,
        input_schema: TOOL.function.parameters,
      },
    ]);
  });

  it("authenticates with x-api-key and a pinned anthropic-version, never a query param", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), headers: new Headers(init.headers) });
        return sseResponse([`data: {"type":"message_stop"}\n\n`]);
      }),
    );
    await streamCompletion({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-secret",
      standard: "anthropic",
      modelId: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(calls[0].headers.get("x-api-key")).toBe("sk-ant-secret");
    expect(calls[0].headers.get("anthropic-version")).toBe("2023-06-01");
    expect(calls[0].url).not.toContain("sk-ant-secret");
  });

  it("does not forward extraBody, which carries OpenAI-shaped fields", async () => {
    const calls = mockFetch([`data: {"type":"message_stop"}\n\n`]);
    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      standard: "anthropic",
      modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      // The Messages API 400s on unknown top-level fields.
      extraBody: { response_format: { type: "json_object" } },
      onChunk: () => {},
    });
    expect(calls[0].body.response_format).toBeUndefined();
  });
});

describe("streamCompletion — auth header", () => {
  /** Capture the outgoing request headers. */
  function mockFetchHeaders() {
    const calls: { headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ headers: new Headers(init.headers) });
        return sseResponse([`data: [DONE]\n`]);
      }),
    );
    return calls;
  }

  it("sends a bearer token when an API key is set", async () => {
    const calls = mockFetchHeaders();
    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      standard: "openai",
      modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(calls[0].headers.get("Authorization")).toBe("Bearer test-key");
  });

  it("omits Authorization for keyless local servers (Ollama)", async () => {
    const calls = mockFetchHeaders();
    await streamCompletion({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      standard: "openai_compat",
      modelId: "llama3",
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(calls[0].headers.has("Authorization")).toBe(false);
  });
});

describe("streamCompletion — endpoint URLs", () => {
  const DONE = [`data: {"type":"message_stop"}\n\n`];

  // The Anthropic ecosystem's ANTHROPIC_BASE_URL is a bare root and the client
  // appends /v1/messages, so all three of these are the same endpoint written
  // three ways — and the first is what every third-party gateway's docs give.
  it.each([
    ["root", "https://relay.example.com/anthropic"],
    ["root + /v1", "https://relay.example.com/anthropic/v1"],
    ["full endpoint URL", "https://relay.example.com/anthropic/v1/messages"],
    ["trailing slash", "https://relay.example.com/anthropic/"],
  ])("normalizes an Anthropic base given as %s", async (_label, baseUrl) => {
    const { calls } = await collect({ standard: "anthropic_compat", baseUrl, chunks: DONE });
    expect(calls[0].url).toBe("https://relay.example.com/anthropic/v1/messages");
  });

  it("falls back to the vendor endpoint when a base URL is empty", async () => {
    const { calls } = await collect({ standard: "anthropic", baseUrl: "", chunks: DONE });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");

    const openai = await collect({
      standard: "openai",
      baseUrl: "",
      chunks: [`data: [DONE]\n\n`],
    });
    expect(openai.calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("routes a compat standard to its family's adapter, not the OpenAI one", async () => {
    const { calls } = await collect({
      standard: "anthropic_compat",
      baseUrl: "https://relay.example.com/v1",
      chunks: DONE,
    });
    // The Anthropic adapter hoists nothing into `messages` and requires
    // max_tokens; the OpenAI one would have sent `stream_options` instead.
    expect(calls[0].body.max_tokens).toBeDefined();
    expect(calls[0].body.stream_options).toBeUndefined();
  });

  it("names the URL it called in the error, so a wrong base is diagnosable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>404</html>", { status: 404 })),
    );
    await expect(
      streamCompletion({
        baseUrl: "https://relay.example.com/anthropic",
        apiKey: "k",
        standard: "anthropic_compat",
        modelId: "claude",
        messages: [{ role: "user", content: "hi" }],
        onChunk: () => {},
      }),
    ).rejects.toThrow("https://relay.example.com/anthropic/v1/messages");
  });
});

describe("streamCompletion — Anthropic auth modes", () => {
  function headersOf(authMode?: AuthMode): Promise<Headers> {
    const calls: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(new Headers(init.headers));
        return sseResponse([`data: {"type":"message_stop"}\n\n`]);
      }),
    );
    return streamCompletion({
      baseUrl: "https://relay.example.com",
      apiKey: "k-123",
      standard: "anthropic_compat",
      authMode,
      modelId: "claude",
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    }).then(() => calls[0]);
  }

  // The two conventions are ANTHROPIC_API_KEY -> x-api-key and
  // ANTHROPIC_AUTH_TOKEN -> Authorization: Bearer. A gateway reading the header
  // this app doesn't send sees an unauthenticated request and 401s.
  it("sends x-api-key by default, so an existing provider keeps working", async () => {
    for (const mode of [undefined, "default" as const]) {
      const headers = await headersOf(mode);
      expect(headers.get("x-api-key")).toBe("k-123");
      expect(headers.has("Authorization")).toBe(false);
    }
  });

  it("swaps to a bearer token when the endpoint wants ANTHROPIC_AUTH_TOKEN", async () => {
    const headers = await headersOf("bearer");
    expect(headers.get("Authorization")).toBe("Bearer k-123");
    expect(headers.has("x-api-key")).toBe(false);
  });

  it("can send both for a gateway whose docs name neither", async () => {
    const headers = await headersOf("both");
    expect(headers.get("x-api-key")).toBe("k-123");
    expect(headers.get("Authorization")).toBe("Bearer k-123");
  });

  it("keeps the pinned API version whichever mode is used", async () => {
    expect((await headersOf("bearer")).get("anthropic-version")).toBe("2023-06-01");
  });
});

describe("streamCompletion — compat standards reach their own adapter", () => {
  // The failure this guards against is silent: an unhandled standard falls into
  // the OpenAI branch, which posts a shape the endpoint answers with a 400 that
  // looks like a config error rather than a routing bug.
  it("sends a gemini_compat request in the Gemini shape, to the given base", async () => {
    const { calls } = await collect({
      standard: "gemini_compat",
      baseUrl: "https://relay.example.com/v1beta",
      chunks: [`data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n`],
    });
    expect(calls[0].url).toBe(
      "https://relay.example.com/v1beta/models/test-model:streamGenerateContent?alt=sse",
    );
    expect(calls[0].body.contents).toBeDefined();
    expect(calls[0].body.messages).toBeUndefined();
  });

  it("sends an openai_compat request in the OpenAI shape", async () => {
    const { calls } = await collect({
      standard: "openai_compat",
      baseUrl: "https://relay.example.com/v1",
      chunks: [`data: [DONE]\n\n`],
    });
    expect(calls[0].url).toBe("https://relay.example.com/v1/chat/completions");
    expect(calls[0].body.messages).toBeDefined();
  });

  it("keys a gemini_compat request off the header, never the URL", async () => {
    const calls: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(String(url)).not.toContain("secret");
        calls.push(new Headers(init.headers));
        return sseResponse([`data: {"candidates":[]}\n\n`]);
      }),
    );
    await streamCompletion({
      baseUrl: "https://relay.example.com/v1beta",
      apiKey: "secret",
      standard: "gemini_compat",
      modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(calls[0].get("x-goog-api-key")).toBe("secret");
  });
});
