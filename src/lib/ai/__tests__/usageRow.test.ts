/**
 * lib/ai/usageRow —— 记一次请求的那个唯一写入口。
 *
 * 这个模块的错法有一个共同点：**记错钱不会报错**。少写一列、把 NULL 读成
 * 0、把「没报价」读成「报了 0」，界面照常渲染，数字照常对齐，只是那个数
 * 不对。所以每一条都单独钉住。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectExecute = vi.fn(async () => {});
const globalExecute = vi.fn(async () => {});
vi.mock("../../project", () => ({
  getDb: vi.fn(async () => ({ execute: projectExecute })),
  getGlobalDb: vi.fn(async () => ({ execute: globalExecute })),
}));

import { buildUsageRow, recordUsage } from "../usageRow";
import type { RecordUsageInput, UsageRowValues } from "../usageRow";
import { ZERO_FEE, type FeeConfig } from "../feeGroup";
import { costFor } from "../configDb";

const fee = (over: Partial<FeeConfig> = {}): FeeConfig => ({ ...ZERO_FEE, ...over });
const model = (f?: FeeConfig) => ({ id: "m1", fee: f });

/** 把 INSERT 的参数按 SQL 自己的列名对回去——列的顺序换了不该让这条失败。 */
function rowOf(call: unknown[]): Record<string, unknown> {
  const [sql, params] = call as [string, unknown[]];
  const columns = sql.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
  return Object.fromEntries(columns.map((c, i) => [c, params[i]]));
}

beforeEach(() => vi.clearAllMocks());

describe("buildUsageRow · 按 token", () => {
  it("时间戳是 unix 秒——和每个插入点写 created_at 的口径一致", () => {
    const input: RecordUsageInput = { model: model(), task: "chat" };
    const r: UsageRowValues = buildUsageRow(input, 1_785_974_400_123);
    expect(r.createdAt).toBe(1_785_974_400);
  });

  it("输入与缓存在行上不重叠：prompt 是全部，两段之和才是它", () => {
    const r = buildUsageRow({
      model: model(fee({ inputPrice: 3, cachePrice: 0.3, outputPrice: 15 })),
      task: "chat", promptTokens: 1000, cachedTokens: 400, completionTokens: 200,
    });
    // 表的口径没变：`prompt_tokens` 是全部，`cached_tokens` 是它的子集。
    expect(r.promptTokens).toBe(1000);
    expect(r.cachedTokens).toBe(400);
    // 算钱那一侧才分成不重叠的两段。
    expect(r.billed.inputTokens).toBe(600);
    expect(r.billed.cacheTokens).toBe(400);
    expect(r.costUsd).toBeCloseTo((600 * 3 + 400 * 0.3 + 200 * 15) / 1e6, 12);
  });

  it("缓存 token 比 prompt 还多时夹住，不让缓存那一段算出负的输入", () => {
    const r = buildUsageRow({
      model: model(fee({ inputPrice: 3, cachePrice: 0.3 })),
      task: "chat", promptTokens: 100, cachedTokens: 500,
    });
    expect(r.billed.inputTokens).toBe(0);
    expect(r.billed.cacheTokens).toBe(100);
  });

  it("组没填缓存价时，行上快照的是**输入价**而不是 0", () => {
    // 留空 ＝ 同输入价。写 0 会让这一行日后被读成「缓存免费」。
    const r = buildUsageRow({
      model: model(fee({ inputPrice: 3, cachePrice: 3 })),
      task: "chat", promptTokens: 1000, cachedTokens: 1000,
    });
    expect(r.billed.cachePrice).toBe(3);
    expect(r.costUsd).toBeCloseTo(1000 * 3 / 1e6, 12);
  });

  it("没绑组 ＝ 一分不收，但量照记", () => {
    const r = buildUsageRow({ model: model(), task: "chat", promptTokens: 900, completionTokens: 100 });
    expect(r.costUsd).toBe(0);
    expect(r.promptTokens).toBe(900);
    expect(r.completionTokens).toBe(100);
  });
});

