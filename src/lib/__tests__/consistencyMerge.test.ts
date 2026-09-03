/**
 * 合并各段的结果（lib/consistency/merge）与带锚点的定位（model.locateIssue）。
 */
import { describe, expect, it } from "vitest";
import { coverageOf, mergeWindowResults } from "../consistency/merge";
import { locateIssue, revertSuggestion, textNearAnchor, type ConsistencyIssue, type WindowOutcome } from "../consistency/model";

const outcome = (index: number, from: number, to: number, status: WindowOutcome["status"] = "done"): WindowOutcome => ({
  index, from, to, status, recorded: 0, rounds: 1, inputTokens: 0, outputTokens: 0, summary: `s${index}`,
});

const issue = (id: string, quote: string, window: number, from: number, over: Partial<ConsistencyIssue> = {}): ConsistencyIssue => ({
  id, severity: "conflict", category: "characters", title: id, quote, reference: "", window,
  anchor: { from, to: from + quote.length }, ...over,
});

describe("mergeWindowResults", () => {
  it("dedupes identical quotes across windows, keeps distinct ones, orders by position", () => {
    const merged = mergeWindowResults([
      { outcome: outcome(1, 100, 200), issues: [issue("b", "左手", 1, 150), issue("c", "左 手", 1, 160)], passed: [{ label: "x", window: 1 }] },
      { outcome: outcome(0, 0, 100), issues: [issue("a", "左手", 0, 90), issue("d", "披风", 0, 10)], passed: [{ label: "x", window: 0 }, { label: "y", window: 0 }] },
    ]);
    // "左 手" folds to "左手" — same quote — so only window 0's survives.
    expect(merged.issues.map((i) => i.id)).toEqual(["d", "a"]);
    expect(merged.passed.map((p) => p.label)).toEqual(["x", "y"]);
    expect(merged.windows.map((w) => w.index)).toEqual([0, 1]);
  });
});

describe("coverageOf", () => {
  it("reports checked chars and the cap's tail as a span", () => {
    const c = coverageOf([outcome(0, 0, 100), outcome(1, 100, 200, "failed")], 260, 200);
    expect(c.checkedChars).toBe(100);
    expect(c.spans).toEqual([
      { from: 0, to: 100, status: "done" },
      { from: 100, to: 200, status: "failed" },
      { from: 200, to: 260, status: "unchecked" },
    ]);
  });
});

describe("locateIssue", () => {
  const doc = "他抬头。……很久之后……她抬头。";

  it("uses the anchor to pick the occurrence the finding was about", () => {
    const near = locateIssue(doc, { quote: "抬头", anchor: { from: doc.lastIndexOf("抬头"), to: doc.lastIndexOf("抬头") + 2 } });
    expect(near).toEqual({ from: doc.lastIndexOf("抬头"), to: doc.lastIndexOf("抬头") + 2 });
    // Without an anchor the same quote is ambiguous, as before.
    expect(locateIssue(doc, { quote: "抬头" })).toBeNull();
  });

  it("falls back to the whole document when the passage moved", () => {
    const moved = "序。" + "x".repeat(5000) + "他以左手按住剑柄。";
    const r = locateIssue(moved, { quote: "以左手按住剑柄", anchor: { from: 0, to: 7 } });
    expect(r).toEqual({ from: moved.indexOf("以左手"), to: moved.indexOf("以左手") + 7 });
  });
});

describe("revertSuggestion / textNearAnchor", () => {
  it("puts the quote back where the suggestion landed", () => {
    const original = "他以左手按住剑柄。";
    const i = issue("a", "以左手按住剑柄", 0, 1, { suggestion: "以右手按住剑柄" });
    const applied = "他以右手按住剑柄。";
    expect(revertSuggestion(applied, i)).toBe(original);
    expect(revertSuggestion("完全不同的句子。", i)).toBeNull();
  });

  it("names what now stands at the anchor", () => {
    const i = issue("a", "以左手按住剑柄", 0, 1);
    expect(textNearAnchor("他右手按住剑柄，指节抵着雪。\n下一行", i)).toBe("右手按住剑柄，指节抵着雪。");
    expect(textNearAnchor("短", i)).toBeNull();
  });
});
