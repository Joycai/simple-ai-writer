import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStreamUsage, usageSnapshot } from "../streamUsage";
import { recordUsage } from "../usageRow";
import { streamCompletion, type StreamOptions } from "../index";
vi.mock("../usageRow", () => ({ recordUsage: vi.fn(async () => {}) }));
const accounting = { projectPath: "/p", model: { id: "model" }, task: "chat" };
const line = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const opts = (standard: StreamOptions["standard"] = "openai_compat"): StreamOptions => ({
  standard, modelId: "model", apiKey: "", baseUrl: "https://example.test/v1",
  messages: [{ role: "user", content: "write" }], onChunk: vi.fn(), accounting,
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("overwrites cumulative snapshots, preserves missing fields and seals once", async () => {
  const usage = createStreamUsage(accounting);
  usage.start();
  usage.snapshot({ inputTokens: 100, outputTokens: 1 });
  usage.snapshot({ outputTokens: 8, reportedCost: 0 });
  usage.snapshot({ outputTokens: 8 });
  await usage.finish("failed");
  usage.snapshot({ outputTokens: 999 });
  await usage.finish("complete");
  expect(recordUsage).toHaveBeenCalledTimes(1);
  expect(vi.mocked(recordUsage).mock.calls[0][1]).toMatchObject({ promptTokens: 100, completionTokens: 8, reportedCost: 0, requests: 0,
    usageEvidence: { outcome: "failed", source: "reported", fields: { inputTokens: 100, outputTokens: 8, reportedCost: 0 } } });
});
it("records unknown failed attempts without inventing a request fee or token counts", async () => {
  const usage = createStreamUsage(accounting);
  usage.start(); await usage.finish("failed");
  expect(recordUsage).toHaveBeenCalledWith("/p", expect.objectContaining({ requests: 0, usageEvidence: { outcome: "failed", source: "unreported", fields: {} } }));
  expect(usageSnapshot("openai", { prompt_tokens: NaN, completion_tokens: -1, total_tokens: 300 })).toEqual({});
  expect(usageSnapshot("gemini", { promptTokenCount: 10, toolUsePromptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 7 })).toEqual({ inputTokens: 15, outputTokens: 10 });
});
const cases: { standard: StreamOptions["standard"]; frames: string; input: number; output?: number }[] = [
  { standard: "openai_compat", frames: line({ usage: { prompt_tokens: 10, completion_tokens: 3 } }), input: 10, output: 3 },
  { standard: "gemini_compat", frames: line({ usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 3 } }), input: 10, output: 3 },
  { standard: "anthropic_compat", frames: line({ type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 5 } } }), input: 10 },
  { standard: "dashscope_compat", frames: line({ usage: { input_tokens: 10, output_tokens: 3 } }), input: 10, output: 3 },
  { standard: "openai_responses_compat", frames: line({ type: "response.failed", response: { usage: { input_tokens: 10, output_tokens: 3 }, error: { message: "failed" } } }), input: 10, output: 3 },
];
it.each(cases)("$standard persists reported partial usage on failure", async ({ standard, frames, input, output }) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(frames)));
  await expect(streamCompletion(opts(standard))).rejects.toThrow();
  expect(recordUsage).toHaveBeenCalledTimes(1);
  expect(vi.mocked(recordUsage).mock.calls[0][1]).toMatchObject({ promptTokens: input, completionTokens: output, usageEvidence: { outcome: "failed" } });
});
it("keeps completed Anthropic legs when a resumed request fails, without counting the turn total again", async () => {
  const first = line({ type: "message_start", message: { usage: { input_tokens: 10 } } }) +
    line({ type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 4 } }) + line({ type: "message_stop" });
  const second = line({ type: "message_start", message: { usage: { input_tokens: 20 } } }) + line({ type: "error", error: { message: "broken" } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(first)).mockResolvedValueOnce(new Response(second)));
  await expect(streamCompletion(opts("anthropic_compat"))).rejects.toThrow();
  const rows = vi.mocked(recordUsage).mock.calls.map(([, row]) => row);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ promptTokens: 10, completionTokens: 4, requests: 1, usageEvidence: { outcome: "complete" } });
  expect(rows[1]).toMatchObject({ promptTokens: 20, requests: 0, usageEvidence: { outcome: "failed" } });
  expect(rows[0].requestId).not.toBe(rows[1].requestId);
});
it("manual retry is a new billable attempt; successful usage is written only once", async () => {
  const frames = line({ usage: { prompt_tokens: 10, completion_tokens: 3 } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(frames)).mockResolvedValueOnce(new Response(frames + frames + "data: [DONE]\n\n")));
  await expect(streamCompletion(opts())).rejects.toThrow();
  await streamCompletion(opts());
  const rows = vi.mocked(recordUsage).mock.calls.map(([, row]) => row);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.completionTokens)).toEqual([3, 3]);
  expect(new Set(rows.map((r) => r.requestId)).size).toBe(2);
});
it("records reported input when the author aborts before the terminal frame", async () => {
  const controller = new AbortController();
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(line({ usage: { prompt_tokens: 15 } }) + line({ choices: [{ delta: { content: "partial" } }] })));
    init.signal?.addEventListener("abort", () => c.error(new DOMException("Aborted", "AbortError")));
  } }))));
  await expect(streamCompletion({ ...opts(), signal: controller.signal, onChunk: () => controller.abort() })).rejects.toThrow();
  expect(vi.mocked(recordUsage).mock.calls[0][1]).toMatchObject({ promptTokens: 15, usageEvidence: { outcome: "cancelled", fields: { inputTokens: 15 } } });
});
it("retains unknown capability refusals separately from their successful replacement", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("Thinking mode does not support this tool_choice", { status: 400 }))
    .mockResolvedValueOnce(new Response(line({ usage: { prompt_tokens: 10, completion_tokens: 3 } }) + "data: [DONE]\n\n"));
  vi.stubGlobal("fetch", fetcher);
  await streamCompletion({ ...opts(), baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash",
    tools: [{ type: "function", function: { name: "emit", description: "Return a result", parameters: { type: "object", properties: {} } } }], toolChoice: "required" });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(recordUsage).toHaveBeenCalledTimes(2);
  expect(vi.mocked(recordUsage).mock.calls[0][1].requests).toBe(0);
  expect(vi.mocked(recordUsage).mock.calls[1][1].requests).toBe(1);
});
it("flushes the latest reported counts on watchdog abort", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(line({ usage: { prompt_tokens: 10, completion_tokens: 3 } })));
    init.signal?.addEventListener("abort", () => c.error(new DOMException("Aborted", "AbortError")));
  } }))));
  const pending = streamCompletion(opts());
  const failed = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(600_001);
  await failed;
  expect(recordUsage).toHaveBeenCalledTimes(1);
  expect(vi.mocked(recordUsage).mock.calls[0][1]).toMatchObject({ promptTokens: 10, completionTokens: 3, usageEvidence: { outcome: "failed" } });
});


it.each(["openai_compat", "openai_responses_compat"] as const)("%s keeps reported usage when refusing", async (standard) => {
  const frames = standard === "openai_compat"
    ? line({ choices: [{ delta: { refusal: "Cannot answer" }, finish_reason: "stop" }] }) +
      line({ usage: { prompt_tokens: 10, completion_tokens: 3 } }) + "data: [DONE]\n\n"
    : line({ type: "response.refusal.delta", delta: "Cannot answer" }) +
      line({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 } } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(frames)));
  const request = opts(standard);
  await expect(streamCompletion(request)).rejects.toThrow("refusal: Cannot answer");
  expect(recordUsage).toHaveBeenCalledTimes(1);
  expect(vi.mocked(recordUsage).mock.calls[0][1]).toMatchObject({ promptTokens: 10, completionTokens: 3, usageEvidence: { outcome: "failed" } });
  expect(vi.mocked(request.onChunk).mock.calls.some(([chunk]) => "done" in chunk)).toBe(false);
});
