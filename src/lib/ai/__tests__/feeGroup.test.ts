/**
 * lib/ai/feeGroup —— 三种模式的算式、规格归一化、档位匹配。
 *
 * 这个模块每一条错法都是**静默**的：匹配错一档只是记错钱，归一化漏一种
 * 拼法只是整类请求按 0 计，把「没填缓存价」当成 0 只是缓存突然免费。
 * 没有一条会抛错，所以每一条都得有测试。
 */
import { describe, expect, it } from "vitest";

import {
  costOf, feeConfigOf, hasReportedCost, matchRate, normalizeSeconds, normalizeSize,
  normalizeSpec, priceSpec, segmentsOf, specLabel, specificity, sumSegments, tierOf, totalOf,
  ZERO_BILLED, ZERO_FEE,
  type Billed, type CostParts, type CostSegments, type FeeConfig, type FeeGroup, type OutputUnit,
  type SpecRate,
} from "../feeGroup";

const group = (over: Partial<FeeGroup> = {}): FeeGroup => ({
  id: "g", name: "g", billingMode: "token",
  inputPrice: 0, cacheInputPrice: null, outputPrice: 0, requestPrice: 0,
  outputUnit: "image", outputRates: [], inputUnitPrice: 0, inputFreeUnits: 0,
  createdAt: 0, ...over,
});
const billed = (over: Partial<Billed> = {}): Billed => ({ ...ZERO_BILLED, ...over });
const fee = (over: Partial<FeeConfig> = {}): FeeConfig => ({ ...ZERO_FEE, ...over });

describe("feeConfigOf · 缓存价的空与零", () => {
  it("留空 ＝ 同输入价", () => {
    expect(feeConfigOf(group({ inputPrice: 3, cacheInputPrice: null })).cachePrice).toBe(3);
  });

  it("填 0 ＝ 缓存真免费，不被输入价盖掉", () => {
    expect(feeConfigOf(group({ inputPrice: 3, cacheInputPrice: 0 })).cachePrice).toBe(0);
  });
});

describe("costOf", () => {
  it("按 token：三段各按自己的价，输入与缓存不重叠", () => {
    const p: CostParts = costOf(billed({
      billingMode: "token", inputTokens: 600, cacheTokens: 400, outputTokens: 200,
      inputPrice: 3, cachePrice: 0.3, outputPrice: 15,
    }));
    expect(p.input).toBeCloseTo(600 * 3 / 1e6, 12);
    expect(p.cache).toBeCloseTo(400 * 0.3 / 1e6, 12);
    expect(p.output).toBeCloseTo(200 * 15 / 1e6, 12);
    expect(p.request + p.spec + p.specInput + p.reported).toBe(0);
  });

  it("按次：只按请求数，回了多少 token 都不看", () => {
    const p = costOf(billed({
      billingMode: "request", requests: 3, requestPrice: 0.04,
      inputTokens: 1e6, outputTokens: 1e6, inputPrice: 99, outputPrice: 99,
    }));
    expect(totalOf(p)).toBeCloseTo(0.12, 12);
  });

  it("按次也收输入图", () => {
    const p = costOf(billed({
      billingMode: "request", requests: 1, requestPrice: 0.04,
      inputUnits: 2, inputUnitPrice: 0.01,
    }));
    expect(totalOf(p)).toBeCloseTo(0.06, 12);
  });

  it("按规格：数量 × 单价，token 价不参与", () => {
    const p = costOf(billed({
      billingMode: "spec", outputUnits: 3, outputUnitPrice: 0.04,
      inputTokens: 1e6, inputPrice: 99,
    }));
    expect(totalOf(p)).toBeCloseTo(0.12, 12);
  });

  it("上游报价压过一切，其余六项归零", () => {
    const p = costOf(billed({
      billingMode: "spec", outputUnits: 3, outputUnitPrice: 0.04,
      inputUnits: 2, inputUnitPrice: 0.01, reportedCost: 0.07,
    }));
    expect(p.reported).toBe(0.07);
    expect(p.spec + p.specInput).toBe(0);
  });

  it("REAL 列里塞进来的文本读作缺失，不让一行毁掉整页", () => {
    const p = costOf(billed({
      billingMode: "token", inputTokens: 100,
      inputPrice: "坏格" as unknown as number,
    }));
    expect(totalOf(p)).toBe(0);
  });
});

