/**
 * 人设校准循环（lib/image/calibrate）。
 *
 * 锁住的行为：提前达标即停、revisedPrompt 换词而 seedOnly 不换、硬轮数上限、
 * 到上限时选**历史最佳**（并列取更晚的一轮）、以及评审 JSON 的对齐规则——
 * 数量对得上时以清单原文为准，评审员的转述不许替换作者要问的问题。
 */
import { describe, it, expect } from "vitest";
import {
  parseChecklistJson, parseReviewJson, runCalibration, type CalibrationReview,
} from "../image/calibrate";

/** 一个 review 的速写：按 pass/fail 序列造 verdicts。 */
function review(passes: boolean[], extra?: Partial<CalibrationReview>): CalibrationReview {
  return {
    results: passes.map((pass, i) => ({ criterion: `c${i}`, pass })),
    ...extra,
  };
}

describe("runCalibration", () => {
  it("stops the moment a round passes everything", async () => {
    const prompts: string[] = [];
    const run = await runCalibration({
      basePrompt: "base",
      maxRounds: 5,
      generate: async (p) => { prompts.push(p); return `img-${prompts.length}`; },
      review: async () => review([true, true]),
    });
    expect(run.passed).toBe(true);
    expect(run.rounds).toHaveLength(1);
    expect(run.bestIndex).toBe(0);
    expect(prompts).toEqual(["base"]);
  });

  it("swaps in revisedPrompt for the next round, but not on seedOnly", async () => {
    const prompts: string[] = [];
    let n = 0;
    await runCalibration({
      basePrompt: "base",
      maxRounds: 3,
      generate: async (p) => { prompts.push(p); return "img"; },
      review: async () => {
        n++;
        if (n === 1) return review([false], { revisedPrompt: "revised" });
        // 抽卡问题：同一提示词换 seed 再来，即使评审员顺手给了修订也不换。
        return review([false], { revisedPrompt: "should-not-apply", seedOnly: true });
      },
    });
    expect(prompts).toEqual(["base", "revised", "revised"]);
  });

  it("respects the round cap and picks the best round — ties go to the later one", async () => {
    const verdicts = [
      review([true, false, false]),  // 1/3
      review([true, true, false]),   // 2/3
      review([true, true, false]),   // 2/3 — 并列，取更晚的
    ];
    let n = 0;
    const onRound: number[] = [];
    const run = await runCalibration({
      basePrompt: "base",
      maxRounds: 3,
      generate: async () => `img-${n}`,
      review: async () => verdicts[n++],
      onRound: (r) => onRound.push(r.passCount),
    });
    expect(run.rounds).toHaveLength(3);
    expect(run.passed).toBe(false);
    expect(run.bestIndex).toBe(2);
    expect(onRound).toEqual([1, 2, 2]);
  });

  it("ends the loop when generate returns null, keeping completed rounds", async () => {
    let n = 0;
    const run = await runCalibration({
      basePrompt: "base",
      maxRounds: 4,
      generate: async () => (++n === 2 ? null : "img"),
      review: async () => review([false, true]),
    });
    expect(run.rounds).toHaveLength(1);
    expect(run.bestIndex).toBe(0);
    expect(run.passed).toBe(false);
  });

  it("starts no new round after the signal aborts", async () => {
    const ctrl = new AbortController();
    let generations = 0;
    const run = await runCalibration({
      basePrompt: "base",
      maxRounds: 5,
      signal: ctrl.signal,
      generate: async () => { generations++; return "img"; },
      review: async () => { ctrl.abort(); return review([false]); },
    });
    expect(generations).toBe(1);
    expect(run.rounds).toHaveLength(1);
  });
});

describe("parseChecklistJson", () => {
  it("trims, filters junk and caps the list", () => {
    const raw = JSON.stringify({ items: [" 银白色长发 ", "", 42, ...Array(12).fill("x")] });
    const items = parseChecklistJson(raw);
    expect(items[0]).toBe("银白色长发");
    expect(items).toHaveLength(10);
  });

  it("throws on invalid JSON and on an empty list", () => {
    expect(() => parseChecklistJson("nope")).toThrow(/valid JSON/);
    expect(() => parseChecklistJson('{"items": []}')).toThrow(/no usable criteria/);
  });
});

describe("parseReviewJson", () => {
  const CHECKLIST = ["银白色长发", "左眼下有泪痣"];

  it("re-aligns verdicts to the checklist's own wording when counts match", () => {
    const raw = JSON.stringify({
      results: [
        { criterion: "hair is silvery white", pass: true },
        { criterion: "mole under eye", pass: false, note: "看不到泪痣" },
      ],
      revisedPrompt: "  new prompt  ",
    });
    const r = parseReviewJson(raw, CHECKLIST);
    expect(r.results.map((x) => x.criterion)).toEqual(CHECKLIST);
    expect(r.results[1]).toMatchObject({ pass: false, note: "看不到泪痣" });
    expect(r.revisedPrompt).toBe("new prompt");
  });

  it("keeps the reviewer's criteria when counts mismatch, and coerces flags", () => {
    const raw = JSON.stringify({
      results: [{ criterion: "only one", pass: "yes" }],
      seedOnly: true,
      revisedPrompt: "",
    });
    const r = parseReviewJson(raw, CHECKLIST);
    expect(r.results).toEqual([{ criterion: "only one", pass: false }]); // 非布尔按不通过
    expect(r.seedOnly).toBe(true);
    expect(r.revisedPrompt).toBeUndefined();
  });

  it("throws when the reviewer returned no verdicts", () => {
    expect(() => parseReviewJson('{"results": []}', CHECKLIST)).toThrow(/no verdicts/);
    expect(() => parseReviewJson("garbage", CHECKLIST)).toThrow(/valid JSON/);
  });
});
