/**
 * 状态记忆（SKILL.state 模式）：schema 校验、每轮折叠、与普通归纳的接手。
 * docs/feature/agent/skill-state-memory-plan.md
 */
import { describe, expect, it, vi } from "vitest";
import {
  MIN_KEEP_TURNS,
  createSessionMeta,
  noteTurnStart,
  planFold,
  segmentHistory,
  type ChatSessionMeta,
} from "../agent/compact";
import { compactChatHistory } from "../agent/compactRun";
import { computeContextBreakdown } from "../agent/contextBreakdown";
import { repairToolCallPairing } from "../agent/runtime";
import {
  STATE_CAPS,
  STATE_KEEP_TURNS,
  emptySkillState,
  isEmptyState,
  parseSkillState,
  renderStateBlock,
  stateJson,
  validateSkillState,
  type SkillState,
} from "../agent/skillState";
import { updateSkillState } from "../agent/skillStateRun";
import { deserializeChatSession, serializeChatSession } from "../agent/chatSession";
import type { StreamMessage } from "../ai/types";

// The real i18n touches localStorage at import time; echo keys instead.
vi.mock("../../i18n", () => ({
  default: {
    t: (key: string, params?: Record<string, unknown>) =>
      params?.summary ? `[block] ${params.summary}` : key,
  },
}));

const q = (text: string): StreamMessage => ({ role: "user", content: text });
const a = (text: string): StreamMessage => ({ role: "assistant", content: text });
const toolCall = (id: string, name: string): StreamMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
});
const toolReply = (id: string, content: string): StreamMessage => ({
  role: "tool", tool_call_id: id, content,
});

function session(turns: StreamMessage[][], seed?: string): {
  history: StreamMessage[]; meta: ChatSessionMeta;
} {
  const meta = createSessionMeta();
  const history: StreamMessage[] = [{ role: "system", content: "sys" }];
  if (seed) {
    const seedMsg = q(seed);
    meta.seedContext = seedMsg;
    history.push(seedMsg);
  }
  for (const turn of turns) {
    noteTurnStart(meta, turn[0]);
    history.push(...turn);
  }
  return { history, meta };
}

const GOOD: SkillState = {
  goal: "把第三章的结尾改得更克制",
  decisions: ["不用感叹号", "保留雨夜的意象"],
  facts: ["艾尔登的剑叫「霜语」（lore/characters/艾尔登）"],
  progress: [{ step: "读第三章结尾", status: "done" }, { step: "改写最后两段", status: "doing" }],
  files: [{ path: "第三章.md", note: "结尾待改" }],
  open: ["要不要提前点出信的内容"],
  last: "读完了结尾，给出了两个改法",
};

