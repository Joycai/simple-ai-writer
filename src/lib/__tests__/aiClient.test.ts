import { describe, it, expect, vi, afterEach } from "vitest";
import {
  streamCompletion, ContextSizeError,
  type StreamChunk, type StreamMessage, type ToolDefinition,
} from "../aiClient";

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
  standard?: "openai" | "gemini";
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
