/**
 * lib/ai/feeGroupLabel —— 价格在界面上的说法。
 *
 * 这里守的是两件事：**价格只有一种写法**（列表、抽屉脚、模型抽屉的折行
 * 共用同一个函数），以及**剪尾零不能剪掉数量级**——千问转写是 ¥0.00022 /
 * 秒，按四位剪会印成 0.0002，而那个错在界面上看不出来。
 */
import { describe, expect, it } from "vitest";

import type { FeeGroup } from "../feeGroup";
import {
  feeSummary, feeTags, formatPrice, hasCatchAllRate, isPriced, ratePrices, rateSpan,
  type FeeLabelWords, type FeeTag,
} from "../feeGroupLabel";

const W: FeeLabelWords = {
  token: "按 token", request: "按次",
  perUnit: { image: "按张", second: "按秒", clip: "按条" },
  perMillion: "/M", perRequest: "/次",
  input: "输入", cached: "缓存", output: "输出",
  tiers: (n) => `${n} 档`, noRates: "未填档位", otherSpecsZero: "其他规格按 0 计",
  inputImage: (p) => `输入图 $${p}/张`, inputFree: (n) => `首 ${n} 张免费`,
  unbound: "未绑定",
};

const group = (over: Partial<FeeGroup> = {}): FeeGroup => ({
  id: "g", name: "g", billingMode: "token",
  inputPrice: 0, cacheInputPrice: null, outputPrice: 0, requestPrice: 0,
  outputUnit: "image", outputRates: [], inputUnitPrice: 0, inputFreeUnits: 0,
  createdAt: 0, ...over,
});
const texts = (tags: FeeTag[]) => tags.map((t) => t.text);

describe("formatPrice", () => {
  it.each([[3, "3.00"], [0.5, "0.50"], [0.125, "0.125"], [0, "0.00"]])(
    "%s → %s（尾零剪到至少两位）", (n, want) => expect(formatPrice(n)).toBe(want),
  );

  it("小到 6 位的价不被剪掉数量级", () => {
    // 按四位剪会变成 0.0002，界面上少一个数量级看不出来。
    expect(formatPrice(0.00022)).toBe("0.00022");
  });

  it("非有限的数读作 0，不印 NaN", () => {
    expect(formatPrice(NaN)).toBe("0");
  });
});

describe("feeSummary", () => {
  it("按 token：缓存留空时写出继承来的那个数，而不是留白", () => {
    expect(feeSummary(group({ inputPrice: 3, outputPrice: 15 }), W)).toBe("按 token · 3.00 / 3.00 / 15.00");
  });

  it("按 token：填了 0 就写 0", () => {
    expect(feeSummary(group({ inputPrice: 3, cacheInputPrice: 0, outputPrice: 15 }), W))
      .toBe("按 token · 3.00 / 0.00 / 15.00");
  });

  it("按次", () => {
    expect(feeSummary(group({ billingMode: "request", requestPrice: 0.04 }), W)).toBe("按次 · $0.04/次");
  });

  it("按规格：单位 · 档数 · 价格区间", () => {
    const g = group({
      billingMode: "spec", outputUnit: "image",
      outputRates: [{ price: 0.04 }, { size: "2K", price: 0.1 }],
    });
    expect(feeSummary(g, W)).toBe("按张 · 2 档 · $0.04–0.10");
  });

  it("按规格：一档时不写区间", () => {
    const g = group({ billingMode: "spec", outputUnit: "second", outputRates: [{ price: 0.00022 }] });
    expect(feeSummary(g, W)).toBe("按秒 · 1 档 · $0.00022");
  });

  it("没绑组", () => {
    expect(feeSummary(null, W)).toBe("未绑定");
  });
});

describe("feeTags", () => {
  it("继承来的缓存价标成 derived——它不是作者填的，是推出来的", () => {
    const tags = feeTags(group({ inputPrice: 3, outputPrice: 15 }), W);
    expect(texts(tags)).toEqual(["输入 $3.00/M", "缓存 $3.00/M", "输出 $15.00/M"]);
    expect(tags.map((t) => !!t.derived)).toEqual([false, true, false]);
  });

  it("填了缓存价就不是 derived", () => {
    expect(feeTags(group({ inputPrice: 3, cacheInputPrice: 0.3 }), W)[1].derived).toBeFalsy();
  });

  it("按规格没写兜底行时补一句「其他规格按 0 计」", () => {
    const g = group({ billingMode: "spec", outputRates: [{ size: "1K", price: 0.04 }] });
    expect(texts(feeTags(g, W))).toContain("其他规格按 0 计");
  });

  it("有兜底行就不补那一句", () => {
    const g = group({ billingMode: "spec", outputRates: [{ price: 0.04 }] });
    expect(texts(feeTags(g, W))).not.toContain("其他规格按 0 计");
  });

  it("不收的费不出现：按 token 的组没有输入图那一条", () => {
    const g = group({ inputPrice: 3, inputUnitPrice: 0.01 });
    expect(texts(feeTags(g, W)).join()).not.toContain("输入图");
  });

  it("按次也有输入图那一条——视频端点的参考图是在标价之外另收的", () => {
    const g = group({ billingMode: "request", requestPrice: 0.04, inputUnitPrice: 0.01, inputFreeUnits: 1 });
    expect(texts(feeTags(g, W))).toContain("输入图 $0.01/张 · 首 1 张免费");
  });

  it("单价为 0 时输入图那一条不出现", () => {
    const g = group({ billingMode: "request", requestPrice: 0.04, inputUnitPrice: 0 });
    expect(texts(feeTags(g, W)).join()).not.toContain("输入图");
  });
});

describe("isPriced / ratePrices / rateSpan / hasCatchAllRate", () => {
  it("全 0 的组读作「不收」——行首的方块因此画成虚线", () => {
    expect(isPriced(group())).toBe(false);
    expect(isPriced(group({ inputPrice: 3 }))).toBe(true);
    expect(isPriced(group({ billingMode: "request", requestPrice: 0.04 }))).toBe(true);
    expect(isPriced(group({ billingMode: "spec", outputRates: [{ price: 0 }] }))).toBe(false);
  });

  it("没填价的档不算一档：整行按 0 计，不该被数进「N 档」", () => {
    const g = group({ billingMode: "spec", outputRates: [{ price: 0.04 }, { size: "2K", price: 0 }] });
    expect(ratePrices(g)).toEqual([0.04]);
    expect(rateSpan(g)).toBe("$0.04");
  });

  it("空表没有区间", () => {
    expect(rateSpan(group({ billingMode: "spec" }))).toBe("");
  });

  it("兜底行 ＝ 三个条件都空的那一行", () => {
    expect(hasCatchAllRate(group({ billingMode: "spec", outputRates: [{ price: 1 }] }))).toBe(true);
    expect(hasCatchAllRate(group({ billingMode: "spec", outputRates: [{ size: "1K", price: 1 }] }))).toBe(false);
  });
});