describe("segmentsOf · 七项折成计量条的六段", () => {
  const parts = (over: Partial<CostParts> = {}): CostParts => ({
    input: 0, cache: 0, output: 0, request: 0, spec: 0, specInput: 0, reported: 0, ...over,
  });

  it("按 token：三段原样过去，另外三段空着", () => {
    const s: CostSegments = segmentsOf(parts({ input: 1, cache: 2, output: 4 }), null);
    expect(s).toEqual({ input: 1, cache: 2, output: 4, count: 0, duration: 0, other: 0 });
  });

  it("按张：spec 与输入图合并进「张数」——阶段 0 拍板不拆两段", () => {
    const s = segmentsOf(parts({ spec: 0.12, specInput: 0.02 }), "image");
    expect(s.count).toBeCloseTo(0.14, 12);
    expect(s.duration).toBe(0);
    expect(s.other).toBe(0);
  });

  it("按秒：spec 进「时长」，而输入图仍然是按张的钱", () => {
    const s = segmentsOf(parts({ spec: 0.3, specInput: 0.02 }), "second");
    expect(s.duration).toBeCloseTo(0.3, 12);
    expect(s.count).toBeCloseTo(0.02, 12);
    expect(s.other).toBe(0);
  });

  it("按条：五段装不下，进「其它」而不是硬塞给张数", () => {
    const s = segmentsOf(parts({ spec: 0.5 }), "clip");
    expect(s.other).toBeCloseTo(0.5, 12);
    expect(s.count).toBe(0);
    expect(s.duration).toBe(0);
  });

  it("单位拿不到时不猜：spec 归「其它」", () => {
    const s = segmentsOf(parts({ spec: 0.5 }), null);
    expect(s.other).toBeCloseTo(0.5, 12);
    expect(s.count).toBe(0);
  });

  it("按次的固定价进「其它」，输入图仍归「张数」", () => {
    const s = segmentsOf(parts({ request: 0.12, specInput: 0.02 }), null);
    expect(s.other).toBeCloseTo(0.12, 12);
    expect(s.count).toBeCloseTo(0.02, 12);
  });

  it("上游报价不可拆——报过来就是一个数，整笔进「其它」", () => {
    const s = segmentsOf(parts({ reported: 0.07 }), "image");
    expect(s.other).toBeCloseTo(0.07, 12);
    expect(sumSegments(s)).toBeCloseTo(0.07, 12);
  });

  // 折算只是分流，不是重算。一分钱都不能在这里丢掉或凭空长出来——
  // 丢了段长相加就不等于总额，长出来的那部分则谁也解释不了。
  it("守恒律：任意 parts × 任意 unit，六段之和 === totalOf", () => {
    const units: (OutputUnit | null)[] = ["image", "second", "clip", null];
    let seed = 20260922;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 10;
    };
    for (let i = 0; i < 400; i++) {
      const p = parts({
        input: rnd(), cache: rnd(), output: rnd(),
        request: rnd(), spec: rnd(), specInput: rnd(), reported: rnd(),
      });
      const unit = units[i % units.length];
      expect(sumSegments(segmentsOf(p, unit))).toBeCloseTo(totalOf(p), 10);
    }
  });
});

describe("hasReportedCost · 空 ≠ 零", () => {
  it.each([
    [null, false], [undefined, false], [NaN, false], [-1, false], [Infinity, false],
    [0, true], [0.07, true],
  ])("%s → %s", (v, ok) => expect(hasReportedCost(v as number | null)).toBe(ok));
});

describe("归一化：请求值、回显值、表里的条件三方过同一个函数", () => {
  it.each([
    ["1k", "1K"], ["1.5K", "1.5K"], ["768P", "768p"],
    ["1024*1024", "1024x1024"], ["1024×1024", "1024x1024"], [" 1024 X 1024 ", "1024x1024"],
  ])("%s → %s", (raw, want) => expect(normalizeSize(raw)).toBe(want));

  it.each(["", "auto", "not_set", "adaptive", "  "])("「让上游决定」的 %s 读成空", (raw) => {
    expect(normalizeSize(raw)).toBeUndefined();
  });

  it.each([[8, 8], ["8", 8], ["8s", 8], [0, undefined], [-3, undefined], ["x", undefined]])(
    "时长 %s → %s", (raw, want) => expect(normalizeSeconds(raw)).toBe(want),
  );

  it("空维度不写进规格", () => {
    expect(normalizeSpec({ size: "auto", quality: " HIGH ", seconds: 0 })).toEqual({ quality: "high" });
  });

  it("标签只写有的维度", () => {
    expect(specLabel({ size: "1K", seconds: 8 })).toBe("1K · 8s");
  });
});

