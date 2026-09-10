/**
 * The diff core: tokenising, the bounded sequence search, and the hunked
 * document diff the approval cards will draw.
 *
 * The rules being pinned, in the order they matter: nothing is invented (the
 * script always rebuilds the new text), Chinese changes one character rather
 * than one sentence, line numbers count the way the rest of the app counts
 * them, and the caps refuse loudly instead of producing an unreadable diff.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_INLINE_CHARS,
  diffDocument,
  diffInline,
  segText,
  splitLines,
  tokenize,
} from "../diff";
import { diffIndices } from "../diff/myers";

describe("tokenize", () => {
  it("splits CJK per character and Latin per word", () => {
    expect(tokenize("金发 hair")).toEqual(["金", "发", " ", "hair"]);
  });

  it("keeps a whitespace run as one token", () => {
    expect(tokenize("a\n\n  b")).toEqual(["a", "\n\n  ", "b"]);
  });

  it("gives punctuation its own token", () => {
    expect(tokenize("好，走。")).toEqual(["好", "，", "走", "。"]);
  });

  it("never splits a surrogate pair", () => {
    // U+20BB7 (Han extension B) and an emoji — both two UTF-16 units.
    expect(tokenize("𠮷🌙")).toEqual(["𠮷", "🌙"]);
  });

  it("keeps digits and underscores inside a word", () => {
    expect(tokenize("chapter_12 ok")).toEqual(["chapter_12", " ", "ok"]);
  });

  it("concatenates back to the input", () => {
    const text = "她把灯笼举高了些，golden hair 在风里散开。\n  下一行\r\n";
    expect(tokenize(text).join("")).toBe(text);
  });
});

describe("diffIndices", () => {
  it("rebuilds the new sequence from the script", () => {
    const a = [..."the quick brown fox"];
    const b = [..."the quiet brown cat"];
    const steps = diffIndices(a.length, b.length, (i, j) => a[i] === b[j], 100)!;
    const rebuilt = steps
      .filter((s) => s.type !== "del")
      .map((s) => (s.type === "add" ? b[s.b] : a[s.a]))
      .join("");
    expect(rebuilt).toBe(b.join(""));
    const original = steps
      .filter((s) => s.type !== "add")
      .map((s) => a[s.a])
      .join("");
    expect(original).toBe(a.join(""));
  });

  it("returns null past the distance cap instead of a partial script", () => {
    const a = Array.from({ length: 40 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 40 }, (_, i) => `b${i}`);
    expect(diffIndices(a.length, b.length, (i, j) => a[i] === b[j], 8)).toBeNull();
  });

  it("handles an empty side", () => {
    const b = ["x", "y"];
    const steps = diffIndices(0, 2, () => false, 10)!;
    expect(steps.map((s) => s.type)).toEqual(["add", "add"]);
    expect(steps.map((s) => b[s.b])).toEqual(["x", "y"]);
  });
});

describe("diffInline", () => {
  it("marks one changed character in a Chinese sentence", () => {
    const segs = diffInline(
      "她把灯笼举高了些，金发在风里散开。",
      "她把灯笼举高了些，银发在风里散开。",
    )!;
    expect(segs.filter((s) => s.type === "del").map((s) => s.text)).toEqual(["金"]);
    expect(segs.filter((s) => s.type === "add").map((s) => s.text)).toEqual(["银"]);
    // The rest of the sentence survives as unchanged runs, not per-character bits.
    expect(segs.filter((s) => s.type === "equal")).toHaveLength(2);
  });

  it("changes an English word as a word", () => {
    const segs = diffInline("the quick fox", "the slow fox")!;
    expect(segs.filter((s) => s.type === "del").map((s) => s.text)).toEqual(["quick"]);
    expect(segs.filter((s) => s.type === "add").map((s) => s.text)).toEqual(["slow"]);
  });

  it("reconstructs both sides", () => {
    const a = "第三章 潮声，写于旧港。";
    const b = "第三章 潮声，写于新港的清晨。";
    const segs = diffInline(a, b)!;
    expect(segText(segs, "a")).toBe(a);
    expect(segText(segs, "b")).toBe(b);
  });

  it("refuses a line past the inline cap", () => {
    const long = "x".repeat(MAX_INLINE_CHARS + 1);
    expect(diffInline(long, `${long}y`)).toBeNull();
  });
});

describe("splitLines", () => {
  it("does not make a phantom last line out of a trailing newline", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });

  it("keeps a carriage return on its line", () => {
    expect(splitLines("a\r\nb")).toEqual(["a\r", "b"]);
  });
});

describe("diffDocument", () => {
  const chapter = ["第一段。", "第二段。", "第三段。", "第四段。", "第五段。"].join("\n");

  it("reports no hunks when nothing changed", () => {
    const diff = diffDocument(chapter, chapter);
    expect(diff.hunks).toEqual([]);
    expect(diff.stats.addedLines).toBe(0);
    expect(diff.stats.removedLines).toBe(0);
    expect(diff.stats.equalLines).toBe(5);
    expect(diff.stats.whitespaceOnly).toBe(false);
  });

  it("puts a changed line in one hunk with its context and line numbers", () => {
    const after = chapter.replace("第三段。", "第三段，改过了。");
    const diff = diffDocument(chapter, after, { context: 1 });
    expect(diff.hunks).toHaveLength(1);
    const hunk = diff.hunks[0];
    expect(hunk.aStart).toBe(2);
    expect(hunk.bStart).toBe(2);
    expect(hunk.lines.map((l) => l.type)).toEqual(["equal", "del", "add", "equal"]);
    expect(hunk.lines[1].a).toBe(3);
    expect(hunk.lines[2].b).toBe(3);
    expect(hunk.skippedBefore).toBe(1);
  });

  it("numbers lines after an insertion by their own side", () => {
    const before = ["a", "b", "c"].join("\n");
    const after = ["a", "new", "b", "c"].join("\n");
    const diff = diffDocument(before, after, { context: 0 });
    const added = diff.hunks[0].lines.find((l) => l.type === "add")!;
    expect(added.b).toBe(2);
    expect(added.a).toBeUndefined();
    // The hunk still says where it lands in the old file.
    expect(diff.hunks[0].aStart).toBe(2);
  });

  it("merges nearby changes and splits distant ones", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = before.replace("line 3", "LINE 3").replace("line 25", "LINE 25");
    const diff = diffDocument(before, after, { context: 3 });
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[1].skippedBefore).toBeGreaterThan(0);

    const near = before.replace("line 3", "LINE 3").replace("line 6", "LINE 6");
    expect(diffDocument(before, near, { context: 3 }).hunks).toHaveLength(1);
  });

  it("attaches inline detail to a rewritten line and not to unrelated ones", () => {
    const before = ["她把灯笼举高了些，金发在风里散开。"].join("\n");
    const after = ["她把灯笼举高了些，银发在风里散开。"].join("\n");
    const [hunk] = diffDocument(before, after).hunks;
    const del = hunk.lines.find((l) => l.type === "del")!;
    expect(del.inline?.filter((s) => s.type === "del").map((s) => s.text)).toEqual(["金"]);

    // Two lines with nothing in common are not "one line, edited".
    const unrelated = diffDocument("旧码头的雾散了。", "凯尔在第三章出场。").hunks[0];
    expect(unrelated.lines.find((l) => l.type === "del")!.inline).toBeUndefined();
  });

  it("does not pair runs of unequal length", () => {
    const before = ["one", "two"].join("\n");
    const after = ["one changed", "two changed", "three added"].join("\n");
    const [hunk] = diffDocument(before, after).hunks;
    expect(hunk.lines.every((l) => l.inline === undefined)).toBe(true);
  });

  it("flags a whitespace-only change", () => {
    const before = ["    段落一", "段落二"].join("\n");
    const after = ["段落一", "段落二"].join("\n");
    expect(diffDocument(before, after).stats.whitespaceOnly).toBe(true);

    // Re-wrapping one paragraph into two lines is still whitespace-only.
    expect(diffDocument("一句话 另一句话", "一句话\n另一句话").stats.whitespaceOnly).toBe(true);

    // Line endings alone: every line changes, and this is what says why.
    const crlf = diffDocument("a\r\nb\r\nc", "a\nb\nc");
    expect(crlf.hunks.length).toBeGreaterThan(0);
    expect(crlf.stats.whitespaceOnly).toBe(true);
  });

  it("does not call a real edit whitespace-only", () => {
    expect(diffDocument("金发", "银发").stats.whitespaceOnly).toBe(false);
  });

  it("counts a rewrite that drops a section", () => {
    const before = ["一", "二", "三", "四"].join("\n");
    const after = ["一", "四"].join("\n");
    const diff = diffDocument(before, after, { context: 0 });
    expect(diff.stats.removedLines).toBe(2);
    expect(diff.stats.addedLines).toBe(0);
    expect(diff.hunks[0].lines.map((l) => l.text)).toEqual(["二", "三"]);
  });

  it("handles an empty side", () => {
    const created = diffDocument("", "全新的一章。");
    expect(created.stats.addedLines).toBe(1);
    expect(created.stats.removedLines).toBe(0);
    const emptied = diffDocument("原来的一章。", "");
    expect(emptied.stats.removedLines).toBe(1);
  });

  it("degrades on size rather than diffing a book", () => {
    const huge = "行\n".repeat(20_001);
    const diff = diffDocument(huge, `${huge}行`);
    expect(diff.degraded).toBe("size");
    expect(diff.hunks).toEqual([]);
    // The stats still say what happened, so a card has something honest to show.
    expect(diff.stats.removedLines).toBe(20_001);
  });

  it("degrades on distance when the two texts are unrelated", () => {
    const before = Array.from({ length: 1_200 }, (_, i) => `旧的第 ${i} 行`).join("\n");
    const after = Array.from({ length: 1_200 }, (_, i) => `新的第 ${i} 段`).join("\n");
    const diff = diffDocument(before, after);
    expect(diff.degraded).toBe("distance");
    expect(diff.hunks).toEqual([]);
  });

  it("diffs a one-line minified file without trying to diff its tokens", () => {
    // The failure this guards: a 130k-character single line reaching the inline
    // diff. The line diff itself is trivial and must still work.
    const before = `<div>${"x".repeat(50_000)}</div>`;
    const after = `<div>${"y".repeat(50_000)}</div>`;
    const diff = diffDocument(before, after);
    expect(diff.degraded).toBeUndefined();
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0].lines.every((l) => l.inline === undefined)).toBe(true);
  });
});
