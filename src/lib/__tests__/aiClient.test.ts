import { describe, it, expect, vi, afterEach } from "vitest";
import {
  streamCompletion, ContextSizeError,
  type ApiStandard, type AuthMode, type StreamChunk, type StreamMessage, type ToolDefinition,
} from "../ai";
import type { ReasoningEffort, ThinkingDialect } from "../ai/reasoning";
import type { ServerToolId } from "../ai/serverTools";

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
  thinkingDialect?: ThinkingDialect;
  serverTools?: ServerToolId[];
  temperature?: number;
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
    thinkingDialect: opts.thinkingDialect,
    serverTools: opts.serverTools,
    temperature: opts.temperature,
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
  it("separates thought parts from answer text, and reads usageMetadata", async () => {
    const { received } = await collect({
      standard: "gemini",
      chunks: [
        `data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true},{"text":"Hi "}]}}]}\n`,
        `data: {"candidates":[{"content":{"parts":[{"text":"there"}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}\n`,
      ],
    });
    // A thought part must never reach `text` — that variant is what gets
    // inserted into the manuscript.
    expect(text(received)).toBe("Hi there");
    expect(received).toContainEqual({ reasoning: "thinking..." });
    expect(received[received.length - 1]).toEqual({ done: true, inputTokens: 7, outputTokens: 3 });
  });

  it("asks for a thinking level and for the thoughts to come back", async () => {
    // Paired on purpose: a level without includeThoughts pays for reasoning
    // nobody can see.
    const { calls } = await collect({
      standard: "gemini",
      reasoningEffort: "medium",
      chunks: [`data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n`],
    });
    expect((calls[0].body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({
      thinkingLevel: "MEDIUM",
      includeThoughts: true,
    });
  });

  it("maps the app's levels onto Gemini's upper-case enum", async () => {
    for (const [effort, level] of [
      // No way to disable thinking in this family — "off" is the floor.
      ["off", "MINIMAL"], ["low", "LOW"], ["medium", "MEDIUM"],
      // The enum stops at HIGH, so "max" lands there too.
      ["high", "HIGH"], ["max", "HIGH"],
    ] as const) {
      const { calls } = await collect({
        standard: "gemini",
        reasoningEffort: effort,
        chunks: [`data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n`],
      });
      const cfg = (calls[0].body.generationConfig as Record<string, unknown>)
        .thinkingConfig as Record<string, unknown>;
      expect(cfg.thinkingLevel).toBe(level);
    }
  });

  it("sends no thinkingConfig when the model has no level set", async () => {
    const { calls } = await collect({
      standard: "gemini",
      chunks: [`data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n`],
    });
    expect(calls[0].body.generationConfig).toBeUndefined();
  });

  it("merges thinkingConfig into an existing generationConfig", async () => {
    // JSON mode already puts responseMimeType there via extraBody; assigning in
    // either direction would drop the other's field.
    const calls = mockFetch([`data: {"candidates":[{"content":{"parts":[{"text":"{}"}]}}]}\n`]);
    await streamCompletion({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "k",
      standard: "gemini",
      modelId: "gemini-3-pro",
      reasoningEffort: "high",
      extraBody: { generationConfig: { responseMimeType: "application/json" } },
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(calls[0].body.generationConfig).toEqual({
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true },
    });
  });

  it("reports a missing thought signature as the request fault it is", async () => {
    // HTTP 200 with a finishReason — read as a normal short answer unless
    // handled, and it is not a safety filter, so the message must not say so.
    await expect(collect({
      standard: "gemini",
      chunks: [`data: {"candidates":[{"finishReason":"MISSING_THOUGHT_SIGNATURE"}]}\n`],
    })).rejects.toThrow(/thought signature was missing/);
  });

  it("keeps safety refusals and request faults distinct", async () => {
    await expect(collect({
      standard: "gemini",
      chunks: [`data: {"candidates":[{"finishReason":"SAFETY"}]}\n`],
    })).rejects.toThrow(/safety filter/);
    await expect(collect({
      standard: "gemini",
      chunks: [`data: {"candidates":[{"finishReason":"UNEXPECTED_TOOL_CALL"}]}\n`],
    })).rejects.toThrow(/didn't declare/);
  });

  it("spells every Gemini field in camelCase", async () => {
    // Google accepts both spellings; relays fronting it document only camel,
    // and an unrecognised key is ignored rather than rejected — a snake_case
    // `inline_data` means the picture silently never reaches the model.
    const calls = mockFetch([`data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n`]);
    await streamCompletion({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "k",
      standard: "gemini",
      modelId: "gemini-3-pro",
      tools: [{
        type: "function",
        function: { name: "f", description: "d", parameters: { type: "object", properties: {} } },
      }],
      toolChoice: "required",
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          ],
        },
      ],
      onChunk: () => {},
    });
    const body = calls[0].body;
    expect(body).toHaveProperty("systemInstruction");
    expect(body).toHaveProperty("toolConfig");
    expect(JSON.stringify(body)).not.toMatch(/inline_data|system_instruction|tool_config|mime_type/);
    const parts = (body.contents as { parts: Record<string, unknown>[] }[])[0].parts;
    expect(parts[1].inlineData).toEqual({ mimeType: "image/png", data: "AAA" });
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

describe("streamCompletion — switch dialect on the OpenAI family", () => {
  const done = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n', "data: [DONE]\n"];

  it("spells thinking as enable_thinking and keeps reasoning_effort off the wire", async () => {
    // Qwen documents the two fields as mutually exclusive — sending both is
    // exactly the kind of volunteered field this whole layer exists to avoid.
    const { calls } = await collect({
      chunks: done, standard: "openai_compat",
      reasoningEffort: "high", thinkingDialect: "switch",
    });
    expect(calls[0].body.enable_thinking).toBe(true);
    expect(calls[0].body).not.toHaveProperty("reasoning_effort");
  });

  it('"off" is the one level the switch can express', async () => {
    const { calls } = await collect({
      chunks: done, standard: "openai_compat",
      reasoningEffort: "off", thinkingDialect: "switch",
    });
    expect(calls[0].body.enable_thinking).toBe(false);
  });

  it("a default effort still sends nothing, dialect or not", async () => {
    // Declaring the dialect states how thinking *would* be spelled, not that
    // anything should be volunteered — the endpoint's own default stays.
    const { calls } = await collect({
      chunks: done, standard: "openai_compat",
      reasoningEffort: "default", thinkingDialect: "switch",
    });
    expect(calls[0].body).not.toHaveProperty("enable_thinking");
    expect(calls[0].body).not.toHaveProperty("reasoning_effort");
  });
});

describe("streamCompletion — forced tool_choice under the OpenAI switch dialect", () => {
  const done = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n', "data: [DONE]\n"];
  const tool: ToolDefinition = {
    type: "function",
    function: { name: "emit", description: "d", parameters: { type: "object", properties: {} } },
  };
  const forced = { type: "function" as const, function: { name: "emit" } };

  it("downgrades a forced choice to auto while enable_thinking is true", async () => {
    // Qwen documents tool_choice as auto|none only while thinking is on —
    // forcing there is a guaranteed 400, and the one forcing caller
    // (agent/structured.ts) already treats "no call" as its fallback cue.
    const { calls } = await collect({
      chunks: done, standard: "openai_compat", tools: [tool], toolChoice: forced,
      reasoningEffort: "high", thinkingDialect: "switch",
    });
    expect(calls[0].body.tool_choice).toBe("auto");
  });

  it('leaves forcing alone when thinking is explicitly off', async () => {
    const { calls } = await collect({
      chunks: done, standard: "openai_compat", tools: [tool], toolChoice: forced,
      reasoningEffort: "off", thinkingDialect: "switch",
    });
    expect(calls[0].body.tool_choice).toEqual(forced);
  });

  it("leaves forcing alone without the dialect (regression guard)", async () => {
    const { calls } = await collect({
      chunks: done, standard: "openai_compat", tools: [tool], toolChoice: forced,
      reasoningEffort: "high",
    });
    expect(calls[0].body.tool_choice).toEqual(forced);
  });
});

describe("streamCompletion — server tools on the OpenAI-compatible wire", () => {
  const done = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n', "data: [DONE]\n"];

  it("spells web_search as a top-level enable_search on openai_compat", async () => {
    const { calls } = await collect({
      chunks: done, standard: "openai_compat", serverTools: ["web_search"],
    });
    expect(calls[0].body.enable_search).toBe(true);
  });

  it("never sends enable_search to the official endpoint", async () => {
    // api.openai.com rejects unknown top-level arguments outright — the config
    // layer refuses to store the declaration there, and the adapter must hold
    // the line even against a row that travelled in via import.
    const { calls } = await collect({
      chunks: done, standard: "openai", serverTools: ["web_search"],
    });
    expect(calls[0].body).not.toHaveProperty("enable_search");
  });

  it("sends nothing without the declaration", async () => {
    const { calls } = await collect({ chunks: done, standard: "openai_compat" });
    expect(calls[0].body).not.toHaveProperty("enable_search");
  });
});

describe("streamCompletion — file content parts", () => {
  const done = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n', "data: [DONE]\n"];

  it("passes a PDF file part through to the OpenAI wire untouched", async () => {
    const { calls } = await collect({
      chunks: done, standard: "openai_compat",
      messages: [{
        role: "user",
        content: [
          { type: "file", file: { file_data: "data:application/pdf;base64,QUJD", filename: "a.pdf" } },
          { type: "text", text: "总结这份文件" },
        ],
      }],
    });
    const msg = (calls[0].body.messages as Array<{ content: unknown }>)[0];
    expect(msg.content).toEqual([
      { type: "file", file: { file_data: "data:application/pdf;base64,QUJD", filename: "a.pdf" } },
      { type: "text", text: "总结这份文件" },
    ]);
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

  it("keeps a server tool off a protocol that has no such thing", async () => {
    // The setting is Anthropic-only. A model moved to an OpenAI-shaped provider
    // keeps the stored permission, and a `{type:"web_search_20250305"}` entry
    // in an OpenAI tools array is a 400 — the adapter must simply not carry it.
    const { calls } = await collect({
      chunks: [`data: [DONE]\n`],
      standard: "openai",
      serverTools: ["web_search"],
    });
    expect(calls[0].body).not.toHaveProperty("tools");
  });

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

  it("maps a forced tool_choice to Gemini's functionCallingConfig", async () => {
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
    expect(calls[0].body.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["update_lore_metadata"],
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
    expect(calls[0].body.toolConfig).toBeUndefined();
  });
});

describe("streamCompletion — Anthropic prompt caching", () => {
  /**
   * This family caches only where a `cache_control` breakpoint says to, and an
   * agent loop re-sends the same system prompt and toolset on every round. The
   * breakpoints are what stop that from being re-billed at full price.
   */
  const DONE = [
    `data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n`,
    `data: {"type":"message_stop"}\n\n`,
  ];

  const tool = (name: string): ToolDefinition => ({
    type: "function",
    function: { name, description: `does ${name}`, parameters: { type: "object", properties: {} } },
  });

  const SYSTEM: StreamMessage[] = [
    { role: "system", content: "you are a writing assistant" },
    { role: "user", content: "hi" },
  ];

  it("marks the last tool and the system block on the official standard", async () => {
    const { calls } = await collect({
      chunks: DONE,
      standard: "anthropic",
      messages: SYSTEM,
      tools: [tool("a"), tool("b"), tool("c")],
    });
    const body = calls[0].body as {
      tools: Record<string, unknown>[];
      system: Record<string, unknown>[];
    };
    // Prefix caching: one marker on the LAST entry caches everything before it.
    // Marking each tool would spend the four-breakpoint allowance for nothing.
    expect(body.tools[0]).not.toHaveProperty("cache_control");
    expect(body.tools[1]).not.toHaveProperty("cache_control");
    expect(body.tools[2].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system).toEqual([
      { type: "text", text: "you are a writing assistant", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("sends nothing of the sort on a compat endpoint", async () => {
    // Deliberate, not an oversight: MiniMax's ④-family endpoint documents a
    // `system` array with cache_control but nothing about `tools`, and a
    // rejected field costs the author a whole failed round at the start of a
    // stream. Anyone tempted to "just unify these two branches" has to delete
    // this test first — and read docs/agent-tool-context-lld.md §2.3.
    const { calls } = await collect({
      chunks: DONE,
      standard: "anthropic_compat",
      messages: SYSTEM,
      tools: [tool("a")],
    });
    const body = calls[0].body as { tools: unknown[]; system: unknown };
    expect(body.system).toBe("you are a writing assistant");
    expect(body.tools[0]).not.toHaveProperty("cache_control");
  });

  it("leaves a toolless request's tools field absent", async () => {
    const { calls } = await collect({ chunks: DONE, standard: "anthropic", messages: SYSTEM });
    expect(calls[0].body).not.toHaveProperty("tools");
    expect(calls[0].body).toHaveProperty("system");
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
    // stopReason rides along for the API log — diagnostic only, never branched on.
    expect(received[received.length - 1]).toEqual({
      done: true, inputTokens: 10, outputTokens: 5, stopReason: "end_turn",
    });
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
      stopReason: "end_turn",
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
    // A block array rather than a bare string because the official standard
    // carries a cache breakpoint here — see the prompt-caching describe above.
    expect(calls[0].body.system).toEqual([
      { type: "text", text: "be terse", cache_control: { type: "ephemeral" } },
    ]);
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

  it("attributes author text that gets merged into a tool-result message", async () => {
    // A run that dies mid-tool-round leaves the result with no assistant turn
    // after it; whatever the author types next merges into that same user
    // message, and their words end up inside the envelope the model reads as
    // tool output. Observed: three retries typed across a morning of broken
    // runs were re-sent on all 39 rounds of the next one and spent as a
    // standing "keep going".
    const { calls } = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      messages: [
        { role: "user", content: "看看文件" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "t1", content: "文件内容" },
        { role: "user", content: "continue" },
        { role: "user", content: "重试" },
      ],
    });
    const last = (calls[0].body.messages as { role: string; content: { type: string; text?: string }[] }[])[2];
    expect(last.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "文件内容" },
      { type: "text", text: "【作者消息】\ncontinue" },
      { type: "text", text: "【作者消息】\n重试" },
    ]);
  });

  it("leaves an ordinary pair of user turns unlabelled", async () => {
    // The label is for text stranded among tool results. Two consecutive author
    // turns merge exactly as they always did.
    const { calls } = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      messages: [
        { role: "user", content: "one" },
        { role: "user", content: "two" },
      ],
    });
    expect((calls[0].body.messages as { content: unknown }[])[0].content).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
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

  // ── The `switch` dialect: MiniMax-M3's Messages endpoint ──────────────────
  // Its documented request schema is a subset of Anthropic's, and every test
  // here pins one thing this app must NOT send there. See docs/api/landscape.md
  // §7 第四个样本.

  it("sends the bare on/off switch, with no display field", async () => {
    const { calls } = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      thinkingDialect: "switch",
    });
    // Explicit, because thinking defaults to *off* there — omitting the field
    // is how you get a model that never thinks.
    expect(calls[0].body.thinking).toEqual({ type: "adaptive" });
  });

  it("spends the effort setting on the switch, and sends no output_config", async () => {
    const on = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      thinkingDialect: "switch",
      reasoningEffort: "high",
    });
    // There is no depth dial on this endpoint, so a level has nowhere to go.
    expect(on.calls[0].body).not.toHaveProperty("output_config");
    expect(on.calls[0].body.thinking).toEqual({ type: "adaptive" });

    const off = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      thinkingDialect: "switch",
      reasoningEffort: "off",
    });
    // "off" is honoured literally here, unlike on the official endpoint where it
    // maps to the lowest effort — this switch is the only control there is.
    expect(off.calls[0].body.thinking).toEqual({ type: "disabled" });
    expect(off.calls[0].body).not.toHaveProperty("output_config");
  });

  it("downgrades a forced tool choice to auto on the switch dialect", async () => {
    // `any` / `{type:"tool"}` are a 400 there. Structured callers already treat
    // "the model didn't call it" as their cue to fall back to JSON mode, so
    // downgrading costs one fallback at worst; sending it costs a dead request
    // *and* the same fallback.
    const named = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      thinkingDialect: "switch",
      tools: [TOOL],
      toolChoice: { type: "function", function: { name: "get_weather" } },
    });
    expect(named.calls[0].body.tool_choice).toEqual({ type: "auto" });

    const required = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      thinkingDialect: "switch",
      tools: [TOOL],
      toolChoice: "required",
    });
    expect(required.calls[0].body.tool_choice).toEqual({ type: "auto" });

    // "none" survives: it is in the endpoint's enum, and it means the opposite
    // of forcing — downgrading it would hand the model a tool it was told not
    // to use.
    const none = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      thinkingDialect: "switch",
      tools: [TOOL],
      toolChoice: "none",
    });
    expect(none.calls[0].body.tool_choice).toEqual({ type: "none" });
  });

  // ── Server-side tools ─────────────────────────────────────────────────────

  it("declares a server tool by its versioned wire type", async () => {
    const { calls } = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      serverTools: ["web_search"],
    });
    // max_uses is the only brake on a tool that runs without asking and bills
    // per search — see MAX_SEARCHES_PER_REQUEST.
    expect(calls[0].body.tools).toEqual([
      // The cache breakpoint rides on the last entry whatever kind it is.
      { type: "web_search_20250305", name: "web_search", max_uses: 10, cache_control: { type: "ephemeral" } },
    ]);
    // Nothing of ours to choose between — the endpoint decides whether to run
    // its own tool, and an opinion here would be about a decision we don't make.
    expect(calls[0].body).not.toHaveProperty("tool_choice");
  });

  it("puts server tools and our own in one array", async () => {
    const { calls } = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      serverTools: ["web_search"],
      tools: [TOOL],
    });
    expect(calls[0].body.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 10 },
      {
        name: "get_weather",
        description: "Get the weather",
        input_schema: TOOL.function.parameters,
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(calls[0].body.tool_choice).toEqual({ type: "auto" });
  });

  it("reports a server-run search as activity, never as a tool call", async () => {
    const { received } = await collect({
      ...ANTHROPIC,
      chunks: [
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"上海天气\\"}"}}\n\n`,
        `data: {"type":"content_block_stop","index":0}\n\n`,
        `data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","title":"上海天气预报","url":"https://example.com/sh","page_age":"1 day ago"}]}}\n\n`,
        `data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"今天多云。"}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
    });
    expect(received).toContainEqual({
      serverTool: { phase: "call", id: "srvtoolu_1", name: "web_search", input: { query: "上海天气" } },
    });
    expect(received).toContainEqual({
      serverTool: {
        phase: "result",
        id: "srvtoolu_1",
        name: "web_search",
        results: [{ title: "上海天气预报", url: "https://example.com/sh", pageAge: "1 day ago" }],
      },
    });
    // The search is already done: surfacing it as a tool call would have the
    // agent loop answer it with a tool_result the endpoint never asked for.
    expect(received.some((c) => "toolCalls" in c)).toBe(false);
    expect(text(received)).toBe("今天多云。");
  });

  // ── pause_turn: the stop reason that is not an ending ─────────────────────

  it("hands a paused turn back and streams the continuation as one answer", async () => {
    // The bug this pins: a long search turn ends with `pause_turn`, the model
    // has written only its opening line, and a client that treats that as an
    // ending shows the intro and nothing else — no error anywhere.
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sseResponse(
          call++ === 0
            ? [
                `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
                `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我去搜一下。"}}\n\n`,
                `data: {"type":"content_block_stop","index":0}\n\n`,
                `data: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"天气"}}}\n\n`,
                `data: {"type":"content_block_stop","index":1}\n\n`,
                `data: {"type":"content_block_start","index":2,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","title":"天气","url":"https://e.com","encrypted_content":"EQ0PAAAA"}]}}\n\n`,
                `data: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":30}}\n\n`,
                `data: {"type":"message_stop"}\n\n`,
              ]
            : [
                `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"今天多云。"}}\n\n`,
                `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n`,
                `data: {"type":"message_stop"}\n\n`,
              ],
        );
      }),
    );

    const received: StreamChunk[] = [];
    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      standard: "anthropic",
      modelId: "m",
      serverTools: ["web_search"],
      messages: [{ role: "user", content: "天气?" }],
      onChunk: (c) => received.push(c),
    });

    expect(bodies).toHaveLength(2);
    // The paused turn goes back as an assistant message, blocks verbatim and in
    // order — including `encrypted_content`, which the endpoint decrypts to
    // restore its own state. Rebuilding the block would strip exactly that.
    const resumed = bodies[1].messages as { role: string; content: Record<string, unknown>[] }[];
    expect(resumed[0]).toEqual({ role: "user", content: [{ type: "text", text: "天气?" }] });
    expect(resumed[1].role).toBe("assistant");
    expect(resumed[1].content).toEqual([
      { type: "text", text: "我去搜一下。" },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "天气" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          {
            type: "web_search_result",
            title: "天气",
            url: "https://e.com",
            encrypted_content: "EQ0PAAAA",
          },
        ],
      },
    ]);

    // The caller sees one continuous answer and one `done`, with the usage of
    // both requests summed — the split is the endpoint's business, not theirs.
    expect(text(received)).toBe("我去搜一下。今天多云。");
    const done = received.filter((c) => "done" in c);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ outputTokens: 42, stopReason: "end_turn" });
  });

  it("resumes a turn that stopped on its search results reporting end_turn", async () => {
    // Reproduces a real MiniMax-M3 response: an opening line, eight searches,
    // then `stop_reason: "end_turn"` with nothing after the results. The
    // endpoint delivered the results but never re-invoked the model, so the
    // answer the model promised was never written — and the response is a
    // well-formed success, which is why nothing anywhere reported a problem.
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sseResponse(
          call++ === 0
            ? [
                `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
                `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好的，我来搜索这些术语。"}}\n\n`,
                `data: {"type":"content_block_stop","index":0}\n\n`,
                `data: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"MACD"}}}\n\n`,
                `data: {"type":"content_block_stop","index":1}\n\n`,
                `data: {"type":"content_block_start","index":2,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","title":"MACD","url":"https://e.com","content":"MACD 是异同移动平均线，由 DIF 与 DEA 构成。"}]}}\n\n`,
                `data: {"type":"content_block_stop","index":2}\n\n`,
                `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":784}}\n\n`,
                `data: {"type":"message_stop"}\n\n`,
              ]
            : [
                `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
                `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"MACD 是异同移动平均线。"}}\n\n`,
                `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":40}}\n\n`,
                `data: {"type":"message_stop"}\n\n`,
              ],
        );
      }),
    );

    const received: StreamChunk[] = [];
    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      standard: "anthropic",
      modelId: "MiniMax-M3",
      thinkingDialect: "switch",
      serverTools: ["web_search"],
      messages: [{ role: "user", content: "这些术语什么意思?" }],
      onChunk: (c) => received.push(c),
    });

    expect(bodies).toHaveLength(2);
    const resumed = bodies[1].messages as { role: string; content: { type: string; text: string }[] }[];

    // Nothing server-tool-shaped goes back. This endpoint answers its own
    // blocks with `invalid params, tool result's tool id(...) not found` — its
    // request validator reads any *_tool_result as a client tool's result and
    // looks for a matching client tool_use, which a server tool never has.
    const wire = JSON.stringify(resumed);
    expect(wire).not.toContain("server_tool_use");
    expect(wire).not.toContain("tool_result");

    // Instead: the model's own opening line, then the findings as plain text —
    // a message shape no validator can object to. The page extract is carried,
    // not just the title: on an endpoint that stops here, this is the only copy
    // of what was found.
    expect(resumed).toHaveLength(3);
    expect(resumed[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "好的，我来搜索这些术语。" }],
    });
    expect(resumed[2].role).toBe("user");
    expect(resumed[2].content[0].text).toContain("MACD"); // the query
    expect(resumed[2].content[0].text).toContain("https://e.com");
    expect(resumed[2].content[0].text).toContain("DIF 与 DEA");

    expect(text(received)).toBe("好的，我来搜索这些术语。MACD 是异同移动平均线。");
  });

  it("does not resume when the searches came back empty", async () => {
    // Nothing to hand over — resuming would ask the model to answer from the
    // same nothing, one more billed request later.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return sseResponse([
          `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"s1","name":"web_search","input":{"query":"q"}}}\n\n`,
          `data: {"type":"content_block_stop","index":0}\n\n`,
          `data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"s1","content":[]}}\n\n`,
          `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n`,
          `data: {"type":"message_stop"}\n\n`,
        ]);
      }),
    );

    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      standard: "anthropic",
      modelId: "m",
      serverTools: ["web_search"],
      messages: [{ role: "user", content: "q" }],
      onChunk: () => {},
    });

    expect(calls).toBe(1);
  });

  it("leaves a finished turn alone even when it ends on a search", async () => {
    // The narrow half of the rule above: the model *did* answer after its
    // search, so there is nothing to resume — resending here would bill a
    // second request to re-derive an answer already in hand.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return sseResponse([
          `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"s1","name":"web_search","input":{"query":"q"}}}\n\n`,
          `data: {"type":"content_block_stop","index":0}\n\n`,
          `data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"s1","content":[]}}\n\n`,
          `data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n`,
          `data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"答案在此。"}}\n\n`,
          `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n`,
          `data: {"type":"message_stop"}\n\n`,
        ]);
      }),
    );

    const received: StreamChunk[] = [];
    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      standard: "anthropic",
      modelId: "m",
      serverTools: ["web_search"],
      messages: [{ role: "user", content: "q" }],
      onChunk: (c) => received.push(c),
    });

    expect(calls).toBe(1);
    expect(text(received)).toBe("答案在此。");
  });

  it("stops resuming at the continuation cap instead of looping forever", async () => {
    // An endpoint that pauses every time must not be able to bill indefinitely
    // for one visible answer.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return sseResponse([
          `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"…"}}\n\n`,
          `data: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":1}}\n\n`,
          `data: {"type":"message_stop"}\n\n`,
        ]);
      }),
    );

    const received: StreamChunk[] = [];
    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      standard: "anthropic",
      modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      onChunk: (c) => received.push(c),
    });

    expect(calls).toBe(5); // the first request plus MAX_PAUSE_CONTINUATIONS
    // Reported honestly rather than as a success: the turn stopped where it
    // stood, and the log says which stop reason got it there.
    expect(received[received.length - 1]).toMatchObject({ done: true, stopReason: "pause_turn" });
    // Every leg is announced, and exactly one is marked final — the leg whose
    // instruction forbids further searching.
    const legs = received.filter((c): c is { turnResumed: { leg: number; final: boolean } } =>
      "turnResumed" in c,
    );
    expect(legs.map((c) => c.turnResumed.leg)).toEqual([2, 3, 4, 5]);
    expect(legs.filter((c) => c.turnResumed.final)).toHaveLength(1);
    expect(legs[legs.length - 1].turnResumed.final).toBe(true);
  });

  it("forbids more searching on the last leg instead of letting it announce again", async () => {
    // The failure this pins is a model that spends every leg saying what it
    // will search next and never writes anything: three requests, 16 searches,
    // 69 characters of output, all of it announcements. A leg that knows it is
    // the last is told to produce the content it has.
    const prompts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          messages: { role: string; content: { text?: string }[] }[];
        };
        const last = body.messages[body.messages.length - 1];
        if (last.role === "user") prompts.push(last.content.map((p) => p.text ?? "").join(""));
        return sseResponse([
          `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"s","name":"web_search","input":{"query":"下一批"}}}\n\n`,
          `data: {"type":"content_block_stop","index":0}\n\n`,
          `data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"s","content":[{"type":"web_search_result","title":"t","url":"https://e.com","content":"正文"}]}}\n\n`,
          `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`,
          `data: {"type":"message_stop"}\n\n`,
        ]);
      }),
    );

    await streamCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      standard: "anthropic",
      modelId: "m",
      serverTools: ["web_search"],
      messages: [{ role: "user", content: "查一批术语" }],
      onChunk: () => {},
    });

    // prompts[0] is the author's own turn; the rest are resume instructions.
    const resumes = prompts.slice(1);
    expect(resumes).toHaveLength(4);
    expect(resumes[resumes.length - 1]).toContain("不要再发起任何检索");
    // Only the last one says that — the earlier legs may still search, so long
    // as they write the batch they already have first.
    expect(resumes.slice(0, -1).some((p) => p.includes("不要再发起任何检索"))).toBe(false);
    expect(resumes[0]).toContain("现在就把这一批的正文写出来");
  });

  it("still reports the query when a search is cut off mid-flight", async () => {
    const { received } = await collect({
      ...ANTHROPIC,
      chunks: [
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_2","name":"web_search","input":{}}}\n\n`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"半路断了\\"}"}}\n\n`,
      ],
    });
    expect(received).toContainEqual({
      serverTool: { phase: "call", id: "srvtoolu_2", name: "web_search", input: { query: "半路断了" } },
    });
  });

  it("reports a failed search as an error rather than as empty results", async () => {
    const { received } = await collect({
      ...ANTHROPIC,
      chunks: [
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_3","name":"web_search","input":{"query":"x"}}}\n\n`,
        `data: {"type":"content_block_stop","index":0}\n\n`,
        `data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_3","content":{"type":"web_search_tool_result_error","error_code":"max_uses_exceeded"}}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ],
    });
    expect(received).toContainEqual({
      serverTool: {
        phase: "result",
        id: "srvtoolu_3",
        name: "web_search",
        results: [],
        error: "max_uses_exceeded",
      },
    });
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
        cache_control: { type: "ephemeral" },
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

describe("streamCompletion — temperature", () => {
  const OPENAI_DONE = [`data: [DONE]\n\n`];
  const GEMINI_ONE = [`data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n`];
  const ANTHROPIC_ONE = [
    `data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n`,
    `data: {"type":"message_stop"}\n\n`,
  ];

  it("sends nothing when unset, on every family", async () => {
    for (const [standard, chunks] of [
      ["openai", OPENAI_DONE], ["gemini", GEMINI_ONE], ["anthropic", ANTHROPIC_ONE],
    ] as const) {
      const { calls } = await collect({ standard, chunks });
      expect(calls[0].body.temperature).toBeUndefined();
      expect((calls[0].body.generationConfig as Record<string, unknown> | undefined)?.temperature)
        .toBeUndefined();
      vi.unstubAllGlobals();
    }
  });

  it("sends 0 rather than treating it as unset", async () => {
    // The bug this guards: `opts.temperature ? {temperature} : {}` drops the one
    // value an author picks precisely because they mean it.
    const { calls } = await collect({ chunks: OPENAI_DONE, temperature: 0 });
    expect(calls[0].body.temperature).toBe(0);
  });

  it("puts it in generationConfig on Gemini, beside the thinking config", async () => {
    const { calls } = await collect({
      standard: "gemini", chunks: GEMINI_ONE, temperature: 0.3, reasoningEffort: "medium",
    });
    const cfg = calls[0].body.generationConfig as Record<string, unknown>;
    expect(cfg.temperature).toBe(0.3);
    // The one-level merge must not have clobbered either writer.
    expect(cfg.thinkingConfig).toBeDefined();
  });

  it("clamps to 1 on a non-thinking Anthropic request — a lower ceiling than the other families'", async () => {
    const { calls } = await collect({
      standard: "anthropic", chunks: ANTHROPIC_ONE, temperature: 1.8, thinkingDialect: "none",
    });
    expect(calls[0].body.thinking).toBeUndefined();
    expect(calls[0].body.temperature).toBe(1);
  });

  it("omits it on an Anthropic thinking request rather than clamping it to 1", async () => {
    // The API accepts only temperature 1 while thinking is on, so a clamp would
    // send the opposite of what the author asked for and call it honoring them.
    //
    // Note which request this is: `defaultDialect` makes Anthropic *adaptive*
    // unless the author declares otherwise, so this — not the case above — is
    // what an ordinary Claude model sends, and the setting is inert there by
    // protocol rather than by oversight. The model editor's hint says so.
    const { calls } = await collect({
      standard: "anthropic", chunks: ANTHROPIC_ONE, temperature: 0.2,
    });
    expect(calls[0].body.thinking).toBeDefined();
    expect(calls[0].body.temperature).toBeUndefined();
  });
});