describe("matchRate", () => {
  const rates: SpecRate[] = [
    { price: 0.02 },                                 // 兜底
    { size: "1K", price: 0.04 },
    { size: "2K", price: 0.06 },
    { size: "2K", quality: "high", price: 0.1 },
  ];

  it("空条件匹配一切，包括没有值的维度", () => {
    expect(matchRate([{ price: 0.02 }], {})?.price).toBe(0.02);
    expect(matchRate([{ price: 0.02 }], { size: "4K", quality: "low" })?.price).toBe(0.02);
  });

  it("填得最多的行赢", () => {
    expect(matchRate(rates, { size: "2K", quality: "high" })?.price).toBe(0.1);
    expect(matchRate(rates, { size: "2K" })?.price).toBe(0.06);
    expect(matchRate(rates, { size: "8K" })?.price).toBe(0.02);
  });

  it("同样具体时先写的赢", () => {
    const tie: SpecRate[] = [{ size: "1K", price: 0.04 }, { size: "1K", price: 0.09 }];
    expect(matchRate(tie, { size: "1K" })?.price).toBe(0.04);
  });

  it("没有兜底行、也没有能匹配的条件 ⇒ null（未覆盖），不悄悄挑一行凑数", () => {
    expect(matchRate([{ quality: "high", price: 0.04 }], { quality: "low" })).toBeNull();
  });

  it("精确尺寸压过靠面积落进来的档位", () => {
    const both: SpecRate[] = [{ size: "1K", price: 0.04 }, { size: "1024x1024", price: 0.07 }];
    expect(matchRate(both, { size: "1024x1024" })?.price).toBe(0.07);
  });

  it("specificity 数的是填了几个条件", () => {
    expect(specificity({ price: 0 })).toBe(0);
    expect(specificity({ size: "1K", quality: "high", seconds: 8, price: 0 })).toBe(3);
  });
});

describe("tierOf · 按面积落档，只在表里真有的档之间比", () => {
  const table = (...sizes: string[]) => sizes.map((size) => ({ size, price: 1 }));

  it("1696x960（1.63MP）落 1K（1.05MP）而不是 2K（4.19MP）——对数尺度上更近", () => {
    expect(tierOf("1696x960", table("1K", "2K"))).toBe("1K");
  });

  it("2048x2048（4.19MP）正好是 2K", () => {
    expect(tierOf("2048x2048", table("1K", "2K"))).toBe("2K");
  });

  it("表里有 1.5K 就按那家的分法切", () => {
    expect(tierOf("1696x960", table("1K", "1.5K", "2K"))).toBe("1.5K");
  });

  it("表里没有 NK 档时不归档", () => {
    expect(tierOf("1696x960", table("1024x1024"))).toBeUndefined();
  });

  it("本来就是档名的尺寸不再归档", () => {
    expect(tierOf("1K", table("1K", "2K"))).toBeUndefined();
  });
});

describe("priceSpec · 输入图一侧", () => {
  const f = fee({
    billingMode: "spec", outputUnit: "image",
    outputRates: [{ price: 0.04 }], inputUnitPrice: 0.01, inputFreeUnits: 1,
  });

  it("免费额度按每次请求扣", () => {
    expect(priceSpec(f, {}, { outputUnits: 1, inputImages: 3 }).inputUnits).toBe(2);
  });

  it("发出去的张数与计费张数分开存", () => {
    const p = priceSpec(f, {}, { outputUnits: 1, inputImages: 1 });
    expect(p.inputImages).toBe(1);
    expect(p.inputUnits).toBe(0);
  });

  it("一张都没交付 ⇒ 输出 0，输入也 0", () => {
    const p = priceSpec(f, {}, { outputUnits: 0, inputImages: 3 });
    expect(p.outputUnits).toBe(0);
    expect(p.inputUnits).toBe(0);
    expect(p.inputImages).toBe(3);
  });

  it("按次模式一律算交付了：按次 ＝ 按成功请求", () => {
    const req = fee({ billingMode: "request", requestPrice: 0.04, inputUnitPrice: 0.01 });
    expect(priceSpec(req, {}, { outputUnits: 0, inputImages: 2 }).inputUnits).toBe(2);
  });

  it("按 token 的组不收输入图：它的图已经算进 token 里", () => {
    const tok = fee({ inputPrice: 3, inputUnitPrice: 0.01 });
    expect(priceSpec(tok, {}, { outputUnits: 1, inputImages: 3 }).inputUnits).toBe(0);
  });

  it("非按规格的模式不报「未覆盖」——它根本没有档位表", () => {
    expect(priceSpec(fee({ billingMode: "token" }), {}, { outputUnits: 0, inputImages: 0 }).matched).toBe(true);
  });
});
