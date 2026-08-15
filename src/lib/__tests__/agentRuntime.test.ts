/**
 * Agent runtime tests — the tool loop with a mocked streaming client.
 * Verifies event emission (execution log), the tool-call/result message
 * protocol, per-preset round caps, and the force-text final round.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import type { StreamOptions } from "../ai/types";
import type { AgentEvent } from "../agent/events";
import type { TaskPreset } from "../agent/presets";
import { repairToolCallPairing, runAgent, trimHistory, type AgentRuntimeOptions } from "../agent/runtime";
import { appendAgentEventTo } from "../agent/events";
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

/**
 * What each round actually sent. The runtime mutates one history array in
 * place, so anything read after the run is the *final* state — which is a
 * different question from "what did round N ask for".
 */
const sent: StreamMessage[][] = [];

/** Queue one streamCompletion round: emits the given chunks, resolves. */
function queueRound(chunks: Array<Record<string, unknown>>): void {
  mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
    sent.push([...opts.messages]);
    for (const c of chunks) opts.onChunk(c as never);
  });
}

/** The round-cap nudge, resolved through i18n like the runtime resolves it. */
const CAP_NUDGE = i18n.t("ai.instructions.roundCapReached");

beforeEach(() => {
  mockStream.mockReset();
  sent.length = 0;
});

/** The run's output: the final snapshot. (`Array.at` postdates the TS target.) */
const last = (snapshots: string[]) => snapshots[snapshots.length - 1];

