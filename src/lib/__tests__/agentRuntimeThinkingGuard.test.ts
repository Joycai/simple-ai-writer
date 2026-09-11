/**
 * The thinking guard (docs/feature/agent/window-edge-plan.md D6).
 *
 * A round whose thinking alone has used half the room left in the window, with
 * no answer and no tool call started, is cut and retried once — with thinking
 * switched off where the model's own dial can say so. Measured on a 32k local
 * model, the same prompt went from 307 s of thinking and nothing written to a
 * 20 s answer once thinking was off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamOptions } from "../ai/types";
import type { AgentEvent } from "../agent/events";
import type { TaskPreset } from "../agent/presets";
import { runAgent, type AgentRuntimeOptions } from "../agent/runtime";

vi.mock("../ai", () => ({ streamCompletion: vi.fn() }));
import { streamCompletion } from "../ai";
const mockStream = vi.mocked(streamCompletion);

/** One round, like 写一篇短篇: no tools, and the round cap is exactly one. */
const WRITE: TaskPreset = { id: "longform", tools: [], maxRounds: 1, finishPolicy: "force-text" };
const WINDOW = 1_000;

/** What each request was sent with, captured at call time. */
const sent: StreamOptions[] = [];

/** A round that thinks until it is stopped — honouring the signal the way an adapter does. */
function spiral(): void {
  mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
    sent.push({ ...opts, messages: [...opts.messages] });
    for (let i = 0; i < 200; i++) {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      opts.onChunk({ reasoning: "或者更戏剧一点，或者写成现实悬疑。".repeat(4) });
    }
    opts.onChunk({ done: true, inputTokens: 50, outputTokens: 950, truncated: true, stopReason: "length" });
  });
}

function answer(text: string): void {
  mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
    sent.push({ ...opts, messages: [...opts.messages] });
    opts.onChunk({ reasoning: "好。" });
    opts.onChunk({ text });
    opts.onChunk({ done: true, inputTokens: 50, outputTokens: 20 });
  });
}

function makeOptions(overrides: Partial<AgentRuntimeOptions> = {}) {
  const events: AgentEvent[] = [];
  const output: string[] = [];
  return {
    baseUrl: "http://localhost",
    apiKey: "",
    standard: "openai_compat" as const,
    modelId: "qwen",
    contextSize: WINDOW,
    preset: WRITE,
    messages: [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "写一篇短篇" },
    ],
    toolContext: { projectPath: "/p", loreIndex: {}, multimodal: false },
    signal: new AbortController().signal,
    onEvent: (e: AgentEvent) => void events.push(e),
    onOutputText: (t: string) => void output.push(t),
    events,
    output,
    ...overrides,
  } as AgentRuntimeOptions & { events: AgentEvent[]; output: string[] };
}

const truncations = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { kind: "output-truncated" }> =>
    e.kind === "output-truncated");

const NOTICE = "不要展开思考";

beforeEach(() => {
  mockStream.mockReset();
  sent.length = 0;
});

describe("thinking guard", () => {
  it("cuts the round and retries once with thinking off, without spending the round cap", async () => {
    spiral();
    answer("写好了。");
    const opts = makeOptions();

    const result = await runAgent(opts);

    expect(sent).toHaveLength(2);
    expect(sent[0].signal?.aborted).toBe(true);
    // The model's own dial (通用 → reasoning_effort) offers "off", so that is what the retry sends.
    expect(sent[0].reasoningEffort).toBeUndefined();
    expect(sent[1].reasoningEffort).toBe("off");
    expect(result.outcome).toBe("completed");
    expect(opts.output[opts.output.length - 1]).toBe("写好了。");
    expect(truncations(opts.events)[0]).toMatchObject({
      cause: "thinking-budget",
      thinkingOnly: true,
      recovery: { kind: "thinking-off", attempt: 1 },
    });
    // The cut round wrote nothing, so the transcript holds only the answer.
    expect(opts.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("keeps thinking off for the rest of the run, not just the retry", async () => {
    // Measured on a 32k local model: the retry happened to be a tool round, the
    // round after it went back to full thinking, and spiralled for another 383 s.
    spiral();
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      sent.push({ ...opts, messages: [...opts.messages] });
      opts.onChunk({ toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] });
      opts.onChunk({ done: true, inputTokens: 50, outputTokens: 10 });
    });
    answer("写好了。");
    const opts = makeOptions({
      preset: { id: "continue", tools: ["list_lore_entities"], maxRounds: 4, finishPolicy: "force-text" },
    });

    const result = await runAgent(opts);

    expect(sent.map((o) => o.reasoningEffort)).toEqual([undefined, "off", "off"]);
    expect(result.outcome).toBe("completed");
    expect(opts.output[opts.output.length - 1]).toBe("写好了。");
  });

  it("retries with a retracted notice when the category has no way to say off", async () => {
    spiral();
    answer("写好了。");
    // The do-nothing category: it sends no thinking parameter at all.
    const opts = makeOptions({ thinkingCategory: "off" });

    await runAgent(opts);

    expect(sent).toHaveLength(2);
    expect(sent[1].reasoningEffort).toBeUndefined();
    const lastSent = sent[1].messages[sent[1].messages.length - 1];
    expect(lastSent.role).toBe("user");
    expect(String(lastSent.content)).toContain(NOTICE);
    expect(truncations(opts.events)[0].recovery).toEqual({ kind: "answer-now", attempt: 1 });
    // A standing order not to think must not outlive the round it was for.
    expect(opts.messages.some((m) => typeof m.content === "string" && m.content.includes(NOTICE))).toBe(false);
  });

  it("cuts at most once per run", async () => {
    spiral();
    spiral();
    const opts = makeOptions();

    const result = await runAgent(opts);

    // The second attempt runs to the endpoint's own cut-off, which PR-2 reports.
    expect(sent).toHaveLength(2);
    expect(result.outcome).toBe("truncated");
    const cuts = truncations(opts.events);
    expect(cuts[0]).toMatchObject({ cause: "thinking-budget" });
    expect(cuts[1]).toMatchObject({ cause: "window", thinkingOnly: true });
    expect(cuts[1].recovery).toBeUndefined();
  });

  it("leaves the run alone when the window size is unknown", async () => {
    spiral();
    const opts = makeOptions({ contextSize: undefined });

    const result = await runAgent(opts);

    expect(sent).toHaveLength(1);
    expect(result.outcome).toBe("truncated");
    expect(truncations(opts.events)[0].cause).toBeUndefined();
  });

  it("does not cut a model that thinks within the budget", async () => {
    answer("写好了。");
    const opts = makeOptions();

    await runAgent(opts);

    expect(sent).toHaveLength(1);
    expect(truncations(opts.events)).toHaveLength(0);
  });

  it("still stops the run when the author presses stop mid-thought", async () => {
    const controller = new AbortController();
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      sent.push(opts);
      opts.onChunk({ reasoning: "想一想……" });
      controller.abort();
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    });
    const opts = makeOptions({ signal: controller.signal });

    await expect(runAgent(opts)).rejects.toMatchObject({ name: "AbortError" });
    expect(sent).toHaveLength(1);
    expect(truncations(opts.events)).toHaveLength(0);
  });
});
