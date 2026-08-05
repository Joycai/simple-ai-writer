/**
 * Agent runtime tests — the tool loop with a mocked streaming client.
 * Verifies event emission (execution log), the tool-call/result message
 * protocol, per-preset round caps, and the force-text final round.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamOptions } from "../ai/types";
import type { AgentEvent } from "../agent/events";
import type { TaskPreset } from "../agent/presets";
import { runAgent, trimHistory, type AgentRuntimeOptions } from "../agent/runtime";
import type { LoreIndex } from "../lore";
import type { StreamMessage } from "../ai/types";

vi.mock("../ai", () => ({ streamCompletion: vi.fn() }));
import { streamCompletion } from "../ai";
const mockStream = vi.mocked(streamCompletion);

const LORE_INDEX = {
  characters: [
    { name: "Ava", summary: "the protagonist", dirPath: "/p/.ai-writer/lore/characters/ava", images: [] },
  ],
  world: [],
} as unknown as LoreIndex;

const PRESET: TaskPreset = {
  id: "test",
  tools: ["list_lore_entities", "read_lore_entity", "list_files", "read_file"],
  maxRounds: 8,
  finishPolicy: "force-text",
};

function makeOptions(overrides: Partial<AgentRuntimeOptions> = {}): AgentRuntimeOptions & {
  events: AgentEvent[];
  /** Every snapshot the runtime pushed; the last one is the run's output. */
  output: string[];
} {
  const events: AgentEvent[] = [];
  const output: string[] = [];
  return {
    baseUrl: "http://localhost",
    apiKey: "k",
    standard: "openai" as const,
    modelId: "m",
    preset: PRESET,
    messages: [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "go" },
    ],
    toolContext: { projectPath: "/p", loreIndex: LORE_INDEX, multimodal: false },
    signal: new AbortController().signal,
    onEvent: (e: AgentEvent) => void events.push(e),
    onOutputText: (t: string) => void output.push(t),
    events,
    output,
    ...overrides,
  };
}

/** Queue one streamCompletion round: emits the given chunks, resolves. */
function queueRound(chunks: Array<Record<string, unknown>>): void {
  mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
    for (const c of chunks) opts.onChunk(c as never);
  });
}

beforeEach(() => {
  mockStream.mockReset();
});

/** The run's output: the final snapshot. (`Array.at` postdates the TS target.) */
const last = (snapshots: string[]) => snapshots[snapshots.length - 1];