describe("buildUsageRow · 按规格", () => {
  const spec = fee({
    billingMode: "spec", outputUnit: "image",
    outputRates: [{ size: "1K", price: 0.04 }, { size: "2K", quality: "high", price: 0.1 }],
    inputUnitPrice: 0.01, inputFreeUnits: 1,
  });

  it("命中最具体的那一行，并把规格与命中与否一起快照下来", () => {
    const r = buildUsageRow({
      model: model(spec), task: "image-gen", outputUnits: 1,
      spec: { size: "2k", quality: " HIGH " },
    });
    expect(r.priced.matched).toBe(true);
    expect(r.priced.outputUnitPrice).toBe(0.1);
    // 归一化在匹配之前：`2k` 与 ` HIGH ` 都要认。
    expect(r.priced.spec).toEqual({ size: "2K", quality: "high" });
  });

  it("没命中就按 0 计，并且把规格原样留在行上——那正是要补进表里的一行", () => {
    const r = buildUsageRow({
      model: model(spec), task: "image-gen", outputUnits: 1, spec: { quality: "low" },
    });
    expect(r.priced.matched).toBe(false);
    expect(r.costUsd).toBe(0);
    expect(r.priced.spec).toEqual({ quality: "low" });
  });

  it("发出去的张数与计费张数分开存：发 1 张免 1 张，和没发都是 0，只有前者该显示", () => {
    const sent = buildUsageRow({
      model: model(spec), task: "image-edit", outputUnits: 1, spec: { size: "1K" }, inputImages: 1,
    });
    expect(sent.priced.inputImages).toBe(1);
    expect(sent.priced.inputUnits).toBe(0);
    const none = buildUsageRow({
      model: model(spec), task: "image-gen", outputUnits: 1, spec: { size: "1K" },
    });
    expect(none.priced.inputImages).toBe(0);
    expect(none.priced.inputUnits).toBe(0);
  });

  it("一张都没交付：输出 0，输入图也不收", () => {
    const r = buildUsageRow({
      model: model(spec), task: "image-gen", outputUnits: 0, spec: { size: "1K" }, inputImages: 3,
    });
    expect(r.costUsd).toBe(0);
    expect(r.priced.inputUnits).toBe(0);
    // 发了 3 张这件事仍然记着：没收是因为失败，不是因为免。
    expect(r.priced.inputImages).toBe(3);
  });
});

describe("buildUsageRow · 上游报价", () => {
  const spec = fee({ billingMode: "spec", outputUnit: "image", outputRates: [{ price: 0.04 }] });

  it("有报价就压过整张表，而档位估算照样留在行上", () => {
    const r = buildUsageRow({
      model: model(spec), task: "image-gen", outputUnits: 2, reportedCost: 0.07,
    });
    expect(r.costUsd).toBeCloseTo(0.07, 12);
    expect(r.priced.outputUnitPrice).toBe(0.04);
  });

  it("上游说 0 就是 0；没报（null）才回到表", () => {
    expect(buildUsageRow({ model: model(spec), task: "t", outputUnits: 2, reportedCost: 0 }).costUsd).toBe(0);
    expect(buildUsageRow({ model: model(spec), task: "t", outputUnits: 2 }).costUsd).toBeCloseTo(0.08, 12);
  });

  it("负数 / 非有限的报价当没报", () => {
    expect(buildUsageRow({ model: model(spec), task: "t", outputUnits: 2, reportedCost: -1 }).costUsd)
      .toBeCloseTo(0.08, 12);
    expect(buildUsageRow({ model: model(spec), task: "t", outputUnits: 2, reportedCost: NaN }).costUsd)
      .toBeCloseTo(0.08, 12);
  });
});

describe("costFor · 草稿上显示的数与账上同一口径", () => {
  const tokens = fee({ inputPrice: 1, outputPrice: 2 });

  it("有上游报价就显示报价，和 buildUsageRow 记的一样", () => {
    const shown = costFor(model(tokens), 1_000_000, 1_000_000, 0, 0.003);
    const row = buildUsageRow({ model: model(tokens), task: "chat", promptTokens: 1_000_000, completionTokens: 1_000_000, reportedCost: 0.003 });
    expect(shown).toBeCloseTo(0.003, 12);
    expect(row.costUsd).toBeCloseTo(shown, 12);
  });

  it("没报（null / 省略）照计费组算", () => {
    expect(costFor(model(tokens), 1_000_000, 1_000_000, 0, null)).toBeCloseTo(3, 12);
    expect(costFor(model(tokens), 1_000_000, 1_000_000)).toBeCloseTo(3, 12);
  });

  it("没有计费组的模型，报价照样算得出钱", () => {
    expect(costFor(model(), 10, 10, 0, 0.001)).toBeCloseTo(0.001, 12);
  });
});