describe("validateSkillState", () => {
  it("accepts a well-formed state unchanged", () => {
    const out = validateSkillState(GOOD);
    expect(out).toEqual({ ok: true, clipped: false, state: GOOD });
  });

  it("treats absent lists and strings as empty rather than refusing", () => {
    const out = validateSkillState({ goal: "x" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.state).toEqual({ ...emptySkillState(), goal: "x" });
  });

  it("refuses shape errors with a message the model can act on", () => {
    expect(validateSkillState(null)).toMatchObject({ ok: false });
    expect(validateSkillState([])).toMatchObject({ ok: false });
    expect(validateSkillState({ goal: 3 })).toMatchObject({ ok: false, error: expect.stringContaining("goal") });
    expect(validateSkillState({ facts: "one" })).toMatchObject({ ok: false, error: expect.stringContaining("facts") });
    expect(validateSkillState({ facts: ["a", 2] })).toMatchObject({ ok: false });
    expect(validateSkillState({ progress: [{ step: "s", status: "later" }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("status") });
    expect(validateSkillState({ files: [{ note: "no path" }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("path") });
  });

  it("clips over-long items and over-long lists instead of refusing — the state stays bounded", () => {
    const out = validateSkillState({
      goal: "长".repeat(STATE_CAPS.goal + 50),
      facts: Array.from({ length: STATE_CAPS.facts.items + 5 }, (_, i) => `f${i}`),
      progress: Array.from({ length: STATE_CAPS.progress.items + 3 }, (_, i) => ({ step: `s${i}`, status: "todo" })),
      files: Array.from({ length: STATE_CAPS.files.items + 2 }, (_, i) => ({ path: `p${i}`, note: "" })),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.clipped).toBe(true);
    expect(out.state.goal.length).toBe(STATE_CAPS.goal);
    // Facts keep the newest (tail); progress keeps the head (ordered checklist).
    expect(out.state.facts.length).toBe(STATE_CAPS.facts.items);
    expect(out.state.facts[0]).toBe("f5");
    expect(out.state.progress.length).toBe(STATE_CAPS.progress.items);
    expect(out.state.progress[0].step).toBe("s0");
    expect(out.state.files.length).toBe(STATE_CAPS.files.items);
  });

  it("drops unknown keys and blank items silently", () => {
    const out = validateSkillState({ ...GOOD, extra: 1, decisions: ["  ", "keep"] });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.state as unknown as Record<string, unknown>).extra).toBeUndefined();
      expect(out.state.decisions).toEqual(["keep"]);
    }
  });

  it("parseSkillState reports invalid JSON as a shape error", () => {
    expect(parseSkillState("{not json")).toMatchObject({ ok: false, error: expect.stringContaining("JSON") });
    expect(parseSkillState(stateJson(GOOD))).toMatchObject({ ok: true, state: GOOD });
  });

  it("renders the wire block as lead + fenced JSON, and knows an empty state", () => {
    const block = renderStateBlock("【执行状态】", GOOD);
    expect(block.startsWith("【执行状态】\n```json\n")).toBe(true);
    expect(block.endsWith("\n```")).toBe(true);
    expect(JSON.parse(block.slice(block.indexOf("{"), block.lastIndexOf("}") + 1))).toEqual(GOOD);
    expect(isEmptyState(emptySkillState())).toBe(true);
    expect(isEmptyState(GOOD)).toBe(false);
  });
});

describe("planFold keepTurns", () => {
  it("folds down to one verbatim turn in state mode, two by default", () => {
    const { history, meta } = session([
      [q("q1"), a("a1")], [q("q2"), a("a2")], [q("q3"), a("a3")],
    ]);
    const classic = planFold(history, meta, 100_000, { force: true });
    expect(classic?.keep.length).toBe(MIN_KEEP_TURNS);
    const state = planFold(history, meta, 100_000, { force: true, keepTurns: STATE_KEEP_TURNS });
    expect(state?.keep.length).toBe(1);
    expect(state?.fold.map((t) => t.start.content)).toEqual(["q1", "q2"]);
  });

  it("has nothing to fold with only the kept turn present", () => {
    const { history, meta } = session([[q("q1"), a("a1")]], "seed");
    expect(planFold(history, meta, 100_000, { force: true, keepTurns: 1 })).toBeNull();
  });
});

describe("updateSkillState", () => {
  it("sends no request when there is nothing to fold yet", async () => {
    const { history, meta } = session([[q("q1"), a("a1")]], "seed");
    const update = vi.fn();
    expect(await updateSkillState({ history, meta, ceilingTokens: 100_000, update })).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("folds every turn but the last into the state, drops the seed, keeps pairing valid", async () => {
    const { history, meta } = session([
      [q("q1"), toolCall("c1", "read_file"), toolReply("c1", "chapter"), a("a1")],
      [q("q2"), a("a2")],
      [q("q3"), a("a3")],
    ], "seeded lore");
    const before = [...history];
    const update = vi.fn().mockResolvedValue(stateJson(GOOD));

    const out = await updateSkillState({ history, meta, ceilingTokens: 100_000, update });
    expect(out).not.toBeNull();
    // The updater saw the folded turns (not the kept one) and no prior state.
    expect(update).toHaveBeenCalledTimes(1);
    const input = update.mock.calls[0][0];
    expect(input.prevState).toBeNull();
    expect(input.prevSummary).toBeNull();
    expect(input.rendered).toContain("[user] q1");
    expect(input.rendered).toContain("[tool call] read_file");
    expect(input.rendered).not.toContain("q3");

    // Original untouched; rebuilt = system, state block, last turn.
    expect(history).toEqual(before);
    const next = out!.history;
    expect(next[0].role).toBe("system");
    expect(next[1]).toBe(meta.summary);
    expect(String(next[1].content)).toContain("ai.instructions.stateBlock");
    expect(String(next[1].content)).toContain("霜语");
    expect(next.slice(2).map((m) => m.content)).toEqual(["q3", "a3"]);
    expect(next.some((m) => m.content === "seeded lore")).toBe(false);
    expect(repairToolCallPairing(next)).toBe(0);

    // Meta: state committed, summaryText carries its JSON for a prose fold later.
    expect(meta.state).toEqual(GOOD);
    expect(meta.summaryText).toBe(stateJson(GOOD));
    expect(meta.seedContext).toBeNull();
    expect(segmentHistory(next, meta).turns.length).toBe(1);

    // Audited numbers ride on the event; with toy turns the state can outweigh
    // what it replaced, so only their presence is asserted here.
    expect(out!.event).toMatchObject({
      kind: "context-compacted", mode: "state", foldedTurns: 2, summary: stateJson(GOOD),
      fromTokens: expect.any(Number), toTokens: expect.any(Number),
    });
  });

  it("feeds the previous state back in on the next turn", async () => {
    const { history, meta } = session([[q("q1"), a("a1")], [q("q2"), a("a2")]]);
    meta.state = GOOD;
    meta.summaryText = stateJson(GOOD);
    const update = vi.fn().mockResolvedValue(stateJson({ ...GOOD, last: "改好了" }));
    const out = await updateSkillState({ history, meta, ceilingTokens: 100_000, update });
    expect(out).not.toBeNull();
    expect(update.mock.calls[0][0].prevState).toEqual(GOOD);
    expect(meta.state?.last).toBe("改好了");
  });

  it("retries once with the validation error, then gives up leaving the session untouched", async () => {
    const { history, meta } = session([[q("q1"), a("a1")], [q("q2"), a("a2")]]);
    const before = [...history];
    const update = vi.fn()
      .mockResolvedValueOnce('{"goal": 42}')
      .mockResolvedValueOnce("not json at all");
    const out = await updateSkillState({ history, meta, ceilingTokens: 100_000, update });
    expect(out).toBeNull();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0].retryError).toContain("goal");
    expect(history).toEqual(before);
    expect(meta.state).toBeNull();
    expect(meta.summary).toBeNull();
    expect(segmentHistory(history, meta).turns.length).toBe(2);
  });

  it("recovers on the retry when the second answer validates", async () => {
    const { history, meta } = session([[q("q1"), a("a1")], [q("q2"), a("a2")]]);
    const update = vi.fn()
      .mockResolvedValueOnce("garbage")
      .mockResolvedValueOnce(stateJson(GOOD));
    const out = await updateSkillState({ history, meta, ceilingTokens: 100_000, update });
    expect(out).not.toBeNull();
    expect(meta.state).toEqual(GOOD);
  });

  it("swallows a failed request (null, untouched) but propagates an abort", async () => {
    const { history, meta } = session([[q("q1"), a("a1")], [q("q2"), a("a2")]]);
    expect(await updateSkillState({
      history, meta, ceilingTokens: 100_000, update: vi.fn().mockRejectedValue(new Error("boom")),
    })).toBeNull();
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(updateSkillState({
      history, meta, ceilingTokens: 100_000, update: vi.fn().mockRejectedValue(abort),
    })).rejects.toBe(abort);
  });

  it("takes over a prose summary: the first state grows out of it", async () => {
    const { history, meta } = session([[q("q1"), a("a1")], [q("q2"), a("a2")]]);
    const summaryMsg = q("[block] 作者在写第三章");
    meta.summary = summaryMsg;
    meta.summaryText = "作者在写第三章";
    history.splice(1, 0, summaryMsg);
    const update = vi.fn().mockResolvedValue(stateJson(GOOD));
    const out = await updateSkillState({ history, meta, ceilingTokens: 100_000, update });
    expect(out).not.toBeNull();
    expect(update.mock.calls[0][0]).toMatchObject({ prevState: null, prevSummary: "作者在写第三章" });
    // The old prose message is replaced by the state block, not stacked on it.
    expect(out!.history.filter((m) => String(m.content).includes("作者在写第三章"))).toHaveLength(0);
    expect(out!.history[1]).toBe(meta.summary);
  });

  it("hands a state back to ordinary compaction as the existing summary when the mode goes off", async () => {
    const { history, meta } = session([
      [q("q1" + "设".repeat(3000)), a("a1")],
      [q("q2"), a("a2")],
      [q("q3"), a("a3")],
    ]);
    meta.state = GOOD;
    meta.summaryText = stateJson(GOOD);
    const stateMsg = q("[block] state");
    meta.summary = stateMsg;
    history.splice(1, 0, stateMsg);
    const summarize = vi.fn().mockResolvedValue("散文摘要");
    const out = await compactChatHistory({ history, meta, ceilingTokens: 3000, summarize });
    expect(out).not.toBeNull();
    expect(summarize.mock.calls[0][0].prevSummary).toBe(stateJson(GOOD));
    expect(meta.summaryText).toBe("散文摘要");
  });
});

describe("state mode on the context bar", () => {
  it("draws no trigger mark and counts foldability against the mode's own keep", () => {
    const { history, meta } = session([[q("q1"), a("a1")], [q("q2"), a("a2")]]);
    const prefs = { autoCompact: true, triggerTokens: 512_000, triggerRatio: 0.8 };
    const classic = computeContextBreakdown(history, meta, 100, 10_000, 20_000, prefs);
    // Two turns: classic mode keeps both, so nothing folds and no mark is drawn.
    expect(classic.canFold).toBe(false);
    expect(classic.stateMode).toBe(false);
    const state = computeContextBreakdown(history, meta, 100, 10_000, 20_000, { ...prefs, stateMode: true });
    expect(state.stateMode).toBe(true);
    expect(state.canFold).toBe(true);
    expect(state.compactMarkerPct).toBeNull();
    expect(state.willCompact).toBe(false);
  });
});

describe("session persistence", () => {
  it("round-trips stateMode and the state, re-validating on the way in", () => {
    const { history, meta } = session([[q("q1"), a("a1")]]);
    meta.stateMode = true;
    meta.state = GOOD;
    const json = serializeChatSession({
      turns: [{ id: "t1", role: "user", text: "q1", log: [], at: 1 }],
      history, meta, usage: null, taskId: null,
    });
    const snap = deserializeChatSession(json);
    expect(snap?.meta.stateMode).toBe(true);
    expect(snap?.meta.state).toEqual(GOOD);

    // A blob whose state no longer fits the schema restores as "no state".
    const tampered = JSON.parse(json);
    tampered.meta.state = { goal: 7 };
    const bad = deserializeChatSession(JSON.stringify(tampered));
    expect(bad?.meta.stateMode).toBe(true);
    expect(bad?.meta.state).toBeNull();

    // Older rows: off, null.
    delete tampered.meta.state;
    delete tampered.meta.stateMode;
    const old = deserializeChatSession(JSON.stringify(tampered));
    expect(old?.meta.stateMode).toBe(false);
    expect(old?.meta.state).toBeNull();
  });
});
