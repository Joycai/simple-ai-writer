import { describe, expect, it } from "vitest";
import {
  COMPACT_TRIGGER,
  FOLD_RESULT_CLIP,
  MIN_KEEP_TURNS,
  RETAIN_TARGET,
  SUMMARY_BUDGET_TOKENS,
  buildCompactedHistory,
  createSessionMeta,
  noteTurnStart,
  planFold,
  renderTurnsForSummary,
  segmentHistory,
  type ChatSessionMeta,
} from "../agent/compact";
import { repairToolCallPairing } from "../agent/runtime";
import { estimateMessagesTokens } from "../ai/tokenEstimate";
import type { StreamMessage } from "../ai/types";

/** A chat session: [system, seed?, q1, a1, q2, a2, …] with meta kept in step. */
function makeSession(opts: {
  seed?: string;
  turns: StreamMessage[][];
}): { history: StreamMessage[]; meta: ChatSessionMeta } {
  const meta = createSessionMeta();
  const history: StreamMessage[] = [{ role: "system", content: "system prompt" }];
  if (opts.seed) {
    const seedMsg: StreamMessage = { role: "user", content: opts.seed };
    meta.seedContext = seedMsg;
    history.push(seedMsg);
  }
  for (const turn of opts.turns) {
    noteTurnStart(meta, turn[0]);
    history.push(...turn);
  }
  return { history, meta };
}

const q = (text: string): StreamMessage => ({ role: "user", content: text });
const a = (text: string): StreamMessage => ({ role: "assistant", content: text });
const toolCall = (id: string, name: string, args = "{}"): StreamMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
});
const toolReply = (id: string, content: string): StreamMessage => ({
  role: "tool",
  tool_call_id: id,
  content,
});

