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
  applyInsertions,
  describeEditTarget,
  findOccurrences,
  insertionLanding,
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

/**
 * Insertions — the write that adds lines and changes none.
 *
 * Two properties carry the whole design. **Bottom-up application** is what lets
 * the model send the line numbers it read without compensating for its own
 * shifts; if that ever became top-down, every insertion after the first would
 * land one section too high, and nothing about the result would look wrong.
 * **The forced terminator** is the other: without it a heading welds onto the
 * paragraph it was inserted in front of, which is silent corruption of the one
 * thing this tool exists to produce.
 */
describe("applyInsertions", () => {
  const DOC = "一\n二\n三\n";

  it("inserts before the named line", () => {
    expect(applyInsertions(DOC, [{ line: 2, text: "## 标题" }])).toBe("一\n## 标题\n二\n三\n");
  });

  it("applies bottom-up, so every line number is the one the model read", () => {
    // Both numbers refer to the ORIGINAL file. Applied top-down, the second
    // insertion would land after "二" instead of before "三".
    expect(
      applyInsertions(DOC, [
        { line: 2, text: "A" },
        { line: 3, text: "B" },
      ]),
    ).toBe("一\nA\n二\nB\n三\n");
    // Order in the list must not matter.
    expect(
      applyInsertions(DOC, [
        { line: 3, text: "B" },
        { line: 2, text: "A" },
      ]),
    ).toBe("一\nA\n二\nB\n三\n");
  });

  it("terminates the insertion so it cannot weld onto the following line", () => {
    expect(applyInsertions(DOC, [{ line: 1, text: "# 顶" }])).toBe("# 顶\n一\n二\n三\n");
    // Already terminated: no second newline is added.
    expect(applyInsertions(DOC, [{ line: 1, text: "# 顶\n" }])).toBe("# 顶\n一\n二\n三\n");
  });

  it("leaves the leading side to the model — that is how a blank line is asked for", () => {
    expect(applyInsertions(DOC, [{ line: 2, text: "\n## 标题" }])).toBe("一\n\n## 标题\n二\n三\n");
  });

  it("inserts before a last line that has no terminator", () => {
    expect(applyInsertions("一\n二", [{ line: 2, text: "X" }])).toBe("一\nX\n二");
  });

  it("refuses a line that no longer exists rather than clamping", () => {
    // Clamping would write at a position the author never approved.
    expect(() => applyInsertions(DOC, [{ line: 4, text: "X" }])).toThrow(/no longer exists/);
    expect(() => applyInsertions(DOC, [{ line: 0, text: "X" }])).toThrow(/no longer exists/);
  });
});

describe("insertionLanding", () => {
  it("reports where each piece ends up, in reading order", () => {
    expect(
      insertionLanding([
        { line: 10, text: "B" },
        { line: 3, text: "A" },
      ]),
    ).toEqual([
      { line: 3, newLine: 3, added: 1 },
      // One line went in above it, so line 10 is now line 11.
      { line: 10, newLine: 11, added: 1 },
    ]);
  });

  it("counts every line a multi-line insertion adds", () => {
    expect(
      insertionLanding([
        { line: 5, text: "\n## 标题\n" },
        { line: 9, text: "X" },
      ]),
    ).toEqual([
      { line: 5, newLine: 5, added: 2 },
      { line: 9, newLine: 11, added: 1 },
    ]);
  });
});

describe("applyInsertions — the file moved on", () => {
  it("refuses when the document is no longer the length the card was built from", () => {
    // The author kept typing while the card waited. Every line number on it now
    // points somewhere they never looked, and an insertion has no `find` to
    // re-locate — so the length is the only evidence there is.
    expect(() => applyInsertions("一\n二\n三\n四\n", [{ line: 2, text: "X" }], 3)).toThrow(
      /now has 4 lines, not the 3/,
    );
  });

  it("applies when the length still matches", () => {
    expect(applyInsertions("一\n二\n三\n", [{ line: 2, text: "X" }], 3)).toBe("一\nX\n二\n三\n");
  });
});
