/**
 * A session blob outlives the code that wrote it, so an event payload is
 * effectively a wire format. `round-limit` carried `granted: number` until
 * 1.13 gave the round cap a third answer (存盘暂停) and made it a union — and a
 * stale row reaching the renderer as `event.decision.action` took the whole AI
 * drawer down through the error boundary, just from opening an old chat.
 */
import { describe, expect, it } from "vitest";
import { deserializeChatSession } from "../agent/chatSession";

const blob = (log: unknown[]) =>
  JSON.stringify({
    v: 1,
    turns: [{ id: "t1", role: "assistant", text: "hi", log, at: 1 }],
    history: [{ role: "user", content: "hi" }],
    meta: { seedContext: -1, summary: -1, summaryText: null, turnStarts: [], injected: [] },
    usage: null,
  });

const logOf = (json: string) =>
  deserializeChatSession(json)!.turns[0].log as unknown as Record<string, unknown>[];

describe("chat session log migration", () => {
  it("turns a pre-1.13 granted>0 into an extend decision", () => {
    const log = logOf(blob([{ kind: "round-limit", roundsUsed: 8, granted: 20, at: 1 }]));
    expect(log[0].decision).toEqual({ action: "extend", rounds: 20 });
    expect(log[0].roundsUsed).toBe(8);
  });

  it("turns a pre-1.13 granted:0 into finish — 0 meant 'wrap up now'", () => {
    const log = logOf(blob([{ kind: "round-limit", roundsUsed: 8, granted: 0, at: 1 }]));
    expect(log[0].decision).toEqual({ action: "finish" });
  });

  it("leaves a current-shape decision alone, pause included", () => {
    const log = logOf(blob([
      { kind: "round-limit", roundsUsed: 3, decision: { action: "pause" }, at: 1 },
    ]));
    expect(log[0].decision).toEqual({ action: "pause" });
  });

  it("drops junk entries rather than failing the whole session", () => {
    // One unreadable line of history is worth losing; a session is not.
    const log = logOf(blob([null, "nonsense", { noKind: true }, { kind: "run-done", at: 1 }]));
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("run-done");
  });

  it("survives a turn whose log is not an array at all", () => {
    const snap = deserializeChatSession(
      JSON.stringify({
        v: 1,
        turns: [{ id: "t1", role: "assistant", text: "hi", log: "corrupt", at: 1 }],
        history: [],
        meta: { seedContext: -1, summary: -1, summaryText: null, turnStarts: [], injected: [] },
        usage: null,
      }),
    );
    expect(snap).not.toBeNull();
    expect(snap!.turns[0].log).toEqual([]);
  });
});
