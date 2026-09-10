/**
 * The rewrite card's model: a whole-file rewrite cut into paragraph windows
 * (设计稿 02h 1b, rules 1z A/B).
 *
 * What is pinned here is the reading order and the classification, because
 * those are the card's whole claim: removals first so the author sees what
 * they stand to lose, 「合并」 recognised as one fact rather than scattered
 * across a dozen line changes, and punctuation counted rather than drawn.
 */
import { describe, expect, it } from "vitest";
import {
  WINDOW_ROWS_PER_SIDE,
  rewriteWindows,
  splitBlocks,
} from "../diff/blocks";

const WIDE = { context: 2, maxWindows: 6 };

describe("splitBlocks", () => {
  it("splits on blank lines and numbers each paragraph", () => {
    const blocks = splitBlocks("第一段。\n还是第一段。\n\n第二段。\n");
    expect(blocks).toEqual([
      { from: 1, to: 2, text: "第一段。\n还是第一段。" },
      { from: 4, to: 4, text: "第二段。" },
    ]);
  });

  it("gives blank lines to no paragraph", () => {
    // Otherwise "a blank line was added" reads as "the paragraph changed".
    expect(splitBlocks("\n\n只有一段。\n\n")).toEqual([{ from: 3, to: 3, text: "只有一段。" }]);
  });
});

describe("rewriteWindows — a removed section", () => {
  const original = [
    "## 三 · 码头夜市",
    "",
    "夜市从戌时开张，摊子沿着堤一路摆到闸口。",
    "灯是鱼油灯，烧起来有腥味。",
    "",
    "## 四 · 闸口",
    "",
    "闸口有三道铁门。",
  ].join("\n");
  const content = ["## 三 · 码头夜市", "", "## 四 · 闸口", "", "闸口有三道铁门。"].join("\n");

  it("reads as whole paragraphs leaving, and says what they weighed", () => {
    const result = rewriteWindows(original, content, WIDE);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]).toMatchObject({ kind: "del", wholeBlocks: true, from: 3, to: 4 });
    expect(result.summary.deletedBlocks).toBe(1);
    expect(result.summary.deletedChars).toBeGreaterThan(0);
  });

  it("names the section the removal was in", () => {
    const [window] = rewriteWindows(original, content, WIDE).windows;
    expect(window.section).toBe("三 · 码头夜市");
  });

  it("draws the removed lines with the file either side of them", () => {
    const [window] = rewriteWindows(original, content, WIDE).windows;
    expect(window.rows.map((r) => r.type)).toEqual([
      "context", "context", "del", "del", "context", "context",
    ]);
    expect(window.rows[0].line).toBe(1);
    expect(window.rows.filter((r) => r.type === "del").map((r) => r.line)).toEqual([3, 4]);
  });
});

describe("rewriteWindows — two paragraphs welded into one", () => {
  const original = [
    "港口位于河口南岸，三面环山。",
    "",
    "南岸的港口三面被山围住，只有北面开向海。",
  ].join("\n");
  const content = "港口位于河口南岸，三面环山，只有北面开向海。";

  it("calls it a merge, not two unrelated changes", () => {
    const result = rewriteWindows(original, content, WIDE);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].kind).toBe("merge");
    expect(result.summary.mergeCount).toBe(1);
  });

  it("keeps both sources' line numbers and the result's", () => {
    const [window] = rewriteWindows(original, content, WIDE).windows;
    expect(window.rows.filter((r) => r.type === "del").map((r) => r.line)).toEqual([1, 3]);
    expect(window.rows.filter((r) => r.type === "add").map((r) => r.line)).toEqual([1]);
  });

  it("is an ordinary replacement when the result keeps neither source", () => {
    const unrelated = "闸口有三道铁门，夜里落锁。";
    const result = rewriteWindows(original, unrelated, WIDE);
    expect(result.windows[0].kind).toBe("replace");
    expect(result.summary.mergeCount).toBe(0);
  });
});