describe("buildUsageRow · 分项的钱", () => {
  // 分项是 `costOf()` 同一次结果的分流，不是重算。一行上六段加起来对不上
  // 这一行的总额，用量页的条就会比行尾那个金额短一截或长一截——而那种
  // 不一致没有任何东西会报错。
  const sumSeg = (r: UsageRowValues) => {
    const s = r.segments;
    return s.input + s.cache + s.output + s.count + s.duration + s.other;
  };

  it("按 token：三段落到输入 / 缓存 / 输出，其余三段空着", () => {
    const r = buildUsageRow({
      model: model(fee({ inputPrice: 3, cachePrice: 0.3, outputPrice: 15 })),
      task: "chat", promptTokens: 1000, cachedTokens: 400, completionTokens: 200,
    });
    expect(r.segments.input).toBeCloseTo(600 * 3 / 1e6, 12);
    expect(r.segments.cache).toBeCloseTo(400 * 0.3 / 1e6, 12);
    expect(r.segments.output).toBeCloseTo(200 * 15 / 1e6, 12);
    expect(r.segments.count + r.segments.duration + r.segments.other).toBe(0);
    expect(sumSeg(r)).toBeCloseTo(r.costUsd, 12);
  });

  it("按张：出图与输入图都落进「张数」这一段", () => {
    const r = buildUsageRow({
      model: model(fee({
        billingMode: "spec", outputUnit: "image", outputRates: [{ price: 0.04 }],
        inputUnitPrice: 0.01,
      })),
      task: "image-gen", outputUnits: 2, inputImages: 3,
    });
    expect(r.segments.count).toBeCloseTo(2 * 0.04 + 3 * 0.01, 12);
    expect(r.segments.duration).toBe(0);
    expect(sumSeg(r)).toBeCloseTo(r.costUsd, 12);
  });

  it("按秒：规格的钱落进「时长」，输入图仍然算「张数」", () => {
    const r = buildUsageRow({
      model: model(fee({
        billingMode: "spec", outputUnit: "second", outputRates: [{ price: 0.002 }],
        inputUnitPrice: 0.01,
      })),
      task: "transcribe", outputUnits: 300, inputImages: 1,
    });
    expect(r.segments.duration).toBeCloseTo(300 * 0.002, 12);
    expect(r.segments.count).toBeCloseTo(0.01, 12);
    expect(sumSeg(r)).toBeCloseTo(r.costUsd, 12);
  });

  it("按次：固定价五段装不下，落进「其它」", () => {
    const r = buildUsageRow({
      model: model(fee({ billingMode: "request", requestPrice: 0.04 })),
      task: "chat", promptTokens: 1000, completionTokens: 500, requests: 3,
    });
    expect(r.segments.other).toBeCloseTo(0.12, 12);
    expect(r.segments.input + r.segments.output).toBe(0);
    expect(sumSeg(r)).toBeCloseTo(r.costUsd, 12);
  });

  it("上游报价不可拆，整笔进「其它」——哪怕这是个按张的组", () => {
    const r = buildUsageRow({
      model: model(fee({ billingMode: "spec", outputUnit: "image", outputRates: [{ price: 0.04 }] })),
      task: "image-gen", outputUnits: 2, reportedCost: 0.07,
    });
    expect(r.segments.other).toBeCloseTo(0.07, 12);
    expect(r.segments.count).toBe(0);
    expect(sumSeg(r)).toBeCloseTo(r.costUsd, 12);
  });

  // commit-2 的 review 指出的潜在坑：`priced.outputUnit` 在**非 spec 模式**下
  // 也不是 null，而是组上那个默认值。今天无害——`costOf()` 的 token 分支让
  // `spec` / `specInput` 恒为 0，单位再错也乘不动任何非零的数。钉在这里，是为了
  // 哪天有人让 token 模式也产生规格侧的钱时，坏的是一条测试而不是一批人的账。
  it("按 token 的组即使单位写着「按秒」，钱也不会跑进「时长」段", () => {
    const r = buildUsageRow({
      model: model(fee({ outputUnit: "second", inputPrice: 3, outputPrice: 15 })),
      task: "chat", promptTokens: 1000, completionTokens: 200,
    });
    expect(r.segments.duration).toBe(0);
    expect(r.segments.count).toBe(0);
    expect(r.segments.input + r.segments.output).toBeCloseTo(r.costUsd, 12);
  });

  it("六段跟着 INSERT 一起写下去，列名对得上", async () => {
    await recordUsage("/proj", {
      model: model(fee({ inputPrice: 3, outputPrice: 15 })),
      task: "chat", promptTokens: 1000, completionTokens: 200,
    });
    const row = rowOf(projectExecute.mock.calls[0]);
    expect(row.cost_input).toBeCloseTo(1000 * 3 / 1e6, 12);
    expect(row.cost_output).toBeCloseTo(200 * 15 / 1e6, 12);
    expect(row.cost_cache).toBe(0);
    expect(row.cost_count).toBe(0);
    expect(row.cost_duration).toBe(0);
    expect(row.cost_other).toBe(0);
    // 当场盖章。不盖的话回填每次开库都会把这一行重扫重算一遍——写的值一样，
    // 但那个「还没看过」的部分索引再也空不下来，收敛就没了。
    expect(row.cost_split_checked).toBe(1);
  });
});

