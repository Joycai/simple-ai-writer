/**
 * lib/ai/feeGroupDb —— 行与列，以及从模型上搬价那一次性的一步。
 *
 * 两类静默错法在这里钉住：**错类型的格读作缺失**（SQLite 把文本存进 REAL
 * 列不报错，一行按模式整体解码时一个手改坏的格不能让整页失败），以及
 * **迁移把「没填」读成「0」**——老的 `price_cached_in` 列有 `NOT NULL
 * DEFAULT 0`，照搬会让所有老配置一夜之间缓存全免费。
 */
import { describe, expect, it } from "vitest";

import { parseSpecRates, planFeeGroupsFromLegacy, rowToFeeGroup, serializeSpecRates } from "../feeGroupDb";
import type { LegacyPricedModel } from "../feeGroupDb";

describe("rowToFeeGroup", () => {
  it("读一行正常的组", () => {
    const g = rowToFeeGroup({
      id: "g1", name: "Sonnet", billing_mode: "token",
      input_price: 3, cache_input_price: 0.3, output_price: 15,
      request_price: 0, output_unit: "image", output_rates: null,
      input_unit_price: 0, input_free_units: 0, created_at: 100,
    });
    expect(g).toMatchObject({ id: "g1", name: "Sonnet", billingMode: "token", inputPrice: 3, cacheInputPrice: 0.3 });
  });

  it("缓存价的 NULL 读成 null（＝同输入价），0 读成 0（＝真免费）", () => {
    expect(rowToFeeGroup({ cache_input_price: null }).cacheInputPrice).toBeNull();
    expect(rowToFeeGroup({ cache_input_price: 0 }).cacheInputPrice).toBe(0);
  });

  it("手改坏的格读作缺失，而不是让整行失败", () => {
    const g = rowToFeeGroup({ input_price: "三块", cache_input_price: "空", input_free_units: "一张" });
    expect(g.inputPrice).toBe(0);
    expect(g.cacheInputPrice).toBeNull();
    expect(g.inputFreeUnits).toBe(0);
  });

  it("未知的计价方式按 token 读——这个应用历史上唯一的解释", () => {
    expect(rowToFeeGroup({ billing_mode: "按心情" }).billingMode).toBe("token");
  });
});

describe("parseSpecRates", () => {
  it.each([null, "", "   ", "{坏 JSON", '{"not":"array"}'])("%s 读成空表，不抛", (raw) => {
    expect(parseSpecRates(raw)).toEqual([]);
  });

  it("条件在读回来的时候再过一遍归一化——手改过的库和跨版本的备份都要认", () => {
    const rates = parseSpecRates(JSON.stringify([{ size: "1k", quality: " HIGH ", seconds: "8s", price: 0.1 }]));
    expect(rates).toEqual([{ price: 0.1, size: "1K", quality: "high", seconds: 8 }]);
  });

  it("没填价的行留着（整行按 0 计），坏价读成 0", () => {
    expect(parseSpecRates(JSON.stringify([{ size: "1K", price: "贵" }]))).toEqual([{ price: 0, size: "1K" }]);
  });

  it("空表序列化成 NULL，不是 '[]'——读回来是同一回事，但列里少一串字节", () => {
    expect(serializeSpecRates([])).toBeNull();
  });

  it("round-trip 只带上真的填了的条件", () => {
    const rates = [{ size: "1K", price: 0.04 }, { price: 0.02 }];
    expect(parseSpecRates(serializeSpecRates(rates)!)).toEqual(rates);
  });
});

describe("planFeeGroupsFromLegacy · 把模型上的旧价归并成组", () => {
  const m = (over: Partial<LegacyPricedModel>): LegacyPricedModel => ({
    id: "m", name: "M", priceIn: 0, priceCachedIn: 0, priceOut: 0, ...over,
  });
  const idFor = (i: number) => `fg${i}`;

  it("同一份价只建一个组——这正是这次改动的理由", () => {
    const { groups, binding } = planFeeGroupsFromLegacy(
      [
        m({ id: "a", name: "A", priceIn: 3, priceOut: 15 }),
        m({ id: "b", name: "B", priceIn: 3, priceOut: 15 }),
        m({ id: "c", name: "C", priceIn: 0.8, priceOut: 2.4 }),
      ],
      0, idFor,
    );
    expect(groups).toHaveLength(2);
    expect(binding.get("a")).toBe(binding.get("b"));
    expect(binding.get("c")).not.toBe(binding.get("a"));
  });

  it("老的 price_cached_in 是 NOT NULL DEFAULT 0：0 迁成 null，不是 0", () => {
    // 把「没填」当成「真免费」，所有老配置会一夜之间缓存不要钱。
    const { groups } = planFeeGroupsFromLegacy([m({ priceIn: 3, priceCachedIn: 0, priceOut: 15 })], 0, idFor);
    expect(groups[0].cacheInputPrice).toBeNull();
  });

  it("填了缓存价就原样带过去", () => {
    const { groups } = planFeeGroupsFromLegacy([m({ priceIn: 3, priceCachedIn: 0.3 })], 0, idFor);
    expect(groups[0].cacheInputPrice).toBe(0.3);
  });

  it("每张价 → 按张的组，一行全空条件的兜底价", () => {
    const { groups } = planFeeGroupsFromLegacy([m({ pricePerImage: 0.04 })], 0, idFor);
    expect(groups[0]).toMatchObject({ billingMode: "spec", outputUnit: "image", outputRates: [{ price: 0.04 }] });
  });

  it("每秒价 → 按秒的组", () => {
    const { groups } = planFeeGroupsFromLegacy([m({ pricePerSecond: 0.00022 })], 0, idFor);
    expect(groups[0]).toMatchObject({ billingMode: "spec", outputUnit: "second", outputRates: [{ price: 0.00022 }] });
  });

  it("两边都填了：按规格建组，token 价照样写进同一行（切模式时还在）", () => {
    const { groups } = planFeeGroupsFromLegacy([m({ pricePerImage: 0.04, priceIn: 5, priceOut: 40 })], 0, idFor);
    expect(groups[0].billingMode).toBe("spec");
    expect(groups[0].inputPrice).toBe(5);
    expect(groups[0].outputPrice).toBe(40);
  });

  it("每张价与每秒价不同的两个模型不会被归成一组", () => {
    const { groups } = planFeeGroupsFromLegacy(
      [m({ id: "a", pricePerImage: 0.04 }), m({ id: "b", pricePerSecond: 0.04 })], 0, idFor,
    );
    expect(groups).toHaveLength(2);
  });

  it("一分钱没填的模型不建组、也不绑——那不是一份价，是没配", () => {
    const { groups, binding } = planFeeGroupsFromLegacy([m({ id: "a" })], 0, idFor);
    expect(groups).toHaveLength(0);
    expect(binding.has("a")).toBe(false);
  });
});
