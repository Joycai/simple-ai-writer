import { describe, it, expect, vi, afterEach } from "vitest";
import {
  streamCompletion, ContextSizeError,
  type StreamChunk, type StreamMessage, type ToolDefinition,
} from "../ai";

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
  standard?: "openai" | "openai_compat" | "gemini" | "anthropic";
  maxOutput?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  messages?: StreamMessage[];
  prefix?: string;
}): Promise<{ received: StreamChunk[]; calls: { url: string; body: Record<string, unknown> }[] }> {
  const calls = mockFetch(opts.chunks);
  const received: StreamChunk[] = [];
  await streamCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "test-key",
    standard: opts.standard ?? "openai",
    modelId: "test-model",
    messages: opts.messages ?? [{ role: "user", content: "hi" }],
    prefix: opts.prefix,
    maxOutput: opts.maxOutput,
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
    expect(without.calls[0].body.max_tokens).toBe(8192);
  });

  it("maps toolChoice and disables thinking only when a tool is forced", async () => {
    const auto = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      tools: [TOOL],
    });
    expect(auto.calls[0].body.tool_choice).toEqual({ type: "auto" });
    // Adaptive thinking left alone — that's what the agent loop wants.
    expect(auto.calls[0].body.thinking).toBeUndefined();

    const forced = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      tools: [TOOL],
      toolChoice: { type: "function", function: { name: "get_weather" } },
    });
    expect(forced.calls[0].body.tool_choice).toEqual({ type: "tool", name: "get_weather" });
    // Extended thinking is incompatible with a forced tool choice, and every
    // structured task forces one — see thinkingFor in ai/anthropic.ts.
    expect(forced.calls[0].body.thinking).toEqual({ type: "disabled" });

    const required = await collect({
      ...ANTHROPIC,
      chunks: [`data: {"type":"message_stop"}\n\n`],
      tools: [TOOL],
      toolChoice: "required",
    });
    expect(required.calls[0].body.tool_choice).toEqual({ type: "any" });
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