describe("recordUsage", () => {
  it("一次请求记两处：项目库和总账，总账那一行多带项目路径", async () => {
    await recordUsage("/proj", {
      model: model(fee({ inputPrice: 3, outputPrice: 15 })),
      task: "chat", promptTokens: 100, completionTokens: 50,
    });
    expect(projectExecute).toHaveBeenCalledTimes(1);
    expect(globalExecute).toHaveBeenCalledTimes(1);
    const p = rowOf(projectExecute.mock.calls[0]);
    const g = rowOf(globalExecute.mock.calls[0]);
    expect(p).toMatchObject({ model_id: "m1", task: "chat", prompt_tokens: 100, completion_tokens: 50 });
    expect(p.project).toBeUndefined();
    expect(g.project).toBe("/proj");
    expect(g.cost_usd).toBe(p.cost_usd);
  });

  it("没开项目时总账照记——它正是比项目活得久的那一本", async () => {
    await recordUsage(null, { model: model(fee({ inputPrice: 1 })), task: "chat", promptTokens: 10 });
    expect(projectExecute).not.toHaveBeenCalled();
    expect(globalExecute).toHaveBeenCalledTimes(1);
  });

  it("一处写失败不影响另一处，而且永不抛错", async () => {
    projectExecute.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      recordUsage("/proj", { model: model(), task: "chat", promptTokens: 1 }),
    ).resolves.toBeUndefined();
    expect(globalExecute).toHaveBeenCalledTimes(1);
  });

  it("行上写下了快照那几列——少一列不会报错，只会让那一行日后算不出钱", async () => {
    await recordUsage("/proj", {
      model: model(fee({
        billingMode: "spec", outputUnit: "image",
        outputRates: [{ size: "1K", price: 0.04 }], inputUnitPrice: 0.01,
      })),
      task: "image-gen", outputUnits: 2, spec: { size: "1K" }, inputImages: 1,
    });
    const row = rowOf(projectExecute.mock.calls[0]);
    expect(row).toMatchObject({
      billing_mode: "spec",
      output_units: 2,
      output_unit_price: 0.04,
      output_unit: "image",
      spec_matched: 1,
      input_images: 1,
      input_units: 1,
      input_unit_price: 0.01,
      reported_cost: null,
    });
    expect(JSON.parse(String(row.output_spec))).toEqual({ size: "1K", matched: true });
  });
});