describe("runAgent", () => {
  it("finishes on a text-only round and reports usage", async () => {
    queueRound([{ text: "hello " }, { text: "world" }, { done: true, inputTokens: 10, outputTokens: 5 }]);
    const opts = makeOptions();

    const result = await runAgent(opts);

    expect(result).toEqual({ rounds: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0 });
    expect(last(opts.output)).toBe("hello world");
    // Streamed, not delivered in one lump.
    expect(opts.output).toEqual(["hello ", "hello world"]);
    // Exactly one round-start, no tool steps
    expect(opts.events.map((e) => e.kind)).toEqual(["round-start"]);
    const round = opts.events[0] as Extract<AgentEvent, { kind: "round-start" }>;
    expect(round.round).toBe(1);
    expect(round.maxRounds).toBe(8);
    expect(round.estInputTokens).toBeGreaterThan(0);
  });

  it("discards what the model said before calling a tool", async () => {
    // Round 1 narrates ("我先去找文件列表。") and then calls a tool. That text is
    // the model thinking out loud, not output — it used to be spliced into the
    // result the author then inserted into their document.
    queueRound([
      { text: "我先去找文件列表。" },
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      { done: true, inputTokens: 8, outputTokens: 2 },
    ]);
    queueRound([{ text: "**未提及**\n- 权限接口" }, { done: true, inputTokens: 20, outputTokens: 7 }]);
    const opts = makeOptions();

    await runAgent(opts);

    expect(last(opts.output)).toBe("**未提及**\n- 权限接口");
    // It was shown while it streamed, then retracted — the flash is the price of
    // not stalling the real answer behind a round-completion check.
    expect(opts.output).toContain("我先去找文件列表。");
    expect(opts.output).toContain("");
  });

  it("keeps text from every round that ends in prose", async () => {
    // Only *tool* rounds are discarded. A run whose rounds each end in text
    // accumulates all of it.
    queueRound([
      { text: "part one. " },
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    queueRound([{ text: "the answer" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    const opts = makeOptions();

    await runAgent(opts);

    // "part one. " preceded a tool call, so it goes; only the final prose stays.
    expect(last(opts.output)).toBe("the answer");
  });

  it("executes a tool round, appends protocol messages, then finishes", async () => {
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      { done: true, inputTokens: 8, outputTokens: 2 },
    ]);
    queueRound([{ text: "done" }, { done: true, inputTokens: 20, outputTokens: 7 }]);
    const opts = makeOptions();

    const result = await runAgent(opts);

    expect(result).toEqual({ rounds: 2, inputTokens: 28, outputTokens: 9, cachedTokens: 0 });

    // Event order: round 1, tool running, tool done, round 2
    expect(opts.events.map((e) => e.kind)).toEqual([
      "round-start", "tool-step", "tool-step", "round-start",
    ]);
    const doneStep = opts.events[2] as Extract<AgentEvent, { kind: "tool-step" }>;
    expect(doneStep.step.status).toBe("done");
    expect(doneStep.step.resultSummary).toContain("Ava");

    // History protocol: assistant tool_calls + matching tool result appended
    const history = opts.messages;
    expect(history).toHaveLength(4);
    const assistant = history[2] as { role: string; tool_calls: Array<{ id: string }> };
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls[0].id).toBe("c1");
    const toolMsg = history[3] as { role: string; tool_call_id: string; content: string };
    expect(toolMsg).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(toolMsg.content).toContain("Ava");

    // Round 2's request carried the grown history and still offered tools
    const secondCall = mockStream.mock.calls[1][0];
    expect(secondCall.messages).toBe(history);
    expect(secondCall.tools).toHaveLength(4);
  });

  it("accumulates cachedTokens across rounds", async () => {
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      { done: true, inputTokens: 8, outputTokens: 2, cachedTokens: 5 },
    ]);
    queueRound([{ text: "done" }, { done: true, inputTokens: 20, outputTokens: 7, cachedTokens: 15 }]);
    const opts = makeOptions();

    const result = await runAgent(opts);

    expect(result).toEqual({ rounds: 2, inputTokens: 28, outputTokens: 9, cachedTokens: 20 });
  });

  it("reports a tool-step error for unknown tools and lets the model retry", async () => {
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "no_such_tool", arguments: "{}" }] },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    queueRound([{ text: "ok" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    const opts = makeOptions();

    await runAgent(opts);

    const errStep = opts.events.find(
      (e): e is Extract<AgentEvent, { kind: "tool-step" }> =>
        e.kind === "tool-step" && e.step.status === "error",
    );
    expect(errStep?.step.resultSummary).toContain("Unknown tool");
    // The error still went back as a protocol-valid tool message
    const toolMsg = opts.messages[3] as { role: string; content: string };
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toContain("Unknown tool");
  });

  it("withholds tools and forces text on the final round of a force-text preset", async () => {
    queueRound([{ text: "forced" }, { done: true, inputTokens: 3, outputTokens: 3 }]);
    const opts = makeOptions({ preset: { ...PRESET, maxRounds: 1 } });

    await runAgent(opts);

    const call = mockStream.mock.calls[0][0];
    expect(call.tools).toBeUndefined();
    const last = opts.messages[opts.messages.length - 1] as { role: string; content: string };
    // The "write now" instruction was injected before the request
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("without calling any more tools");
  });

  it("sends no tool definitions for an empty (single-shot) toolset", async () => {
    queueRound([{ text: "plain" }, { done: true, inputTokens: 2, outputTokens: 2 }]);
    const opts = makeOptions({
      preset: { id: "single", tools: [], maxRounds: 1, finishPolicy: "force-text" },
    });

    await runAgent(opts);

    const call = mockStream.mock.calls[0][0];
    expect(call.tools).toBeUndefined();
    // No forced-write injection for a toolless task — the seeded turns are untouched
    expect(opts.messages).toHaveLength(2);
  });

  it("passes extraBody (JSON mode) through to the streaming client", async () => {
    queueRound([{ text: "{}" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    const extraBody = { response_format: { type: "json_object" } };
    const opts = makeOptions({
      preset: { id: "json", tools: [], maxRounds: 1, finishPolicy: "force-text" },
      extraBody,
    });

    await runAgent(opts);

    expect(mockStream.mock.calls[0][0].extraBody).toBe(extraBody);
  });

  it("throws AbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const opts = makeOptions({ signal: controller.signal });

    await expect(runAgent(opts)).rejects.toMatchObject({ name: "AbortError" });
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("stops executing a round's remaining tool calls once aborted mid-round", async () => {
    // A round that narrates before calling two tools: onOutputText fires once
    // per streamed chunk, then once more to roll the display back to
    // committedText right before the tool-call loop starts — the exact window
    // between "tool calls decided" and "tools begin executing" where an abort
    // (e.g. one that just resolved a blocked approval via rejectAll) used to
    // go unnoticed until the *next* round.
    queueRound([
      { text: "我先去找文件列表。" },
      {
        toolCalls: [
          { index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" },
          { index: 1, id: "c2", name: "list_lore_entities", arguments: "{}" },
        ],
      },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    const controller = new AbortController();
    let rollbackSeen = false;
    const opts = makeOptions({
      signal: controller.signal,
      onOutputText: (t) => {
        // The rollback call passes exactly committedText ("" — nothing
        // committed yet); the streaming call passed the narration text.
        if (t === "" && !rollbackSeen) {
          rollbackSeen = true;
          controller.abort();
        }
      },
    });

    await expect(runAgent(opts)).rejects.toMatchObject({ name: "AbortError" });

    expect(rollbackSeen).toBe(true);
    // Neither tool call reached the executor — no tool-step events at all.
    expect(opts.events.some((e) => e.kind === "tool-step")).toBe(false);
  });

  it("asks onRoundLimit at the cap and continues with the granted rounds", async () => {
    // maxRounds 2: round 1 is a tool round, so entering round 2 (the would-be
    // forced wrap-up) triggers the question. Granting 2 raises the cap to 4;
    // round 2 keeps its tools and the model finishes on its own in round 3.
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    queueRound([
      { toolCalls: [{ index: 0, id: "c2", name: "list_lore_entities", arguments: "{}" }] },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    queueRound([{ text: "done" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    const asks: number[] = [];
    const opts = makeOptions({
      preset: { ...PRESET, maxRounds: 2 },
      onRoundLimit: async (roundsUsed) => {
        asks.push(roundsUsed);
        return 2;
      },
    });

    const result = await runAgent(opts);

    expect(asks).toEqual([1]);
    expect(result.rounds).toBe(3);
    expect(last(opts.output)).toBe("done");
    // Round 2 kept its tools — the forced-write instruction was never injected.
    expect(
      opts.messages.some((m) => String(m.content).includes("without calling any more tools")),
    ).toBe(false);
    expect(opts.events.filter((e) => e.kind === "round-limit")).toEqual([
      expect.objectContaining({ roundsUsed: 1, granted: 2 }),
    ]);
    // The raised cap is visible in the log from round 2 onwards.
    const starts = opts.events.filter(
      (e): e is Extract<AgentEvent, { kind: "round-start" }> => e.kind === "round-start",
    );
    expect(starts.map((e) => e.maxRounds)).toEqual([2, 4, 4]);
  });

  it("keeps the forced wrap-up when onRoundLimit declines", async () => {
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    queueRound([{ text: "forced" }, { done: true, inputTokens: 2, outputTokens: 2 }]);
    const opts = makeOptions({
      preset: { ...PRESET, maxRounds: 2 },
      onRoundLimit: async () => 0,
    });

    const result = await runAgent(opts);

    expect(result.rounds).toBe(2);
    expect(last(opts.output)).toBe("forced");
    // The declined final round is exactly today's behaviour: tools withheld,
    // write-now instruction injected.
    expect(mockStream.mock.calls[1][0].tools).toBeUndefined();
    expect(
      opts.messages.some((m) => String(m.content).includes("without calling any more tools")),
    ).toBe(true);
    expect(opts.events.filter((e) => e.kind === "round-limit")).toEqual([
      expect.objectContaining({ roundsUsed: 1, granted: 0 }),
    ]);
  });

  it("aborts cleanly when the run is stopped while the round-limit question is open", async () => {
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    const controller = new AbortController();
    const opts = makeOptions({
      signal: controller.signal,
      preset: { ...PRESET, maxRounds: 2 },
      // rejectAll drains a pending question by resolving 0 as the run aborts —
      // this models that: the abort lands before the "decision" resolves.
      onRoundLimit: async () => {
        controller.abort();
        return 0;
      },
    });

    await expect(runAgent(opts)).rejects.toMatchObject({ name: "AbortError" });
    // No round-limit event: the run aborted rather than the author deciding.
    expect(opts.events.some((e) => e.kind === "round-limit")).toBe(false);
  });
});

describe("trimHistory", () => {
  // read_lore_image (and any other vision tool) hands its result back as a
  // follow-up `role: "user"` message carrying an image_url part — OpenAI's
  // role:"tool" only allows string content. Those base64 payloads are
  // typically the single largest thing in a long run's history, so eliding
  // needs to reach them too, not just role:"tool" text results.
  function imageMessage(): StreamMessage {
    return {
      role: "user",
      content: [
        { type: "text", text: "Visual reference for read_lore_image:\nAva" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    };
  }

  it("elides an old image tool-result, not just role:\"tool\" text results", () => {
    const history: StreamMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" }, // seeded first turn — must never be touched
      imageMessage(),
    ];

    const dropped = trimHistory(history, 50);

    expect(dropped).toBe(1);
    expect(history[1].content).toBe("go"); // untouched
    expect(typeof history[2].content).toBe("string");
    expect(String(history[2].content)).not.toContain("data:image");
  });

  it("drops in oldest-first order across tool and image messages alike", () => {
    const history: StreamMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "tool", tool_call_id: "c1", content: "y".repeat(800) }, // ~200 tokens
      imageMessage(), // ~800 tokens fixed
    ];

    // Over budget, but dropping just the older tool result is enough.
    const dropped = trimHistory(history, 850);

    expect(dropped).toBe(1);
    expect(history[2].content).not.toBe("y".repeat(800));
    expect(Array.isArray(history[3].content)).toBe(true); // image untouched
  });

  it("does nothing when already within the ceiling", () => {
    const history: StreamMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      imageMessage(),
    ];

    expect(trimHistory(history, 100_000)).toBe(0);
    expect(Array.isArray(history[2].content)).toBe(true);
  });
});
