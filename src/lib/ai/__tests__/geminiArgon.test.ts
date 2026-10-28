import { afterEach, describe, expect, it, vi } from "vitest";
import { streamGemini, convertToGeminiContents } from "../gemini";
import { streamCompletion } from "../index";
import { planRequest } from "../capability/plan";
import { modelValue } from "../capability/values";
import { capabilityVerdict, platformModelCalibration } from "../capabilities";
import { recordUsage } from "../usageRow";
import type { StreamChunk, StreamOptions } from "../types";

vi.mock("../usageRow", () => ({ recordUsage: vi.fn(async () => {}) }));
const line = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const frame = (finishReason: string, token?: string, parts: unknown[] = [{ text: "" }], usage?: object) => line({
  candidates: [{ content: { role: "model", parts }, finishReason, ...(token ? { continuationToken: token } : {}) }],
  ...(usage ? { usageMetadata: usage } : {}),
});
const options = (overrides: Partial<StreamOptions> = {}): StreamOptions => ({
  standard: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "test",
  modelId: "gemini-4-argon", messages: [{ role: "user", content: "write" }], onChunk: vi.fn(), ...overrides,
});
function mockHops(...hops: string[]) {
  const fetcher = vi.fn();
  for (const hop of hops) fetcher.mockResolvedValueOnce(new Response(hop));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const sent = (fetcher: ReturnType<typeof vi.fn>, i: number) => JSON.parse(fetcher.mock.calls[i][1].body);
const last = (chunks: StreamChunk[]) => [...chunks].reverse().find((c) => "done" in c);
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("Argon GenerateContent", () => {
  it("continues thinking-only hops with original request and latest opaque token, aggregating final snapshots", async () => {
    const fetcher = mockHops(
      line({ usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 1 } }) +
        frame("CONTINUATION", "opaque+/=1", [{ text: "", thoughtSignature: "signature" }], { promptTokenCount: 10, thoughtsTokenCount: 20 }),
      frame("CONTINUATION", "opaque+/=2", [{ text: "A" }], { promptTokenCount: 30, candidatesTokenCount: 2, cachedContentTokenCount: 20 }),
      frame("STOP", undefined, [{ text: "B" }], { promptTokenCount: 32, candidatesTokenCount: 3, cachedContentTokenCount: 25 }),
    );
    const chunks: StreamChunk[] = [];
    const request = options({ maxOutput: 262144, temperature: 0.4, onChunk: (c) => chunks.push(c),
      extraBody: { generationConfig: { responseMimeType: "application/json", topP: 0.9, topK: 4, candidateCount: 2 } } });
    await streamGemini(request);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sent(fetcher, 0)).not.toHaveProperty("continuationToken");
    expect(sent(fetcher, 1)).toEqual({ ...sent(fetcher, 0), continuationToken: "opaque+/=1" });
    expect(sent(fetcher, 2)).toEqual({ ...sent(fetcher, 0), continuationToken: "opaque+/=2" });
    expect(sent(fetcher, 0).generationConfig).toEqual({ responseMimeType: "application/json", maxOutputTokens: 262144 });
    expect(chunks.filter((c) => "text" in c)).toEqual([{ text: "A" }, { text: "B" }]);
    expect(chunks.filter((c) => "done" in c)).toHaveLength(1);
    expect(last(chunks)).toEqual({ done: true, inputTokens: 72, initialInputTokens: 10, outputTokens: 25, cachedTokens: 45, stopReason: "STOP" });
    expect(request.extraBody?.generationConfig).toHaveProperty("topP", 0.9);
  });

  it("keeps signed parts across hops and dispatches function calls once, after the final hop", async () => {
    const signed = { text: "", thoughtSignature: "keep-exactly" };
    const call = { functionCall: { name: "lookup", args: { query: "x" } }, thoughtSignature: "call-signature" };
    mockHops(frame("CONTINUATION", "token", [signed]), frame("STOP", undefined, [call]));
    const chunks: StreamChunk[] = [];
    await streamGemini(options({ onChunk: (c) => chunks.push(c) }));
    const toolChunks = chunks.filter((c) => "toolCalls" in c);
    expect(toolChunks).toHaveLength(1);
    const tool = toolChunks[0];
    if (!("toolCalls" in tool)) throw new Error("missing tool calls");
    expect(tool._geminiModelParts).toEqual([signed, call]);
    expect(convertToGeminiContents([{ role: "assistant", content: null, tool_calls: tool.toolCalls.map((t) => ({
      id: t.id, type: "function", function: { name: t.name, arguments: t.arguments },
    })), _geminiModelParts: tool._geminiModelParts }])[0].parts).toEqual([signed, call]);
  });

  it("stops at MAX_TOKENS without increasing the declared budget", async () => {
    const fetcher = mockHops(frame("MAX_TOKENS", "checkpoint"));
    const chunks: StreamChunk[] = [];
    await streamGemini(options({ maxOutput: 65536, onChunk: (c) => chunks.push(c) }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(last(chunks)).toMatchObject({ truncated: true, stopReason: "MAX_TOKENS" });
  });

  it.each([undefined, "same"])("rejects a missing or repeated continuation token (%s)", async (token) => {
    const fetcher = token ? mockHops(frame("CONTINUATION", token), frame("CONTINUATION", token)) : mockHops(frame("CONTINUATION"));
    const chunks: StreamChunk[] = [];
    await expect(streamGemini(options({ onChunk: (c) => chunks.push(c) }))).rejects.toThrow("checkpoint");
    expect(fetcher).toHaveBeenCalledTimes(token ? 2 : 1);
    expect(last(chunks)).toBeUndefined();
  });

  it("refuses further paid hops when the endpoint claims continuation beyond the declared budget", async () => {
    const fetcher = mockHops(frame("CONTINUATION", "token", [], { thoughtsTokenCount: 100 }));
    await expect(streamGemini(options({ maxOutput: 100 }))).rejects.toThrow("total output budget");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses checkpoints from the candidate even when they precede the terminal frame", async () => {
    const fetcher = mockHops(line({ candidates: [{ continuationToken: "latest" }] }) + frame("CONTINUATION"), frame("STOP"));
    await streamGemini(options());
    expect(sent(fetcher, 1).continuationToken).toBe("latest");
  });

  it("does not replay a dropped stream or silently report completion", async () => {
    const fetcher = mockHops(line({ candidates: [{ content: { parts: [{ text: "partial" }] }, continuationToken: "checkpoint" }] }));
    await expect(streamGemini(options())).rejects.toThrow("interrupted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation between hops without launching another paid request", async () => {
    const controller = new AbortController();
    const fetcher = mockHops(frame("CONTINUATION", "checkpoint"));
    await expect(streamGemini(options({ signal: controller.signal, _onUsageComplete: () => controller.abort() }))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("records completed hops separately from a failed continuation, retaining observed usage", async () => {
    mockHops(frame("CONTINUATION", "checkpoint", [], { promptTokenCount: 10, thoughtsTokenCount: 20 }),
      line({ usageMetadata: { promptTokenCount: 30, thoughtsTokenCount: 2 } }) + line({ error: { message: "broken" } }));
    await expect(streamCompletion(options({ accounting: { projectPath: "/p", model: { id: "m" }, task: "chat" } }))).rejects.toThrow("broken");
    const rows = vi.mocked(recordUsage).mock.calls.map(([, row]) => row);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ promptTokens: 10, completionTokens: 20, requests: 1, usageEvidence: { outcome: "complete" } });
    expect(rows[1]).toMatchObject({ promptTokens: 30, completionTokens: 2, requests: 0, usageEvidence: { outcome: "failed" } });
    expect(rows[0].requestId).not.toBe(rows[1].requestId);
  });

  it("records successful hops once each, never charging the final aggregate twice", async () => {
    mockHops(frame("CONTINUATION", "checkpoint", [], { promptTokenCount: 10, thoughtsTokenCount: 20 }),
      frame("STOP", undefined, [{ text: "done" }], { promptTokenCount: 30, candidatesTokenCount: 2 }));
    await streamCompletion(options({ accounting: { projectPath: "/p", model: { id: "m" }, task: "chat" } }));
    const rows = vi.mocked(recordUsage).mock.calls.map(([, row]) => row);
    expect(rows.map((r) => [r.promptTokens, r.completionTokens, r.requests])).toEqual([[10, 20, 1], [30, 2, 1]]);
  });

  it.each([[0, 0, 0], [0.1, 0.2, 0.3], [0.1, undefined, undefined]])("only sums cost when every hop reported (%s, %s)", async (a, b, total) => {
    mockHops(frame("CONTINUATION", "checkpoint", [], { costUsd: a }), frame("STOP", undefined, [], { costUsd: b }));
    const chunks: StreamChunk[] = [];
    await streamGemini(options({ standard: "gemini_compat", platform: "orcarouter", baseUrl: "https://api.orcarouter.ai/v1beta", onChunk: (c) => chunks.push(c) }));
    const done = last(chunks);
    if (total === undefined) expect(done).not.toHaveProperty("reportedCost");
    else expect(done && "done" in done && done.reportedCost).toBeCloseTo(total);
  });
});

describe("Argon native route policy", () => {
  it("recognizes canonical relay ids and leaves other models/protocols unchanged", () => {
    const argon = planRequest(options({ modelId: "[channel]gemini-4-argon", canonicalModelId: "google/gemini-4-argon" }));
    expect(argon.gemini).toEqual({ maxOutputTokens: 65536, readTimeoutMs: 1200000 });
    expect(argon.temperature).toBeUndefined();
    for (const modelId of ["gemini-3.8-flash", "gemini-4-argonaut"]) {
      const plan = planRequest(options({ modelId, temperature: 0.5 }));
      expect(plan.gemini).toBeUndefined(); expect(plan.temperature).toBe(0.5);
    }
    expect(planRequest(options({ standard: "openai_compat", temperature: 0.5 })).temperature).toBe(0.5);
    expect(planRequest(options({ standard: "openai_compat" })).gemini).toBeUndefined();
    expect(capabilityVerdict("temperature", { platform: "google", standard: "gemini" }, { modelId: "gemini-4-argon" })).toEqual({ status: "no", reason: "model" });
  });

  it("keeps Gemini 3.8 requests unchanged", async () => {
    const fetcher = mockHops(frame("STOP"));
    await streamGemini(options({ modelId: "gemini-3.8-flash", temperature: 0.4, maxOutput: 262144 }));
    expect(sent(fetcher, 0).generationConfig).toEqual({ temperature: 0.4 });
  });

  it("keeps inferred limits planning-only and uses explicit author output budgets", () => {
    expect(planRequest(options({ maxOutput: 262144 })).gemini?.maxOutputTokens).toBe(262144);
    expect(planRequest(options({ maxOutput: 262144, provenance: { maxOutput: "catalog" } })).gemini?.maxOutputTokens).toBe(65536);
    expect(platformModelCalibration("google", "gemini-4-argon", "gemini")).toMatchObject({ type: "multimodal", pdfInput: true });
    expect(modelValue("contextSize", { modelId: "gemini-4-argon" }, { standard: "gemini" })).toEqual({ value: 1048576, source: "catalog" });
    expect(modelValue("maxOutput", { modelId: "gemini-4-argon" }, { standard: "gemini" })).toEqual({ value: 65536, source: "catalog" });
  });

  it("allows a long first-token wait while author cancellation remains immediate", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    vi.stubGlobal("fetch", fetcher);
    const result = streamCompletion(options({ signal: controller.signal })).then(() => undefined, (e: unknown) => e);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(180000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(false);
    controller.abort(new Error("author stopped"));
    expect(await result).toMatchObject({ message: "author stopped" });
  });
  it.each([false, true])("expires at the Argon read deadline (after first output: %s)", async (started) => {
    vi.useFakeTimers();
    let activeSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      activeSignal = init.signal ?? undefined;
      return new Response(new ReadableStream({ start(c) {
        if (started) c.enqueue(new TextEncoder().encode(line({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })));
        activeSignal?.addEventListener("abort", () => c.error(activeSignal?.reason));
      } }));
    }));
    const result = streamCompletion(options()).then(() => undefined, (e: unknown) => e);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(600001);
    expect(activeSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(600001);
    expect(activeSignal?.aborted).toBe(true);
    expect(await result).toMatchObject({ phase: started ? "idle" : "first-chunk" });
  });

  it("refreshes the silence allowance for the next continuation hop", async () => {
    vi.useFakeTimers();
    let finishFirst!: () => void;
    let secondSignal: AbortSignal | undefined;
    const fetcher = vi.fn().mockImplementationOnce(async () => new Response(new ReadableStream({ start(c) {
      finishFirst = () => { c.enqueue(new TextEncoder().encode(frame("CONTINUATION", "checkpoint", []))); c.close(); };
    } }))).mockImplementationOnce(async (_url, init: RequestInit) => {
      secondSignal = init.signal ?? undefined;
      return new Response(new ReadableStream({ start(c) { secondSignal?.addEventListener("abort", () => c.error(secondSignal?.reason)); } }));
    });
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const result = streamCompletion(options({ signal: controller.signal })).catch((e: unknown) => e);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000000);
    finishFirst();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(600001);
    expect(secondSignal?.aborted).toBe(false);
    controller.abort();
    await result;
  });

});