describe("rewriteWindows — punctuation", () => {
  const original = ["她说，好。", "", "这一段没动。", "", "旧的一段要删掉。"].join("\n");

  it("counts a punctuation-only change and does not draw it", () => {
    const content = ["她说：好！", "", "这一段没动。", "", ""].join("\n");
    const result = rewriteWindows(original, content, WIDE);
    expect(result.summary.punctCount).toBe(1);
    expect(result.windows.map((w) => w.kind)).toEqual(["del"]);
    expect(result.hidden.punct).toBe(1);
  });

  it("draws it when it is the only thing that happened", () => {
    // A card with no windows would be hiding the whole change.
    const content = ["她说：好！", "", "这一段没动。", "", "旧的一段要删掉。"].join("\n");
    const result = rewriteWindows(original, content, WIDE);
    expect(result.windows.map((w) => w.kind)).toEqual(["punct"]);
    expect(result.hidden.punct).toBe(0);
  });
});

describe("rewriteWindows — order and folding", () => {
  const original = [
    "开头一段。", "",
    "会被删掉的一段。", "",
    "中间不动。", "",
    "会被改写的一段，原来的说法。", "",
    "结尾不动。",
  ].join("\n");
  const content = [
    "开头一段。", "",
    "中间不动。", "",
    "会被改写的一段，换了个说法。", "",
    "结尾不动。", "",
    "新添的一段。",
  ].join("\n");

  it("puts the removal first, whatever order the document has them in", () => {
    const kinds = rewriteWindows(original, content, WIDE).windows.map((w) => w.kind);
    expect(kinds[0]).toBe("del");
    expect(kinds).toContain("add");
    expect(kinds.indexOf("add")).toBeGreaterThan(kinds.indexOf("del"));
  });

  it("folds the groups past the cap and counts them by kind", () => {
    const result = rewriteWindows(original, content, { context: 1, maxWindows: 1 });
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].kind).toBe("del");
    expect(result.hiddenTotal).toBe(2);
    expect(result.hidden.add).toBe(1);
  });
});

describe("rewriteWindows — inside one window", () => {
  it("marks the lines past the per-side cap instead of dropping them", () => {
    const long = Array.from({ length: 8 }, (_, i) => `第 ${i} 行。`).join("\n");
    const original = `开头。\n\n${long}\n\n结尾。`;
    const content = "开头。\n\n结尾。";
    const [window] = rewriteWindows(original, content, WIDE).windows;

    const dels = window.rows.filter((r) => r.type === "del");
    expect(dels).toHaveLength(8);
    expect(dels.filter((r) => !r.overflow)).toHaveLength(WINDOW_ROWS_PER_SIDE);
    expect(window.hiddenDel).toBe(8 - WINDOW_ROWS_PER_SIDE);
    expect(window.hiddenAdd).toBe(0);
  });

  it("joins two changes with only a line or two between them", () => {
    const original = ["改这里。", "", "隔一行。", "", "也改这里。"].join("\n");
    const content = ["改成这样。", "", "隔一行。", "", "也改成这样。"].join("\n");
    const result = rewriteWindows(original, content, WIDE);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].rows.filter((r) => r.type === "del").map((r) => r.line)).toEqual([1, 5]);
  });
});

describe("rewriteWindows — nothing, and too much", () => {
  it("reports a rewrite that changed nothing", () => {
    const same = "一样的文本。\n";
    const result = rewriteWindows(same, same, WIDE);
    expect(result.empty).toBe(true);
    expect(result.windows).toEqual([]);
  });

  it("refuses a document past the size cap and still says how much moved", () => {
    const huge = "行\n".repeat(20_001);
    const result = rewriteWindows(huge, `${huge}行`, WIDE);
    expect(result.degraded).toBe("size");
    expect(result.windows).toEqual([]);
    expect(result.removedChars).toBe(huge.length);
  });
});