describe("runAgent", () => {
  it("finishes on a text-only round and reports usage", async () => {
    queueRound([{ text: "hello " }, { text: "world" }, { done: true, inputTokens: 10, outputTokens: 5 }]);
    const opts = makeOptions();

    const result = await runAgent(opts);

    expect(result).toEqual({ rounds: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, outcome: "completed" });
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
    // The narration is also absent from the transcript: only the round-2 reply
    // lands as assistant text.
    const assistantTexts = opts.messages.filter(
      (m) => m.role === "assistant" && typeof m.content === "string",
    );
    expect(assistantTexts).toEqual([{ role: "assistant", content: "**未提及**\n- 权限接口" }]);
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

    expect(result).toEqual({ rounds: 2, inputTokens: 28, outputTokens: 9, cachedTokens: 0, outcome: "completed" });

    // Event order: round 1, tool running, tool done, round 2
    expect(opts.events.map((e) => e.kind)).toEqual([
      "round-start", "tool-step", "tool-step", "round-start",
    ]);
    const doneStep = opts.events[2] as Extract<AgentEvent, { kind: "tool-step" }>;
    expect(doneStep.step.status).toBe("done");
    expect(doneStep.step.resultSummary).toContain("Ava");

    // History protocol: assistant tool_calls + matching tool result + the
    // final reply itself. `history` IS the chat session's transcript — a
    // reply that only reached the screen left the next turn's model blind to
    // what it had just said.
    const history = opts.messages;
    expect(history).toHaveLength(5);
    const assistant = history[2] as { role: string; tool_calls: Array<{ id: string }> };
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls[0].id).toBe("c1");
    const toolMsg = history[3] as { role: string; tool_call_id: string; content: string };
    expect(toolMsg).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(toolMsg.content).toContain("Ava");
    expect(history[4]).toEqual({ role: "assistant", content: "done" });

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

    expect(result).toEqual({ rounds: 2, inputTokens: 28, outputTokens: 9, cachedTokens: 20, outcome: "completed" });
  });

  it("says so in the log when the endpoint cut the output short", async () => {
    // The symptom this exists for: an answer that stops mid-sentence looks
    // exactly like one the model chose to end, and the fix (raise max-output)
    // is invisible without being told.
    queueRound([
      { text: "半句话就没" },
      { done: true, inputTokens: 5, outputTokens: 5, truncated: true, stopReason: "max_tokens" },
    ]);
    const opts = makeOptions();

    await runAgent(opts);

    expect(opts.events).toContainEqual(
      expect.objectContaining({ kind: "output-truncated", round: 1, stopReason: "max_tokens" }),
    );
    // The text that did arrive is still the run's output — truncated, not lost.
    expect(last(opts.output)).toBe("半句话就没");
  });

  it("stays quiet about truncation when the model finished on its own", async () => {
    queueRound([{ text: "写完了" }, { done: true, inputTokens: 5, outputTokens: 5 }]);
    const opts = makeOptions();

    await runAgent(opts);

    expect(opts.events.some((e) => e.kind === "output-truncated")).toBe(false);
  });

  it("withholds the endpoint's own tools alongside ours, not just ours", async () => {
    // A server tool arrives from the model's configuration rather than from the
    // preset, so it used to sail past the withhold check: the forced final
    // round handed the model a live web search while instructing it to stop
    // calling tools — and a search there restarts the search-and-resume cycle
    // inside the round whose only job was to end it.
    queueRound([{ toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      { done: true, inputTokens: 1, outputTokens: 1 }]);
    queueRound([{ text: "写完了" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    const opts = makeOptions({
      preset: { ...PRESET, maxRounds: 2 },
      serverTools: ["web_search"],
    });

    await runAgent(opts);

    // Round 1 is a normal tool round: both sets available.
    expect(mockStream.mock.calls[0][0].serverTools).toEqual(["web_search"]);
    expect(mockStream.mock.calls[0][0].tools).toBeDefined();
    // Round 2 is the forced wrap-up: neither is.
    expect(mockStream.mock.calls[1][0].tools).toBeUndefined();
    expect(mockStream.mock.calls[1][0].serverTools).toBeUndefined();
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
    // The "write now" instruction was injected before the request…
    const asked = sent[0][sent[0].length - 1];
    expect(asked.role).toBe("user");
    expect(String(asked.content)).toBe(CAP_NUDGE);
    // …and retracted after it. Chat reuses this array for every later turn, so
    // leaving it in is a standing "never use tools again" the author cannot see.
    expect(opts.messages.some((m) => String(m.content) === CAP_NUDGE)).toBe(false);
  });

  it("sends no tool definitions for an empty (single-shot) toolset", async () => {
    queueRound([{ text: "plain" }, { done: true, inputTokens: 2, outputTokens: 2 }]);
    const opts = makeOptions({
      preset: { id: "single", tools: [], maxRounds: 1, finishPolicy: "force-text" },
    });

    await runAgent(opts);

    const call = mockStream.mock.calls[0][0];
    expect(call.tools).toBeUndefined();
    // No forced-write injection for a toolless task — the seeded turns gain
    // only the reply itself.
    expect(opts.messages).toHaveLength(3);
    expect(opts.messages[2]).toEqual({ role: "assistant", content: "plain" });
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

  it("commits the streamed prose to history when stopped mid-answer", async () => {
    // The partial text stays on screen after a 停止, so it must also stay in
    // the transcript — otherwise the next turn's model never saw the words the
    // author is replying to.
    const ctrl = new AbortController();
    mockStream.mockImplementationOnce(async (streamOpts: StreamOptions) => {
      sent.push([...streamOpts.messages]);
      streamOpts.onChunk({ text: "写到一半" } as never);
      throw new DOMException("Aborted", "AbortError");
    });
    const opts = makeOptions({ signal: ctrl.signal });

    await expect(runAgent(opts)).rejects.toMatchObject({ name: "AbortError" });

    expect(opts.messages[opts.messages.length - 1]).toEqual({
      role: "assistant",
      content: "写到一半",
    });
  });

  it("adds no assistant message for a round of pure whitespace", async () => {
    // Anthropic rejects empty content blocks, so a blank reply must not leave
    // a blank assistant message behind in a persistent history.
    queueRound([{ text: "  \n" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    const opts = makeOptions();

    await runAgent(opts);

    expect(opts.messages.some((m) => m.role === "assistant")).toBe(false);
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
        return { action: "extend", rounds: 2 };
      },
    });

    const result = await runAgent(opts);

    expect(asks).toEqual([1]);
    expect(result.rounds).toBe(3);
    expect(result.outcome).toBe("completed");
    expect(last(opts.output)).toBe("done");
    // Round 2 kept its tools — the forced-write instruction was never injected.
    expect(sent.some((round) => round.some((m) => String(m.content) === CAP_NUDGE))).toBe(false);
    expect(opts.events.filter((e) => e.kind === "round-limit")).toEqual([
      expect.objectContaining({ roundsUsed: 1, decision: { action: "extend", rounds: 2 } }),
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
      onRoundLimit: async () => ({ action: "finish" }),
    });

    const result = await runAgent(opts);

    expect(result.rounds).toBe(2);
    expect(result.outcome).toBe("completed");
    expect(last(opts.output)).toBe("forced");
    // The declined final round is exactly today's behaviour: tools withheld,
    // write-now instruction injected.
    expect(mockStream.mock.calls[1][0].tools).toBeUndefined();
    expect(sent[1].some((m) => String(m.content) === CAP_NUDGE)).toBe(true);
    // But not left behind for the next turn to inherit.
    expect(opts.messages.some((m) => String(m.content) === CAP_NUDGE)).toBe(false);
    expect(opts.events.filter((e) => e.kind === "round-limit")).toEqual([
      expect.objectContaining({ roundsUsed: 1, decision: { action: "finish" } }),
    ]);
  });

  it("carries a thinking model's reasoning into the next round's history", async () => {
    // Endpoints whose models think before calling a tool reject a history that
    // has dropped that reasoning — so losing it here doesn't degrade the
    // answer, it makes round 2 fail outright and the loop can never finish.
    queueRound([
      { reasoning: "I should look at the lore first" },
      {
        toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }],
        _reasoning: { field: "reasoning_content", text: "I should look at the lore first" },
      },
    ]);
    queueRound([{ text: "done" }, { done: true, inputTokens: 1, outputTokens: 1 }]);

    await runAgent(makeOptions());

    const assistant = sent[1].find((m) => m.role === "assistant" && "tool_calls" in m);
    expect(assistant).toMatchObject({
      _reasoning: { field: "reasoning_content", text: "I should look at the lore first" },
    });
  });

  it("leaves the assistant message alone when no reasoning arrived", async () => {
    // Endpoints that send none — OpenAI's own among them — must keep producing
    // exactly the history they produced before this existed.
    queueRound([{ toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] }]);
    queueRound([{ text: "done" }, { done: true, inputTokens: 1, outputTokens: 1 }]);

    await runAgent(makeOptions());

    const assistant = sent[1].find((m) => m.role === "assistant" && "tool_calls" in m)!;
    expect((assistant as { _reasoning?: unknown })._reasoning).toBeUndefined();
  });

  it("reports thinking as one growing log entry, not one per fragment", async () => {
    // Reasoning streams. A log line per fragment would be unreadable, so the
    // event is re-emitted for the same round and replaces its predecessor.
    queueRound([
      { reasoning: "first " },
      { reasoning: "second" },
      { text: "done" },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    const opts = makeOptions();

    await runAgent(opts);

    const live = opts.events.filter((e) => e.kind === "reasoning");
    expect(live.map((e) => (e as { text: string }).text)).toEqual([
      "first ", "first second", "first second",
    ]);
    // Folded through the log helper, they collapse to a single row.
    const folded = live.reduce(appendAgentEventTo, [] as AgentEvent[]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ kind: "reasoning", text: "first second", done: true });
  });

  it("marks thinking finished as soon as the answer starts", async () => {
    // Not at round end: on a text round the answer streams for a while after,
    // and the log would show a spinner while prose is visibly arriving.
    queueRound([
      { reasoning: "pondering" },
      { text: "the answer" },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    const opts = makeOptions();

    await runAgent(opts);

    const kinds = opts.events.map((e) => e.kind);
    const doneAt = opts.events.findIndex((e) => e.kind === "reasoning" && (e as { done: boolean }).done);
    expect(doneAt).toBeGreaterThanOrEqual(0);
    // …and it carries how long the thinking took.
    expect((opts.events[doneAt] as { elapsedMs?: number }).elapsedMs).toBeGreaterThanOrEqual(0);
    expect(kinds).toContain("reasoning");
  });

  it("closes out thinking on a tool round that never produced prose", async () => {
    // Otherwise the row is stranded mid-spin for the rest of the run.
    queueRound([
      { reasoning: "I should look this up" },
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
    ]);
    queueRound([{ text: "done" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    const opts = makeOptions();

    await runAgent(opts);

    const first = opts.events.filter(
      (e) => e.kind === "reasoning" && (e as { round: number }).round === 1,
    );
    expect((first[first.length - 1] as { done: boolean }).done).toBe(true);
  });

  it("emits nothing at all for a model that exposes no reasoning", async () => {
    queueRound([{ text: "plain" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    const opts = makeOptions();

    await runAgent(opts);

    expect(opts.events.some((e) => e.kind === "reasoning")).toBe(false);
  });

  it("answers every tool_call even when stopped part-way through a round", async () => {
    // `history` IS the chat session's history. Stopping after k of N tool
    // calls left an assistant tool_calls message missing replies, and every
    // provider rejects that — so one press of 停止 killed the conversation
    // permanently, with 新建对话 the only way out.
    const ctrl = new AbortController();
    queueRound([
      { toolCalls: [
        { index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" },
        { index: 1, id: "c2", name: "list_lore_entities", arguments: "{}" },
        { index: 2, id: "c3", name: "list_lore_entities", arguments: "{}" },
      ] },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    const opts = makeOptions({ signal: ctrl.signal });
    // Abort as soon as the first tool result lands.
    const originalEvent = opts.onEvent;
    opts.onEvent = (e) => {
      originalEvent(e);
      if (e.kind === "tool-step" && e.step.status === "done") ctrl.abort();
    };

    await expect(runAgent(opts)).rejects.toMatchObject({ name: "AbortError" });

    const calls = opts.messages.flatMap((m) =>
      m.role === "assistant" && "tool_calls" in m ? m.tool_calls.map((tc) => tc.id) : []);
    const replies = opts.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
    expect(calls).toEqual(["c1", "c2", "c3"]);
    expect(replies.sort()).toEqual(["c1", "c2", "c3"]);
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
        return { action: "finish" };
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

  it("keeps the words of the message it takes the picture out of", () => {
    // The author's own attachments ride on their question, which is a turn
    // boundary the compaction pass segments on. Replacing the whole content
    // with a note threw away what was asked while keeping the answer.
    const question: StreamMessage = {
      role: "user",
      content: [
        { type: "text", text: "这件外套什么颜色" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    };
    const history: StreamMessage[] = [{ role: "system", content: "sys" }, question];

    trimHistory(history, 50);

    expect(history[1].content).toContain("这件外套什么颜色");
    expect(String(history[1].content)).not.toContain("data:image");
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

  it("caps how many pictures stay in history however big the ceiling is", () => {
    // The token estimate charges a flat rate per image, because that is what a
    // provider bills — but the payload is base64, and chat history persists
    // across turns. Under the token check alone the estimate stayed
    // comfortably under the ceiling while the request body grew without bound.
    const history: StreamMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      ...Array.from({ length: 6 }, imageMessage),
    ];

    const dropped = trimHistory(history, 100_000);

    expect(dropped).toBe(3);
    const kept = history.filter((m) => Array.isArray(m.content));
    expect(kept).toHaveLength(3);
    // The newest three survive — the ones the model is most likely to mean.
    expect(history.slice(-3).every((m) => Array.isArray(m.content))).toBe(true);
  });

  it("trims nothing but images when no ceiling is configured", () => {
    // `Model.contextSize` is optional, and a 0/undefined ceiling used to make
    // this a complete no-op.
    const history: StreamMessage[] = [
      { role: "tool", tool_call_id: "c1", content: "y".repeat(4000) },
      ...Array.from({ length: 5 }, imageMessage),
    ];

    expect(trimHistory(history, undefined)).toBe(2);
    expect(history[0].content).toBe("y".repeat(4000));
  });
});

describe("repairToolCallPairing", () => {
  it("fills in the replies a stopped run never produced", () => {
    const history: StreamMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "list_files", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ];

    expect(repairToolCallPairing(history)).toBe(1);
    const replies = history.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(replies.sort()).toEqual(["c1", "c2"]);
  });

  it("leaves a well-formed history alone", () => {
    const history: StreamMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "list_files", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ];
    const before = history.length;

    expect(repairToolCallPairing(history)).toBe(0);
    expect(history).toHaveLength(before);
  });
});