describe("segmentHistory", () => {
  it("splits at the recorded question messages, prelude before the first", () => {
    const { history, meta } = makeSession({
      seed: "【当前知识】…",
      turns: [
        [q("q1"), a("a1")],
        [q("q2"), toolCall("c1", "read_file"), toolReply("c1", "chapter text"), a("a2")],
      ],
    });
    const { prelude, turns } = segmentHistory(history, meta);
    expect(prelude.map((m) => m.role)).toEqual(["system", "user"]);
    expect(turns).toHaveLength(2);
    expect(turns[0].messages).toHaveLength(2);
    // The tool pair stays inside its turn.
    expect(turns[1].messages.map((m) => m.role)).toEqual([
      "user", "assistant", "tool", "assistant",
    ]);
  });

  it("keeps repair stubs inside the turn they were spliced into", () => {
    const { history, meta } = makeSession({
      turns: [
        // A turn that was aborted between the call and its reply.
        [q("q1"), toolCall("c1", "read_file")],
        [q("q2"), a("a2")],
      ],
    });
    expect(repairToolCallPairing(history)).toBe(1);
    const { turns } = segmentHistory(history, meta);
    expect(turns[0].messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(turns[1].messages).toHaveLength(2);
  });

  it("ignores recorded starts that are no longer in the history", () => {
    const { history, meta } = makeSession({ turns: [[q("q1"), a("a1")], [q("q2")]] });
    // Simulate an already-folded first turn.
    history.splice(1, 2);
    const { turns } = segmentHistory(history, meta);
    expect(turns).toHaveLength(1);
    expect(turns[0].start.content).toBe("q2");
  });
});

describe("planFold", () => {
  // ~1 token/char via CJK; big enough that per-message overhead is noise.
  const cjkBlock = (n: number) => "设".repeat(n);

  it("returns null under the trigger", () => {
    const { history, meta } = makeSession({
      turns: [[q("hi"), a("hello")], [q("more"), a("sure")]],
    });
    expect(planFold(history, meta, 100_000)).toBeNull();
  });

  it("returns null when only MIN_KEEP_TURNS turns exist, however large", () => {
    const { history, meta } = makeSession({
      turns: [
        [q(cjkBlock(3000)), a(cjkBlock(3000))],
        [q(cjkBlock(3000)), a(cjkBlock(3000))],
      ],
    });
    expect(estimateMessagesTokens(history)).toBeGreaterThan(10_000 * COMPACT_TRIGGER);
    expect(planFold(history, meta, 10_000)).toBeNull();
  });

  it("folds oldest-first down to the retain target and drops the seed", () => {
    const turns: StreamMessage[][] = Array.from({ length: 6 }, (_, i) => [
      q(`q${i}` + cjkBlock(1500)),
      a(`a${i}` + cjkBlock(1500)),
    ]);
    const { history, meta } = makeSession({ seed: cjkBlock(2000), turns });
    const ceiling = 20_000; // est ≈ 20k > 14k trigger
    const plan = planFold(history, meta, ceiling);
    expect(plan).not.toBeNull();
    expect(plan!.dropSeed).toBe(true);
    expect(plan!.fold.length).toBeGreaterThan(0);
    expect(plan!.keep.length).toBeGreaterThanOrEqual(MIN_KEEP_TURNS);
    // Oldest fold, newest keep, nothing lost.
    expect(plan!.fold[0].start.content).toContain("q0");
    expect(plan!.keep[plan!.keep.length - 1].start.content).toContain("q5");
    expect(plan!.fold.length + plan!.keep.length).toBe(6);
    expect(plan!.projectedTokens).toBeLessThanOrEqual(ceiling * RETAIN_TARGET);
    // It kept as much as the target allows — folding one fewer would overflow.
    const oneLess =
      plan!.projectedTokens +
      estimateMessagesTokens(plan!.fold[plan!.fold.length - 1].messages);
    expect(oneLess).toBeGreaterThan(ceiling * RETAIN_TARGET);
  });

  it("falls back to the maximum fold when even that misses the target", () => {
    const { history, meta } = makeSession({
      turns: [
        [q(cjkBlock(1000)), a(cjkBlock(1000))],
        [q(cjkBlock(8000)), a(cjkBlock(8000))],
        [q(cjkBlock(8000)), a(cjkBlock(8000))],
      ],
    });
    const plan = planFold(history, meta, 20_000);
    expect(plan).not.toBeNull();
    // Only the first turn is foldable; the projection still exceeds the target.
    expect(plan!.fold).toHaveLength(1);
    expect(plan!.keep).toHaveLength(MIN_KEEP_TURNS);
    expect(plan!.projectedTokens).toBeGreaterThan(20_000 * RETAIN_TARGET);
  });
});

describe("renderTurnsForSummary", () => {
  it("clips tool traffic, keeps prose, marks images", () => {
    const { history, meta } = makeSession({
      turns: [[
        q("介绍一下主角"),
        toolCall("c1", "read_lore_entity", `{"name":"梅莉","detail":"${"x".repeat(400)}"}`),
        toolReply("c1", "梅".repeat(500)),
        {
          role: "user",
          content: [
            { type: "text", text: "(image attached)" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
        a("她是一位魔法少女。"),
      ]],
    });
    const out = renderTurnsForSummary(segmentHistory(history, meta).turns);
    const lines = out.split("\n");
    expect(lines[0]).toBe("[user] 介绍一下主角");
    expect(lines[1]).toContain("[tool call] read_lore_entity");
    expect(lines[1].length).toBeLessThanOrEqual("[tool call] read_lore_entity ".length + FOLD_RESULT_CLIP + 1);
    expect(lines[2]).toContain("[tool result]");
    expect(lines[2]).toContain("…");
    expect(lines[3]).toBe("[user] (image attached) [image]");
    expect(lines[4]).toBe("[assistant] 她是一位魔法少女。");
    // No base64 leaks into the summarizer input.
    expect(out).not.toContain("base64");
  });
});

describe("buildCompactedHistory", () => {
  it("rebuilds as system + summary + kept turns and updates the meta", () => {
    const turns: StreamMessage[][] = Array.from({ length: 5 }, (_, i) => [
      q(`q${i}` + "设".repeat(2000)),
      a(`a${i}` + "设".repeat(2000)),
    ]);
    const { history, meta } = makeSession({ seed: "seeded lore", turns });
    const plan = planFold(history, meta, 20_000)!;
    expect(plan).not.toBeNull();

    const next = buildCompactedHistory(history, meta, plan, "【历史摘要】…");
    expect(next).not.toBe(history); // new array — swap-on-success atomicity
    expect(next[0].role).toBe("system");
    expect(next[1]).toEqual({ role: "user", content: "【历史摘要】…" });
    // Seed block and folded turns are gone; kept turns are verbatim tail.
    expect(next.some((m) => m.content === "seeded lore")).toBe(false);
    expect(next.slice(2)).toEqual(plan.keep.flatMap((t) => t.messages));

    expect(meta.seedContext).toBeNull();
    expect(meta.summary).toBe(next[1]);
    expect(meta.turnStarts).toEqual(plan.keep.map((t) => t.start));

    // A second compaction replaces the summary message rather than stacking.
    const again = buildCompactedHistory(
      next,
      meta,
      { fold: [], keep: segmentHistory(next, meta).turns, dropSeed: false, projectedTokens: 0 },
      "newer summary",
    );
    expect(again.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("summary"))).toHaveLength(1);
    expect(again[1].content).toBe("newer summary");
  });

  it("never splits an assistant call from its tool reply", () => {
    const turns: StreamMessage[][] = Array.from({ length: 4 }, (_, i) => [
      q(`q${i}` + "设".repeat(1500)),
      toolCall(`c${i}`, "read_file", `{"path":"ch${i}.md"}`),
      toolReply(`c${i}`, "设".repeat(1500)),
      a(`a${i}`),
    ]);
    const { history, meta } = makeSession({ turns });
    const plan = planFold(history, meta, 12_000)!;
    const next = buildCompactedHistory(history, meta, plan, "s");
    // Pairing is intact by construction — the repairer finds nothing to add.
    expect(repairToolCallPairing(next)).toBe(0);
    for (const m of next) {
      if (m.role === "tool") {
        const idx = next.indexOf(m);
        const prev = next[idx - 1];
        expect(prev.role === "assistant" || prev.role === "tool").toBe(true);
      }
    }
  });
});

describe("constants", () => {
  it("leaves a wide gap between trigger and retain target", () => {
    expect(COMPACT_TRIGGER - RETAIN_TARGET).toBeGreaterThanOrEqual(0.2);
    expect(SUMMARY_BUDGET_TOKENS).toBeGreaterThan(0);
  });
});
