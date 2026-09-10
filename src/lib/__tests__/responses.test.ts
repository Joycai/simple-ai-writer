/**
 * The OpenAI Responses adapter (lib/ai/responses.ts) — slice D of
 * docs/api/qianwen-compat-plan.md §4.4: text streaming, the request shape,
 * and the four ways a stream ends. Event fixtures follow the measured
 * sequences in docs/api/responses.md §4.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { streamCompletion, type StreamChunk, type StreamMessage } from "../ai";
import type { ReasoningEffort, ThinkingCategoryId } from "../ai/reasoning";
import { toResponsesInput } from "../ai/responses";

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

function mockFetch(chunks: string[], status = 200) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return sseResponse(chunks, status);
    }),
  );
  return calls;
}

/** One SSE event the way the endpoint writes it: `event:` line, `data:` line, blank. */
const ev = (type: string, payload: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: 0, ...payload })}\n\n`;

const COMPLETED = ev("response.completed", {
  response: {
    status: "completed",
    usage: {
      input_tokens: 63,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
      output_tokens: 34,
      output_tokens_details: { reasoning_tokens: 10 },
      total_tokens: 97,
    },
  },
});

async function collect(opts: {
  chunks: string[];
  status?: number;
  messages?: StreamMessage[];
  standard?: "openai_responses" | "openai_responses_compat";
  temperature?: number;
  extraBody?: Record<string, unknown>;
}) {
  const calls = mockFetch(opts.chunks, opts.status);
  const received: StreamChunk[] = [];
  await streamCompletion({
    baseUrl: "https://relay.example.com/v1",
    apiKey: "k",
    standard: opts.standard ?? "openai_responses",
    modelId: "gpt-5.5",
    messages: opts.messages ?? [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ],
    temperature: opts.temperature,
    extraBody: opts.extraBody,
    onChunk: (c) => received.push(c),
  });
  return { received, calls };
}

const text = (received: StreamChunk[]) =>
  received.filter((c): c is { text: string } => "text" in c).map((c) => c.text).join("");
const doneOf = (received: StreamChunk[]) =>
  received.find((c) => "done" in c) as Extract<StreamChunk, { done: true }>;

afterEach(() => vi.unstubAllGlobals());

describe("Responses adapter — request shape", () => {
  it("posts to /responses under the OpenAI base with instructions, input items, store:false", async () => {
    const { calls } = await collect({ chunks: [COMPLETED] });
    expect(calls[0].url).toBe("https://relay.example.com/v1/responses");
    const body = calls[0].body;
    expect(body.model).toBe("gpt-5.5");
    expect(body.instructions).toBe("be brief");
    expect(body.input).toEqual([{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    // Chat Completions vocabulary must not leak onto this wire.
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("stream_options");
  });

  it("always sends `instructions`, even with no system message", async () => {
    // A relay that finds it absent injects its own system prompt (landscape.md
    // §7 第八个样本: 4.4K–7.5K tokens of Codex instructions per request).
    const { calls } = await collect({
      chunks: [COMPLETED],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(calls[0].body).toHaveProperty("instructions", "");
  });

  it("joins several system messages into one instructions string, in order", () => {
    const { instructions, input } = toResponsesInput([
      { role: "system", content: "one" },
      { role: "user", content: "hi" },
      { role: "system", content: [{ type: "text", text: "two" }] },
    ]);
    expect(instructions).toBe("one\n\ntwo");
    expect(input).toEqual([{ role: "user", content: "hi" }]);
  });

  it("sends tools flat with an explicit strict:false, and no tools key without them", async () => {
    const without = mockFetch([COMPLETED]);
    await streamCompletion({
      baseUrl: "", apiKey: "k", standard: "openai_responses", modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(without[0].url).toBe("https://api.openai.com/v1/responses");
    expect(without[0].body).not.toHaveProperty("tools");
    expect(without[0].body).not.toHaveProperty("tool_choice");

    const params = { type: "object", properties: { path: { type: "string" } } };
    const calls = mockFetch([COMPLETED]);
    await streamCompletion({
      baseUrl: "", apiKey: "k", standard: "openai_responses", modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: params } }],
      onChunk: () => {},
    });
    // Flat, not the Chat Completions `function: {…}` wrapper — and strict
    // spelled out, because omitting it means "strict: true" on this wire
    // (docs/api/responses.md §2.3) and every registry schema is non-strict.
    expect(calls[0].body.tools).toEqual([
      { type: "function", name: "read_file", description: "Read", parameters: params, strict: false },
    ]);
    expect(calls[0].body.tool_choice).toBe("auto");
  });

  it("spells a named tool_choice without the function wrapper, and passes the strings through", async () => {
    const named = mockFetch([COMPLETED]);
    await streamCompletion({
      baseUrl: "", apiKey: "k", standard: "openai_responses", modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", description: "", parameters: {} } }],
      toolChoice: { type: "function", function: { name: "f" } },
      onChunk: () => {},
    });
    expect(named[0].body.tool_choice).toEqual({ type: "function", name: "f" });

    const required = mockFetch([COMPLETED]);
    await streamCompletion({
      baseUrl: "", apiKey: "k", standard: "openai_responses", modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", description: "", parameters: {} } }],
      toolChoice: "required",
      onChunk: () => {},
    });
    expect(required[0].body.tool_choice).toBe("required");
  });

  it("carries temperature only when set, and lets extraBody win last", async () => {
    const unset = await collect({ chunks: [COMPLETED] });
    expect(unset.calls[0].body).not.toHaveProperty("temperature");
    const set = await collect({ chunks: [COMPLETED], temperature: 0, extraBody: { store: true } });
    expect(set.calls[0].body.temperature).toBe(0);
    expect(set.calls[0].body.store).toBe(true);
  });

  it("spells user parts as input_text / input_image / input_file", () => {
    const { input } = toResponsesInput([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "file", file: { file_data: "data:application/pdf;base64,BBBB", filename: "a.pdf" } },
        ],
      },
    ]);
    expect(input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,BBBB" },
        ],
      },
    ]);
  });

  it("crosses a tool round from another provider over as bare function_call / function_call_output items", () => {
    const { input } = toResponsesInput([
      { role: "user", content: "read it" },
      {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.md"}' } }],
        _reasoning: { field: "reasoning_content", text: "thinking…" },
      },
      { role: "tool", tool_call_id: "call_1", content: "# a" },
      { role: "assistant", content: "done" },
    ]);
    expect(input).toEqual([
      { role: "user", content: "read it" },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.md"}' },
      { type: "function_call_output", call_id: "call_1", output: "# a" },
      { role: "assistant", content: "done" },
    ]);
    // The `_`-prefixed carriers never reach the wire.
    expect(JSON.stringify(input)).not.toContain("reasoning_content");
  });
});

describe("Responses adapter — stream", () => {
  it("turns output_text deltas into text and reads usage off response.completed", async () => {
    const { received } = await collect({
      chunks: [
        ev("response.created", { response: { status: "in_progress" } }),
        ev("response.output_item.added", { item: { type: "message", phase: "final_answer", content: [] } }),
        ev("response.output_text.delta", { delta: "Hel", obfuscation: "x9Qz" }),
        ev("response.output_text.delta", { delta: "lo", obfuscation: "" }),
        ev("response.output_text.done", { text: "Hello" }),
        COMPLETED,
      ],
    });
    expect(text(received)).toBe("Hello");
    expect(doneOf(received)).toEqual({
      done: true, inputTokens: 63, outputTokens: 34, cachedTokens: 40, stopReason: "completed",
    });
    // Exactly one done, and it is last.
    expect(received.filter((c) => "done" in c)).toHaveLength(1);
    expect(received[received.length - 1]).toHaveProperty("done");
  });

  it("does not let the obfuscation padding into the text", async () => {
    const { received } = await collect({
      chunks: [ev("response.output_text.delta", { delta: "a", obfuscation: "PADPADPAD" }), COMPLETED],
    });
    expect(text(received)).toBe("a");
  });

  it("reassembles an event split across network chunks", async () => {
    const whole = ev("response.output_text.delta", { delta: "whole" }) + COMPLETED;
    const { received } = await collect({ chunks: [whole.slice(0, 30), whole.slice(30)] });
    expect(text(received)).toBe("whole");
  });

  it("streams reasoning summary deltas as {reasoning}, never as text", async () => {
    const { received } = await collect({
      chunks: [
        ev("response.reasoning_summary_text.delta", { delta: "planning" }),
        ev("response.output_text.delta", { delta: "answer" }),
        COMPLETED,
      ],
    });
    expect(text(received)).toBe("answer");
    expect(received.filter((c) => "reasoning" in c)).toEqual([{ reasoning: "planning" }]);
  });

  it("marks response.incomplete on max_output_tokens as truncated", async () => {
    const { received } = await collect({
      chunks: [
        ev("response.output_text.delta", { delta: "cut" }),
        ev("response.incomplete", {
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 5, output_tokens: 16 },
          },
        }),
      ],
    });
    expect(text(received)).toBe("cut");
    expect(doneOf(received)).toEqual({
      done: true, inputTokens: 5, outputTokens: 16, truncated: true, stopReason: "max_output_tokens",
    });
  });

  it("rejects on response.failed instead of completing silently", async () => {
    await expect(
      collect({
        chunks: [ev("response.failed", { response: { status: "failed", error: { code: "server_error", message: "upstream died" } } })],
      }),
    ).rejects.toThrow(/upstream died/);
  });

  it("rejects on the protocol's own error event", async () => {
    await expect(
      collect({ chunks: [ev("error", { code: "rate_limit_exceeded", message: "slow down" })] }),
    ).rejects.toThrow(/slow down/);
  });

  it("rejects on a relay's bare error object delivered under HTTP 200", async () => {
    await expect(
      collect({ chunks: [`data: {"error":{"message":"insufficient balance"}}\n\n`] }),
    ).rejects.toThrow(/insufficient balance/);
  });

  it("throws on a non-2xx with the URL and body in the message", async () => {
    await expect(
      collect({ chunks: [`{"error":{"message":"Unsupported value: 'max'"}}`], status: 400 }),
    ).rejects.toThrow(/400 \(https:\/\/relay.example.com\/v1\/responses\).*Unsupported value/);
  });

  it("emits done even when the stream ends without a terminal event", async () => {
    const { received } = await collect({
      chunks: [ev("response.output_text.delta", { delta: "tail" })],
    });
    expect(text(received)).toBe("tail");
    expect(doneOf(received)).toEqual({ done: true, inputTokens: 0, outputTokens: 0 });
  });

  it("dispatches the compat half to the same adapter", async () => {
    const { calls, received } = await collect({
      standard: "openai_responses_compat",
      chunks: [ev("response.output_text.delta", { delta: "ok" }), COMPLETED],
    });
    expect(calls[0].url).toBe("https://relay.example.com/v1/responses");
    expect(text(received)).toBe("ok");
  });
});

/** The measured tool-round sequence, docs/api/responses.md §4. */
const REASONING_ITEM = {
  id: "rs_1", type: "reasoning",
  summary: [{ type: "summary_text", text: "I should read the file." }],
  encrypted_content: "gAAAAABo…opaque…",
};
const CALL_ITEM = {
  id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file",
  arguments: '{"path":"a.md"}', status: "completed",
};
const TOOL_ROUND = [
  ev("response.output_item.added", { output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } }),
  ev("response.reasoning_summary_text.delta", { output_index: 0, delta: "I should read the file." }),
  ev("response.output_item.done", { output_index: 0, item: REASONING_ITEM }),
  ev("response.output_item.added", { output_index: 1, item: { ...CALL_ITEM, arguments: "", status: "in_progress" } }),
  ev("response.function_call_arguments.delta", { output_index: 1, delta: '{"pa' }),
  ev("response.function_call_arguments.delta", { output_index: 1, delta: 'th":"a.md"}' }),
  ev("response.function_call_arguments.done", { output_index: 1, arguments: '{"path":"a.md"}' }),
  ev("response.output_item.done", { output_index: 1, item: CALL_ITEM }),
  COMPLETED,
];

const TOOL = { type: "function" as const, function: { name: "read_file", description: "", parameters: {} } };

describe("Responses adapter — tool calls", () => {
  it("assembles a function call from the fragments and hands the turn's items back verbatim", async () => {
    const calls = mockFetch(TOOL_ROUND);
    const received: StreamChunk[] = [];
    await streamCompletion({
      baseUrl: "", apiKey: "k", standard: "openai_responses", modelId: "gpt-5.5",
      messages: [{ role: "user", content: "read a.md" }],
      tools: [TOOL],
      onChunk: (c) => received.push(c),
    });
    expect(calls).toHaveLength(1);
    const chunk = received.find((c) => "toolCalls" in c) as Extract<StreamChunk, { toolCalls: unknown }>;
    expect(chunk.toolCalls).toEqual([
      { index: 1, id: "call_1", name: "read_file", arguments: '{"path":"a.md"}' },
    ]);
    // The echo: both items, in order, untouched — encrypted_content included.
    expect(chunk._responseItems).toEqual({ modelId: "gpt-5.5", items: [REASONING_ITEM, CALL_ITEM] });
    // Summary streamed for display, nothing of it in the text.
    expect(received.filter((c) => "reasoning" in c)).toEqual([{ reasoning: "I should read the file." }]);
    expect(text(received)).toBe("");
    // Contract: the tool-call chunk precedes the one done.
    const order = received.map((c) => ("toolCalls" in c ? "calls" : "done" in c ? "done" : "other"));
    expect(order.indexOf("calls")).toBeLessThan(order.indexOf("done"));
    expect(order.filter((o) => o === "done")).toHaveLength(1);
  });

  it("yields a complete call when only the whole item arrives (no argument deltas)", async () => {
    const received: StreamChunk[] = [];
    mockFetch([
      ev("response.output_item.added", { output_index: 0, item: { type: "function_call", call_id: "call_9", name: "f", arguments: "" } }),
      ev("response.output_item.done", { output_index: 0, item: { type: "function_call", call_id: "call_9", name: "f", arguments: '{"x":1}', status: "completed" } }),
      COMPLETED,
    ]);
    await streamCompletion({
      baseUrl: "", apiKey: "k", standard: "openai_responses", modelId: "m",
      messages: [{ role: "user", content: "hi" }], tools: [TOOL],
      onChunk: (c) => received.push(c),
    });
    const chunk = received.find((c) => "toolCalls" in c) as Extract<StreamChunk, { toolCalls: unknown }>;
    expect(chunk.toolCalls).toEqual([{ index: 0, id: "call_9", name: "f", arguments: '{"x":1}' }]);
  });

  it("yields a complete call from deltas alone when the endpoint never sends the whole item", async () => {
    const received: StreamChunk[] = [];
    mockFetch([
      ev("response.output_item.added", { output_index: 0, item: { type: "function_call", call_id: "call_2", name: "f", arguments: "" } }),
      ev("response.function_call_arguments.delta", { output_index: 0, delta: '{"x":' }),
      ev("response.function_call_arguments.delta", { output_index: 0, delta: "2}" }),
      COMPLETED,
    ]);
    await streamCompletion({
      baseUrl: "", apiKey: "k", standard: "openai_responses", modelId: "m",
      messages: [{ role: "user", content: "hi" }], tools: [TOOL],
      onChunk: (c) => received.push(c),
    });
    const chunk = received.find((c) => "toolCalls" in c) as Extract<StreamChunk, { toolCalls: unknown }>;
    expect(chunk.toolCalls).toEqual([{ index: 0, id: "call_2", name: "f", arguments: '{"x":2}' }]);
  });

  it("orders parallel calls by output_index and reports one echo for the round", async () => {
    const received: StreamChunk[] = [];
    const a = { type: "function_call", call_id: "call_a", name: "f", arguments: "{}", status: "completed" };
    const b = { type: "function_call", call_id: "call_b", name: "g", arguments: "{}", status: "completed" };
    mockFetch([
      ev("response.output_item.added", { output_index: 1, item: { ...b, arguments: "" } }),
      ev("response.output_item.added", { output_index: 0, item: { ...a, arguments: "" } }),
      ev("response.output_item.done", { output_index: 1, item: b }),
      ev("response.output_item.done", { output_index: 0, item: a }),
      COMPLETED,
    ]);
    await streamCompletion({
      baseUrl: "", apiKey: "k", standard: "openai_responses", modelId: "m",
      messages: [{ role: "user", content: "hi" }], tools: [TOOL],
      onChunk: (c) => received.push(c),
    });
    const chunk = received.find((c) => "toolCalls" in c) as Extract<StreamChunk, { toolCalls: unknown }>;
    expect(chunk.toolCalls.map((c) => c.id)).toEqual(["call_a", "call_b"]);
    expect(received.filter((c) => "toolCalls" in c)).toHaveLength(1);
  });

  it("emits no tool-call chunk on a plain text turn", async () => {
    const received: StreamChunk[] = [];
    mockFetch([ev("response.output_text.delta", { delta: "just prose" }), COMPLETED]);
    await streamCompletion({
      baseUrl: "", apiKey: "k", standard: "openai_responses", modelId: "m",
      messages: [{ role: "user", content: "hi" }], tools: [TOOL],
      onChunk: (c) => received.push(c),
    });
    expect(received.find((c) => "toolCalls" in c)).toBeUndefined();
    expect(text(received)).toBe("just prose");
  });
});

describe("Responses adapter — echoing a tool round", () => {
  const history: StreamMessage[] = [
    { role: "user", content: "read a.md" },
    {
      role: "assistant", content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.md"}' } }],
      _responseItems: { modelId: "gpt-5.5", items: [REASONING_ITEM, CALL_ITEM] },
    },
    { role: "tool", tool_call_id: "call_1", content: "# a" },
  ];

  it("puts the turn's own items into input, in place of the bare mapping, for the same model", async () => {
    const calls = mockFetch([COMPLETED]);
    await streamCompletion({
      baseUrl: "", apiKey: "k", standard: "openai_responses", modelId: "gpt-5.5",
      messages: history, tools: [TOOL], onChunk: () => {},
    });
    expect(calls[0].body.input).toEqual([
      { role: "user", content: "read a.md" },
      REASONING_ITEM,
      CALL_ITEM,
      { type: "function_call_output", call_id: "call_1", output: "# a" },
    ]);
  });

  it("falls back to the bare function_call when the items came from another model", () => {
    const { input } = toResponsesInput(history, "gpt-5.4");
    expect(input).toEqual([
      { role: "user", content: "read a.md" },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.md"}' },
      { type: "function_call_output", call_id: "call_1", output: "# a" },
    ]);
    expect(JSON.stringify(input)).not.toContain("encrypted_content");
  });
});

describe("Responses adapter — reasoning effort", () => {
  async function bodyFor(opts: { reasoningEffort?: ReasoningEffort; thinkingCategory?: ThinkingCategoryId }) {
    const calls = mockFetch([COMPLETED]);
    await streamCompletion({
      baseUrl: "", apiKey: "k", standard: "openai_responses", modelId: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: opts.reasoningEffort,
      thinkingCategory: opts.thinkingCategory,
      onChunk: () => {},
    });
    return calls[0].body;
  }

  it("sends nothing when no effort is set — each model's own default differs", async () => {
    expect(await bodyFor({})).not.toHaveProperty("reasoning");
    expect(await bodyFor({ reasoningEffort: "default" })).not.toHaveProperty("reasoning");
    // And never the Chat Completions spelling.
    expect(await bodyFor({ reasoningEffort: "high" })).not.toHaveProperty("reasoning_effort");
  });

  it("spells a level as reasoning.effort with a summary requested alongside", async () => {
    for (const [effort, wire] of [["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]] as const) {
      expect((await bodyFor({ reasoningEffort: effort })).reasoning).toEqual({ effort: wire, summary: "auto" });
    }
  });

  it("spells off as effort:none, with no summary to ask for", async () => {
    expect((await bodyFor({ reasoningEffort: "off" })).reasoning).toEqual({ effort: "none" });
  });

  it("resolves a cross-family category to the family's own, not to Chat Completions fields", async () => {
    // A model row imported with a Chat Completions category, now under a
    // Responses provider: the wire must stay this family's.
    const body = await bodyFor({ reasoningEffort: "high", thinkingCategory: "openai-generic" });
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("the off category sends nothing at all", async () => {
    expect(await bodyFor({ reasoningEffort: "high", thinkingCategory: "off" })).not.toHaveProperty("reasoning");
  });
});
