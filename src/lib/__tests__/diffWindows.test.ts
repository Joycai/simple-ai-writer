/**
 * The change window: what a card draws for one edit (设计稿 02h 1a / 1l, rules 1z A/B).
 *
 * The rules being pinned are the ones a reader would notice if they broke:
 * removed lines always sit above added ones, both sides are numbered from the
 * place the passage starts, the token highlight only comes on when the two
 * sides are still the same passage, and a replacement repeated forty times is
 * drawn twice and counted.
 */
import { describe, expect, it } from "vitest";
import {
  LIT_MAX_CHANGED_LINES,
  UNIFORM_MAX_WINDOWS,
  UNIFORM_MIN_OCCURRENCES,
  editWindows,
  type WindowAnchor,
} from "../diff/windows";

const WIDE = { context: 2, maxWindows: 6 };

const anchor = (line: number, before: string[] = [], after: string[] = []): WindowAnchor => ({
  line,
  before,
  after,
});

describe("editWindows — one small change", () => {
  const find = "她把灯笼举高了些，金发在风里散开。";
  const replace = "她把灯笼举高了些，银发在风里散开，像一截落在肩上的月光。";
  const at = anchor(142, ["潮声从堤外压过来。", "船在暗处摇。"], ["「别看那边。」沈砚说。", ""]);

  it("draws context, the removed line, then the added line", () => {
    const [window] = editWindows(find, replace, [at], WIDE).windows;
    expect(window.rows.map((r) => r.type)).toEqual([
      "context", "context", "del", "add", "context", "context",
    ]);
  });

  it("numbers both sides from where the passage starts", () => {
    const [window] = editWindows(find, replace, [at], WIDE).windows;
    expect(window.rows.map((r) => r.line)).toEqual([140, 141, 142, 142, 143, 144]);
  });

  it("lights the tokens when the two sides are still the same sentence", () => {
    const [window] = editWindows(find, replace, [at], WIDE).windows;
    expect(window.wholesale).toBe(false);
    const del = window.rows.find((r) => r.type === "del")!;
    expect(del.inline?.filter((s) => s.type === "del").map((s) => s.text)).toEqual(["金"]);
  });

  it("counts the characters that changed, not the line they sit in", () => {
    // 「金」 out, 「银」 plus the new clause in. The line is 17 characters long
    // and 16 of them did not move; a headline of +28 −17 would say nothing.
    const result = editWindows(find, replace, [at], WIDE);
    expect(result).toMatchObject({ addedChars: 12, removedChars: 1, empty: false });
  });
});

describe("editWindows — a rewritten passage", () => {
  const find = [
    "港口在夜里像一头伏着的兽，仓房是它的脊背。",
    "风从海面上来，带着盐和腐木的气味。",
    "沈砚是其中一个。他站在三号仓的阴影里，数着巡夜人的脚步。",
  ].join("\n");
  const replace = [
    "沈砚把背贴在三号仓的墙上。砖是凉的，渗着盐。",
    "他数巡夜人的脚步，数到第七下，风换了方向。",
  ].join("\n");
  const at = anchor(150, ["她没有回答。", ""], ["", "「第七个。」他说。"]);

  it("puts every removed line above every added one", () => {
    const [window] = editWindows(find, replace, [at], WIDE).windows;
    const marks = window.rows.filter((r) => r.type !== "context").map((r) => r.type);
    expect(marks).toEqual(["del", "del", "del", "add", "add"]);
  });

  it("numbers the removed lines and the added lines from the same start", () => {
    const [window] = editWindows(find, replace, [at], WIDE).windows;
    const dels = window.rows.filter((r) => r.type === "del").map((r) => r.line);
    const adds = window.rows.filter((r) => r.type === "add").map((r) => r.line);
    expect(dels).toEqual([150, 151, 152]);
    expect(adds).toEqual([150, 151]);
    // The file below the passage has not moved yet, so context resumes past the
    // lines that were there.
    expect(window.rows[window.rows.length - 1].line).toBe(154);
  });

  it("calls itself a wholesale replacement and lights nothing", () => {
    const [window] = editWindows(find, replace, [at], WIDE).windows;
    expect(window.wholesale).toBe(true);
    expect(window.rows.every((r) => r.inline === undefined)).toBe(true);
  });

  it("counts whole lines when there is nothing to light", () => {
    const result = editWindows(find, replace, [at], WIDE);
    expect(result.removedChars).toBe(find.replace(/\n/g, "").length);
    expect(result.addedChars).toBe(replace.replace(/\n/g, "").length);
  });

  it("stays unlit even when few lines change, if nothing survives", () => {
    const result = editWindows("一句完全不同的话。", "另外一件毫不相干的事。", [anchor(3)], WIDE);
    expect(result.windows[0].wholesale).toBe(true);
    expect(result.windows[0].rows.every((r) => r.inline === undefined)).toBe(true);
  });

  it("stays unlit when a faithful edit is spread over too many lines", () => {
    // Similar enough line by line, but past the ceiling — marking a dozen lines
    // word by word is the noise the ceiling exists to stop.
    const lines = Array.from({ length: LIT_MAX_CHANGED_LINES + 2 }, (_, i) => `第 ${i} 行的原句。`);
    const changed = lines.map((l) => l.replace("原句", "新句"));
    const result = editWindows(lines.join("\n"), changed.join("\n"), [anchor(10)], WIDE);
    expect(result.windows[0].rows.every((r) => r.inline === undefined)).toBe(true);
  });
});

