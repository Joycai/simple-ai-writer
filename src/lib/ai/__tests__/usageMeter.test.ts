/**
 * lib/ai/usageMeter —— 一个桶画成哪几段。
 *
 * 三档退化的判定错一档，条就会对着作者说谎而且不报错：把「钱全在未分项里」
 * 误判成「没花钱」，条会去画 token 占比，于是一行**真的花了钱**的记录看起来
 * 像是免费的。所以每一档单独钉住。
 */
import { describe, expect, it } from "vitest";

import { meterSegments, USAGE_SEGMENT_ORDER, type UsageSegKey } from "../usageMeter";
import type { UsageBucket } from "../usage";

const bucket = (over: Partial<UsageBucket> = {}): UsageBucket => ({
  key: "k", calls: 1,
  promptTokens: 0, cachedTokens: 0, completionTokens: 0,
  outputUnits: 0, uncovered: 0, costUsd: 0,
  costInput: 0, costCache: 0, costOutput: 0,
  costCount: 0, costDuration: 0, costOther: 0, costUnsplit: 0,
  ...over,
});

const keys = (b: UsageBucket): UsageSegKey[] => meterSegments(b).segments.map((s) => s.key);

describe("USAGE_SEGMENT_ORDER", () => {
  it("七个 key，顺序只定义这一处——条与 tooltip 都读它", () => {
    expect(USAGE_SEGMENT_ORDER).toEqual([
      "input", "cache", "output", "count", "duration", "other", "unsplit",
    ]);
  });
});

describe("第 1 档 · 有费用就按费用占比", () => {
  it("六段齐全时按段序排，占比加起来是 1", () => {
    const m = meterSegments(bucket({
      costUsd: 1,
      costInput: 0.28, costCache: 0.07, costOutput: 0.54,
      costCount: 0.08, costDuration: 0.01, costOther: 0.02,
    }));
    expect(m.mode).toBe("cost");
    expect(m.segments.map((s) => s.key)).toEqual([
      "input", "cache", "output", "count", "duration", "other",
    ]);
    expect(m.segments.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 12);
    expect(m.hasUnsplit).toBe(false);
  });

  it("零值段不渲染——空段占位会让相邻段的比例被稀释", () => {
    expect(keys(bucket({ costUsd: 1, costInput: 0.4, costOutput: 0.6 })))
      .toEqual(["input", "output"]);
  });

  it("有未分项时它是一段，并且被标出来", () => {
    const m = meterSegments(bucket({ costUsd: 1, costOutput: 0.7, costUnsplit: 0.3 }));
    expect(keys(bucket({ costUsd: 1, costOutput: 0.7, costUnsplit: 0.3 })))
      .toEqual(["output", "unsplit"]);
    expect(m.hasUnsplit).toBe(true);
    expect(m.segments.find((s) => s.key === "unsplit")!.share).toBeCloseTo(0.3, 12);
  });

  // 这是第 1 档里最要紧的一条：一行的钱**全在** costUnsplit 里（升级前记下的
  // 老行）。费用是**有**的，只是分不出来——它属于「整条未分项」，绝不能被
  // 误判成「没花钱」而掉进第 2 档去画 token 占比。
  it("钱全在未分项里时仍然是费用模式，不退化成 token 占比", () => {
    const m = meterSegments(bucket({
      costUsd: 0.42, costUnsplit: 0.42,
      promptTokens: 9000, cachedTokens: 1000, completionTokens: 3000,
    }));
    expect(m.mode).toBe("cost");
    expect(m.segments).toHaveLength(1);
    expect(m.segments[0].key).toBe("unsplit");
    expect(m.segments[0].share).toBe(1);
    expect(m.hasUnsplit).toBe(true);
  });
});

describe("第 2 档 · 一分钱都没有就按 token 占比", () => {
  // 没配价的模型：条上一点颜色都没有的话，一行实实在在的用量看起来像是空的。
  it("零费用有 token：画输入 / 缓存 / 输出三段", () => {
    const m = meterSegments(bucket({
      costUsd: 0, promptTokens: 1000, cachedTokens: 400, completionTokens: 200,
    }));
    expect(m.mode).toBe("token");
    expect(m.segments.map((s) => s.key)).toEqual(["input", "cache", "output"]);
    // 输入段是**未缓存**的那部分：cachedTokens 是 promptTokens 的子集。
    expect(m.segments[0].value).toBe(600);
    expect(m.segments[1].value).toBe(400);
    expect(m.segments[2].value).toBe(200);
    expect(m.segments.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 12);
  });

  it("全是缓存命中时不画出负的输入段", () => {
    const m = meterSegments(bucket({ costUsd: 0, promptTokens: 500, cachedTokens: 500 }));
    expect(m.segments.map((s) => s.key)).toEqual(["cache"]);
    expect(m.segments[0].share).toBe(1);
  });

  it("token 模式下张数 / 时长 / 其它三段不存在——它们是钱的维度", () => {
    const k = keys(bucket({ costUsd: 0, promptTokens: 10, completionTokens: 10 }));
    expect(k).not.toContain("count");
    expect(k).not.toContain("duration");
    expect(k).not.toContain("other");
  });
});

describe("第 3 档 · 既没费用也没 token", () => {
  it("整条画成中性的一段，不留一条空轨", () => {
    const m = meterSegments(bucket({ costUsd: 0, calls: 3 }));
    expect(m.mode).toBe("none");
    expect(m.segments).toEqual([{ key: "unsplit", value: 0, share: 1 }]);
    expect(m.hasUnsplit).toBe(false);
  });

  // 负数不该出现在库里，但 REAL 列里塞得进任何东西。宁可画成「说不清」，
  // 也不要让一个负的 flexGrow 把整条弄塌。
  it("坏数据（负值）落到第 3 档，而不是画出负长度的段", () => {
    const m = meterSegments(bucket({ costUsd: 0, promptTokens: -5, completionTokens: -5 }));
    expect(m.mode).toBe("none");
  });
});
