/**
 * Targeted find/replace: which occurrence an approved edit lands on, and what
 * happens when the file moved on while the card was waiting.
 *
 * The property worth protecting is not "the edit applies" — it is that the
 * write is the one the author saw. The recorded occurrence count is what makes
 * that checkable once `find` is allowed to repeat.
 */
import { describe, expect, it } from "vitest";

import { applyFindReplace, describeEditTarget, findOccurrences } from "../editApply";

const DOC = "红色的门。红色的窗。红色的墙。";

describe("findOccurrences", () => {
  it("returns every start offset, skipping past each match", () => {
    expect(findOccurrences(DOC, "红色")).toEqual([0, 5, 10]);
    // Overlaps are not double-counted: "aa" is in "aaaa" twice, not three times.
    expect(findOccurrences("aaaa", "aa")).toEqual([0, 2]);
    expect(findOccurrences(DOC, "")).toEqual([]);
  });
});

describe("applyFindReplace", () => {
  it("replaces the only occurrence when no target is given", () => {
    expect(applyFindReplace("a b c", "b", "B", 1, undefined)).toBe("a B c");
  });

  it("replaces the Nth occurrence, counting from 1", () => {
    expect(applyFindReplace(DOC, "红色", "蓝色", 3, 2)).toBe("红色的门。蓝色的窗。红色的墙。");
    expect(applyFindReplace(DOC, "红色", "蓝色", 3, 1)).toBe("蓝色的门。红色的窗。红色的墙。");
    expect(applyFindReplace(DOC, "红色", "蓝色", 3, 3)).toBe("红色的门。红色的窗。蓝色的墙。");
  });

  it("replaces every occurrence for target 'all'", () => {
    expect(applyFindReplace(DOC, "红色", "蓝色", 3, "all")).toBe("蓝色的门。蓝色的窗。蓝色的墙。");
  });

  it("handles a replacement longer than the match without shifting later hits", () => {
    // Splicing from the end is what makes this work — front-to-back would
    // apply the second replacement at a stale offset.
    expect(applyFindReplace("x x x", "x", "yyyy", 3, "all")).toBe("yyyy yyyy yyyy");
  });

  it("refuses when the text is gone", () => {
    expect(() => applyFindReplace("nothing here", "x", "y", 1, undefined)).toThrow(
      /no longer matches/,
    );
  });

  it("refuses when the count moved, and says so in the count's own terms", () => {
    // Single-occurrence edits keep the wording the author has always read.
    expect(() => applyFindReplace(DOC, "红色", "蓝色", 1, undefined)).toThrow(/too ambiguous/);
    // A targeted edit reports the mismatch instead — "ambiguous" would be a
    // lie when the call named exactly which one it meant.
    expect(() => applyFindReplace(DOC, "红色", "蓝色", 5, 2)).toThrow(
      /now appears 3 times, not the 5 shown on the card/,
    );
  });

  it("treats a literal $ in the replacement as text", () => {
    // split/join, not String.replace — `$&` there would expand to the match.
    expect(applyFindReplace("cost: X", "X", "$5 ($&)", 1, undefined)).toBe("cost: $5 ($&)");
  });
});

describe("describeEditTarget", () => {
  it("says nothing when there was only one occurrence", () => {
    expect(describeEditTarget(1, undefined)).toBe("");
  });

  it("names the scope once there is a choice to report", () => {
    expect(describeEditTarget(12, "all")).toBe("all 12 occurrences");
    expect(describeEditTarget(12, 3)).toBe("occurrence 3 of 12");
  });
});