describe("editWindows — the same replacement, many times", () => {
  const anchors = Array.from({ length: 40 }, (_, i) => anchor(3 + i * 8, ["上一行。"], ["下一行。"]));

  it("draws two and counts the rest", () => {
    const result = editWindows("沈砚", "沈研", anchors, WIDE);
    expect(result.uniform).toBe(true);
    expect(result.windows).toHaveLength(UNIFORM_MAX_WINDOWS);
    expect(result.hidden).toBe(40 - UNIFORM_MAX_WINDOWS);
  });

  it("drops the context too — the 38th neighbour explains nothing", () => {
    const [window] = editWindows("沈砚", "沈研", anchors, WIDE).windows;
    expect(window.rows.map((r) => r.type)).toEqual(["del", "add"]);
  });

  it("keeps context and every window below the repetition threshold", () => {
    const few = anchors.slice(0, UNIFORM_MIN_OCCURRENCES - 1);
    const result = editWindows("沈砚", "沈研", few, WIDE);
    expect(result.uniform).toBe(false);
    expect(result.windows).toHaveLength(6); // the width's cap
    expect(result.hidden).toBe(few.length - 6);
    expect(result.windows[0].rows.map((r) => r.type)).toEqual(["context", "del", "add", "context"]);
  });
});

describe("editWindows — width and folding", () => {
  const at = anchor(20, ["上上行。", "上一行。"], ["下一行。", "下下行。"]);

  it("takes the nearer context line when only one fits", () => {
    const [window] = editWindows("原句。", "新句。", [at], { context: 1, maxWindows: 2 }).windows;
    expect(window.rows[0]).toMatchObject({ type: "context", text: "上一行。", line: 19 });
    expect(window.rows[window.rows.length - 1]).toMatchObject({ type: "context", text: "下一行。", line: 21 });
  });

  it("folds the windows past the cap and says how many", () => {
    const three = [at, anchor(40), anchor(60)];
    const result = editWindows("原句。", "新句。", three, { context: 0, maxWindows: 2 });
    expect(result.windows).toHaveLength(2);
    expect(result.hidden).toBe(1);
    expect(result.uniform).toBe(false);
  });

  it("collapses a long unchanged stretch inside one passage", () => {
    const untouched = Array.from({ length: 12 }, (_, i) => `没动的第 ${i} 行。`);
    const find = ["开头改这里。", ...untouched, "结尾也改。"].join("\n");
    const replace = ["开头改成这样。", ...untouched, "结尾改成这样。"].join("\n");
    const [window] = editWindows(find, replace, [anchor(100)], WIDE).windows;
    const gap = window.rows.find((r) => r.type === "gap");
    expect(gap?.hidden).toBe(8); // 12 minus the two kept either side
    // Numbering steps over the gap, so the closing lines still say where they are.
    expect(window.rows.filter((r) => r.type === "del").map((r) => r.line)).toEqual([100, 113]);
  });
});

describe("editWindows — nothing to draw", () => {
  it("reports an edit that changes nothing", () => {
    const result = editWindows("一样的句子。", "一样的句子。", [anchor(5)], WIDE);
    expect(result.empty).toBe(true);
    expect(result.windows).toEqual([]);
    expect(result.hidden).toBe(0);
    expect(result.addedChars).toBe(0);
    expect(result.removedChars).toBe(0);
  });

  it("reports a change that is only whitespace", () => {
    const result = editWindows("　　她把灯笼举高了些。", "她把灯笼举高了些。", [anchor(5)], WIDE);
    expect(result.empty).toBe(false);
    expect(result.whitespaceOnly).toBe(true);
  });
});
