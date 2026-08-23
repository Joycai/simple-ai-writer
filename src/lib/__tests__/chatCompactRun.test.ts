import { describe, expect, it, vi } from "vitest";
import {
  COMPACT_TRIGGER,
  createSessionMeta,
  noteTurnStart,
  segmentHistory,
  type ChatSessionMeta,
} from "../agent/compact";
import { compactChatHistory } from "../agent/compactRun";
import { repairToolCallPairing } from "../agent/runtime";
import { estimateMessagesTokens } from "../ai/tokenEstimate";
import type { StreamMessage } from "../ai/types";

// The real i18n touches localStorage at import time; echo keys instead.
vi.mock("../../i18n", () => ({
  default: { t: (key: string, params?: Record<string, unknown>) =>
    params?.summary ? `[block] ${params.summary}` : key },
}));

const q = (text: string): StreamMessage => ({ role: "user", content: text });
const a = (text: string): StreamMessage => ({ role: "assistant", content: text });

/** A session big enough (CJK ≈ 1 token/char) to sit over the 0.70 trigger at 20k. */
function bigSession(): { history: StreamMessage[]; meta: ChatSessionMeta } {
  const meta = createSessionMeta();
  const seedMsg: StreamMessage = { role: "user", content: "seeded lore" };
  meta.seedContext = seedMsg;
  const history: StreamMessage[] = [{ role: "system", content: "sys" }, seedMsg];
  for (let i = 0; i < 6; i++) {
    const turn = [q(`q${i}` + "设".repeat(1500)), a(`a${i}` + "设".repeat(1500))];
    noteTurnStart(meta, turn[0]);
    history.push(...turn);
  }
  return { history, meta };
}

const CEILING = 20_000;

describe("compactChatHistory", () => {
  it("does nothing (and never summarizes) under the trigger", async () => {
    const meta = createSessionMeta();
    const t1 = q("hi");
    noteTurnStart(meta, t1);
    const history: StreamMessage[] = [{ role: "system", content: "sys" }, t1, a("hello")];
    const summarize = vi.fn();
    const out = await compactChatHistory({ history, meta, ceilingTokens: CEILING, summarize });
    expect(out).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("folds, swaps, and reports — leaving the original history untouched", async () => {
    const { history, meta } = bigSession();
    const before = [...history];
    const fromTokens = estimateMessagesTokens(history);
    expect(fromTokens).toBeGreaterThan(CEILING * COMPACT_TRIGGER);

    const summarize = vi.fn().mockResolvedValue("  作者在写第三章。  ");
    const out = await compactChatHistory({ history, meta, ceilingTokens: CEILING, summarize });

    expect(out).not.toBeNull();
    // The summarizer got the folded turns, not the whole session.
    expect(summarize).toHaveBeenCalledWith({
      prevSummary: null,
      rendered: expect.stringContaining("[user] q0"),
    });
    expect(summarize.mock.calls[0][0].rendered).not.toContain("q5");

    // The original array is intact — swap happens by replacement, not mutation.
    expect(history).toEqual(before);

    // The rebuilt history: system, summary block, kept turns; pairing valid.
    expect(out!.history[0].role).toBe("system");
    expect(out!.history[1].content).toBe("[block] 作者在写第三章。");
    expect(out!.history.some((m) => m.content === "seeded lore")).toBe(false);
    expect(repairToolCallPairing(out!.history)).toBe(0);

    // Event: audited numbers plus the summary for the log's expanded detail.
    expect(out!.event).toMatchObject({
      kind: "context-compacted",
      summary: "作者在写第三章。",
    });
    if (out!.event.kind !== "context-compacted") throw new Error("unreachable");
    expect(out!.event.foldedTurns).toBeGreaterThan(0);
    expect(out!.event.toTokens).toBeLessThan(out!.event.fromTokens);
    expect(out!.event.fromTokens).toBe(fromTokens);

    // Meta now describes the rebuilt history.
    expect(meta.summaryText).toBe("作者在写第三章。");
    expect(meta.seedContext).toBeNull();
    expect(segmentHistory(out!.history, meta).turns.length).toBe(
      6 - out!.event.foldedTurns,
    );
  });

  it("feeds the previous summary back into the next compaction", async () => {
    const { history, meta } = bigSession();
    const summarize = vi.fn().mockResolvedValue("第一次摘要");
    const first = await compactChatHistory({ history, meta, ceilingTokens: CEILING, summarize });
    expect(first).not.toBeNull();

    // Grow the compacted session past the trigger again.
    const next = first!.history;
    for (let i = 6; i < 12; i++) {
      const turn = [q(`q${i}` + "设".repeat(1500)), a(`a${i}` + "设".repeat(1500))];
      noteTurnStart(meta, turn[0]);
      next.push(...turn);
    }
    const again = await compactChatHistory({
      history: next, meta, ceilingTokens: CEILING,
      summarize: summarize.mockResolvedValue("合并后的摘要"),
    });
    expect(again).not.toBeNull();
    expect(summarize).toHaveBeenLastCalledWith(
      expect.objectContaining({ prevSummary: "第一次摘要" }),
    );
    // One summary message, replaced rather than stacked.
    expect(
      again!.history.filter(
        (m) => typeof m.content === "string" && m.content.startsWith("[block]"),
      ),
    ).toHaveLength(1);
    expect(again!.history[1].content).toBe("[block] 合并后的摘要");
  });

  it("skips compaction when the summarizer fails, leaving the session as-is", async () => {
    const { history, meta } = bigSession();
    const before = [...history];
    const turnStartsBefore = [...meta.turnStarts];

    const out = await compactChatHistory({
      history, meta, ceilingTokens: CEILING,
      summarize: vi.fn().mockRejectedValue(new Error("HTTP 500")),
    });
    expect(out).toBeNull();
    expect(history).toEqual(before);
    expect(meta.summaryText).toBeNull();
    expect(meta.seedContext).not.toBeNull();
    expect(meta.turnStarts).toEqual(turnStartsBefore);
  });

  it("treats an empty summary as a failure, not a fold", async () => {
    const { history, meta } = bigSession();
    const out = await compactChatHistory({
      history, meta, ceilingTokens: CEILING,
      summarize: vi.fn().mockResolvedValue("   "),
    });
    expect(out).toBeNull();
    expect(meta.seedContext).not.toBeNull();
  });

  it("force compacts a session the trigger would have left alone", async () => {
    const meta = createSessionMeta();
    const history: StreamMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 4; i++) {
      const turn = [q(`q${i}`), a(`a${i}`)];
      noteTurnStart(meta, turn[0]);
      history.push(...turn);
    }
    const summarize = vi.fn().mockResolvedValue("手动归纳的摘要");
    expect(
      await compactChatHistory({ history, meta, ceilingTokens: CEILING, summarize }),
    ).toBeNull();

    const out = await compactChatHistory({
      history, meta, ceilingTokens: CEILING, force: true, summarize,
    });
    expect(out).not.toBeNull();
    expect(out!.history[1].content).toBe("[block] 手动归纳的摘要");
    // Maximal fold: only the verbatim floor survives.
    expect(segmentHistory(out!.history, meta).turns.length).toBe(2);
  });

  it("propagates an abort — the author cancelled the send itself", async () => {
    const { history, meta } = bigSession();
    await expect(
      compactChatHistory({
        history, meta, ceilingTokens: CEILING,
        summarize: vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")),
      }),
    ).rejects.toThrow("Aborted");
    expect(meta.summaryText).toBeNull();
  });
});
