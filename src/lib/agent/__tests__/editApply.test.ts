/**
 * Targeted find/replace: which occurrence an approved edit lands on, and what
 * happens when the file moved on while the card was waiting.
 *
 * The property worth protecting is not "the edit applies" — it is that the
 * write is the one the author saw. The recorded occurrence count is what makes
 * that checkable once `find` is allowed to repeat.
 */
import { describe, expect, it } from "vitest";

import {
  applyFindReplace,
  describeEditTarget,
  findOccurrences,
  occurrenceAt,
  sliceLines,
} from "../editApply";

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

describe("sliceLines", () => {
  const DOC = "一\n二\n三\n";

  it("takes the range including the terminator of its last line", () => {
    expect(sliceLines(DOC, 1, 1)?.text).toBe("一\n");
    expect(sliceLines(DOC, 2, 3)?.text).toBe("二\n三\n");
    expect(sliceLines(DOC, 1, 3)?.text).toBe(DOC);
  });

  it("reports where the slice starts, so the occurrence can be identified", () => {
    expect(sliceLines(DOC, 2, 2)?.start).toBe(2);
    expect(DOC.slice(2, 2 + 2)).toBe("二\n");
  });

  it("does not count a trailing newline as a fourth line", () => {
    expect(sliceLines(DOC, 1, 1)?.lineCount).toBe(3);
    expect(sliceLines("一\n二", 1, 1)?.lineCount).toBe(2);
  });

  it("clamps an end past the last line — 'to the end' is an ordinary thing to mean", () => {
    const slice = sliceLines(DOC, 2, 99);
    expect(slice?.to).toBe(3);
    expect(slice?.text).toBe("二\n三\n");
  });

  it("refuses a start past the end, where there is no region at all", () => {
    expect(sliceLines(DOC, 4, 4)).toBeNull();
    expect(sliceLines(DOC, 0, 1)).toBeNull();
  });

  it("keeps the file's own line terminators", () => {
    // Re-joining with "\n" would quietly convert this region to LF while the
    // rest of the file stayed CRLF.
    expect(sliceLines("a\r\nb\r\n", 1, 1)?.text).toBe("a\r\n");
  });

  it("handles a last line with no terminator", () => {
    expect(sliceLines("a\nb", 2, 2)?.text).toBe("b");
  });
});

describe("occurrenceAt", () => {
  it("says which of the identical regions this one is", () => {
    // Two identical slides: the proposal has to record that it took the
    // second, or applying would re-locate to the first.
    const doc = "<s>x</s>\n<s>x</s>\n";
    const second = sliceLines(doc, 2, 2)!;
    expect(occurrenceAt(doc, second.text, second.start)).toEqual({ occurrences: 2, index: 2 });
  });

  it("reports a unique region as the only one", () => {
    expect(occurrenceAt("a\nb\n", "b\n", 2)).toEqual({ occurrences: 1, index: 1 });
  });
});
