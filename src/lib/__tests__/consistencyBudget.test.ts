/**
 * 一致性检查的预算与切段（lib/consistency/budget）。
 *
 * 两条不变量：段的合计正好是上限（分配条的规则），切出来的窗口无缝铺满文档。
 */
import { describe, expect, it } from "vitest";
import {
  GROWTH_SHARE, MAX_WINDOWS, lineOf, planReview, splitDocument,
} from "../consistency/budget";
import { ASSUMED_INPUT_CEILING_TOKENS } from "../context/budget";

const base = {
  contextSize: 32_000,
  utilization: 0.5,
  toolTokens: 4_000,
  fixedChars: 1_600,
  charsPerToken: 1,
  docChars: 3_000,
  recapChars: 800,
  pinnedChars: null as number | null,
};

describe("planReview", () => {
  it("segments sum to the ceiling", () => {
    const plan = planReview(base);
    const total = plan.segments.reduce((n, s) => n + s.chars, 0);
    expect(total).toBe(plan.ceilingTokens * plan.charsPerToken);
    expect(plan.ceilingTokens).toBe(16_000);
    expect(plan.assumed).toBe(false);
  });

  it("holds back the growth share and gives the rest to text, lore and recap", () => {
    const plan = planReview(base);
    const free = plan.segments.find((s) => s.key === "free")!.chars;
    // Free = growth reserve + whatever the short document leaves of its slot.
    expect(free).toBeGreaterThanOrEqual(Math.floor(16_000 * GROWTH_SHARE));
    expect(plan.windowChars).toBeGreaterThan(plan.loreBudgetChars);
    // The recap is capped at its share of the usable window, never more than offered.
    expect(plan.recapChars).toBeLessThanOrEqual(800);
    expect(plan.recapChars).toBeGreaterThan(0);
    expect(plan.windowCount).toBe(1);
    expect(plan.uncheckedChars).toBe(0);
  });

  it("counts windows for a long document and caps them", () => {
    const one = planReview(base);
    const docChars = Math.floor(one.windowChars * 5.5);
    const plan = planReview({ ...base, docChars });
    expect(plan.windowCount).toBe(6);
    expect(plan.uncheckedChars).toBe(0);

    const huge = planReview({ ...base, docChars: 2_000_000 });
    expect(huge.windowCount).toBe(MAX_WINDOWS);
    expect(huge.uncheckedChars).toBe(2_000_000 - MAX_WINDOWS * huge.windowChars);
  });

  it("entries mode prices the pins themselves, capped", () => {
    const small = planReview({ ...base, pinnedChars: 1_000 });
    expect(small.loreBudgetChars).toBe(1_000);
    const big = planReview({ ...base, pinnedChars: 50_000 });
    expect(big.loreBudgetChars).toBeLessThan(50_000);
    expect(big.windowChars).toBeGreaterThan(0);
  });

  it("falls back to the assumed ceiling when the model declares no window", () => {
    const plan = planReview({ ...base, contextSize: undefined });
    expect(plan.assumed).toBe(true);
    expect(plan.ceilingTokens).toBe(ASSUMED_INPUT_CEILING_TOKENS);
  });
});

describe("splitDocument", () => {
  const para = (i: number) => `第${i}段。`.repeat(40) + "\n\n";

  it("tiles the whole document with no gaps and no overlap", () => {
    const text = Array.from({ length: 30 }, (_, i) => para(i)).join("");
    const windows = splitDocument(text, 2_000);
    expect(windows[0].from).toBe(0);
    expect(windows[windows.length - 1].to).toBe(text.length);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].from).toBe(windows[i - 1].to);
      expect(windows[i].text).toBe(text.slice(windows[i].from, windows[i].to));
    }
    for (const w of windows) expect(w.to - w.from).toBeLessThanOrEqual(2_000);
  });

  it("prefers a heading, then a blank line, as the cut point", () => {
    const body = "正文。".repeat(300);
    const text = `${body}\n\n## 第二节\n${body}\n\n${body}`;
    const windows = splitDocument(text, 1_200);
    // Somewhere in the walk a window starts on the heading line.
    expect(windows.some((w) => w.text.startsWith("## 第二节"))).toBe(true);
    // Every cut lands after a line break, never mid-sentence, while a break is available.
    for (let i = 1; i < windows.length; i++) expect(text[windows[i].from - 1]).toBe("\n");
  });

  it("hard-cuts when there is no line break in reach", () => {
    const text = "字".repeat(5_000);
    const windows = splitDocument(text, 1_000);
    expect(windows).toHaveLength(5);
    expect(windows.every((w) => w.text.length === 1_000)).toBe(true);
  });

  it("returns one empty window for an empty document, and respects the cap", () => {
    expect(splitDocument("", 1_000)).toEqual([{ index: 0, from: 0, to: 0, text: "" }]);
    const capped = splitDocument("x".repeat(100_000), 1_000, { maxWindows: 3 });
    expect(capped).toHaveLength(3);
    expect(capped[2].to).toBe(3_000);
  });

  it("can start part-way through (resume)", () => {
    const text = "a".repeat(3_000);
    const windows = splitDocument(text, 1_000, { start: 2_000 });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ from: 2_000, to: 3_000 });
  });
});

describe("lineOf", () => {
  it("is 1-based and counts line breaks before the offset", () => {
    const text = "one\ntwo\nthree";
    expect(lineOf(text, 0)).toBe(1);
    expect(lineOf(text, 4)).toBe(2);
    expect(lineOf(text, 8)).toBe(3);
    expect(lineOf(text, 99)).toBe(3);
  });
});
