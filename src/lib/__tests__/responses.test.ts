/**
 * The OpenAI Responses adapter (lib/ai/responses.ts) — slice D of
 * docs/api/qianwen-compat-plan.md §4.4: text streaming, the request shape,
 * and the four ways a stream ends. Event fixtures follow the measured
 * sequences in docs/api/responses.md §4.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { streamCompletion, type StreamChunk, type StreamMessage } from "../ai";
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

  it("sends tools nowhere yet (slice E) and never invents a tools key", async () => {
    const calls = mockFetch([COMPLETED]);
    await streamCompletion({
      baseUrl: "", apiKey: "k", standard: "openai_responses", modelId: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", description: "", parameters: {} } }],
      onChunk: () => {},
    });
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0].body).not.toHaveProperty("tools");
    expect(calls[0].body).not.toHaveProperty("tool_choice");
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
