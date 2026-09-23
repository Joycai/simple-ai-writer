/**
 * lib/ai/feeGroupDb —— 行与列，以及从模型上搬价那一次性的一步。
 *
 * 两类静默错法在这里钉住：**错类型的格读作缺失**（SQLite 把文本存进 REAL
 * 列不报错，一行按模式整体解码时一个手改坏的格不能让整页失败），以及
 * **迁移把「没填」读成「0」**——老的 `price_cached_in` 列有 `NOT NULL
 * DEFAULT 0`，照搬会让所有老配置一夜之间缓存全免费。
 */
import { describe, expect, it } from "vitest";

import {
  ensureFeeGroupSchema, feeGroupUpsert, migrateModelPricesToFeeGroups, parseSpecRates,
  planFeeGroupsFromLegacy, rowToFeeGroup, serializeSpecRates,
} from "../feeGroupDb";
import type { LegacyPricedModel } from "../feeGroupDb";
import type { FeeGroup } from "../feeGroup";

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

  it("厂商：缺列、空串、只有空白，三种都读成没填", () => {
    // 缺列是老库刚补上 vendor 之前的每一行；空串是手改过的库和跨版本的备份。
    // 三种都必须是同一个 undefined，否则列表会长出一个名字是空的厂商段。
    expect(rowToFeeGroup({ id: "g1" }).vendor).toBeUndefined();
    expect(rowToFeeGroup({ vendor: "" }).vendor).toBeUndefined();
    expect(rowToFeeGroup({ vendor: "   " }).vendor).toBeUndefined();
    expect(rowToFeeGroup({ vendor: 42 }).vendor).toBeUndefined();
  });

  it("厂商前后的空白去掉，中间的写法原样留着", () => {
    expect(rowToFeeGroup({ vendor: "  字节 · 火山方舟 " }).vendor).toBe("字节 · 火山方舟");
  });
});

/**
 * 写的那一侧**没有编译器兜底**：列清单、`VALUES` 的占位符、`ON CONFLICT DO
 * UPDATE SET` 与 `values` 数组是四份互相独立的名单，漏掉一处不会报错，只会
 * 让那一列永远存不进去（或者整条语句参数对不上）。所以这里按数量与顺序钉。
 */
describe("feeGroupUpsert", () => {
  const group = (patch: Partial<FeeGroup> = {}): FeeGroup => ({
    id: "g1", name: "即梦 4.0", billingMode: "spec",
    inputPrice: 0, cacheInputPrice: null, outputPrice: 0, requestPrice: 0,
    outputUnit: "image", outputRates: [{ price: 0.04 }],
    inputUnitPrice: 0, inputFreeUnits: 0, createdAt: 100, ...patch,
  });

  const columnsOf = (sql: string) => /\(([^)]*)\)\s*VALUES/.exec(sql)![1].split(",").map((c) => c.trim());

  it("列清单、占位符、values 三者长度一致", () => {
    const { sql, values } = feeGroupUpsert(group());
    const columns = columnsOf(sql);
    const placeholders = /VALUES\s*\(([^)]*)\)/.exec(sql)![1].split(",").length;
    expect(columns).toHaveLength(values.length);
    expect(placeholders).toBe(values.length);
  });

  it("vendor 在四处名单上都有，且 values 里的位置和列清单对得上", () => {
    const { sql, values } = feeGroupUpsert(group({ vendor: "字节 · 火山方舟" }));
    const columns = columnsOf(sql);
    expect(columns).toContain("vendor");
    expect(sql).toMatch(/vendor = excluded\.vendor/);
    expect(values[columns.indexOf("vendor")]).toBe("字节 · 火山方舟");
  });

  it("没填的厂商写 null，不写空串——库里「没填」只有一种长相", () => {
    const columns = columnsOf(feeGroupUpsert(group()).sql);
    for (const v of [undefined, "", "   "]) {
      const { values } = feeGroupUpsert(group({ vendor: v }));
      expect(values[columns.indexOf("vendor")]).toBeNull();
    }
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

/**
 * 补列这一步**没有任何界面会报错**：老库缺了 `vendor`，`SELECT *` 照样返回，
 * 厂商只是永远读成空、存不进去。所以「老库升上来会不会真的发出 ALTER」要钉住。
 */
describe("ensureFeeGroupSchema", () => {
  /** `PRAGMA table_info` 答什么列、`execute` 收到哪些语句。 */
  function fakeDb(columns: string[], onExecute?: (sql: string) => void) {
    const executed: string[] = [];
    const db = {
      execute: async (sql: string) => {
        executed.push(sql);
        onExecute?.(sql);
        return { rowsAffected: 0, lastInsertId: 0 };
      },
      select: async () => columns.map((name) => ({ name })),
    };
    return { db: db as unknown as Parameters<typeof ensureFeeGroupSchema>[0], executed };
  }

  const alters = (executed: string[]) => executed.filter((sql) => /ALTER TABLE/i.test(sql));

  it("老库缺 vendor 时补一列", async () => {
    const { db, executed } = fakeDb(["id", "name", "billing_mode"]);
    await ensureFeeGroupSchema(db);
    expect(alters(executed)).toEqual(["ALTER TABLE fee_groups ADD COLUMN vendor TEXT"]);
  });

  it("列已经在就不再补——补列这一步每次启动都跑", async () => {
    const { db, executed } = fakeDb(["id", "name", "vendor", "billing_mode"]);
    await ensureFeeGroupSchema(db);
    expect(alters(executed)).toEqual([]);
  });

  it("抢输给另一个窗口时当成功：那正是这一步想要的结果", async () => {
    // 「先读列、再补缺的」不是原子的。另一个进程在读和写之间把列加上了，
    // SQLite 回 duplicate column name——列在了，这一步的目的达到了。
    const { db } = fakeDb([], (sql) => {
      if (/ALTER TABLE/i.test(sql)) throw new Error("duplicate column name: vendor");
    });
    await expect(ensureFeeGroupSchema(db)).resolves.toBeUndefined();
  });

  it("别的失败照样抛出去——磁盘满了不能读成「补好了」", async () => {
    const { db } = fakeDb([], (sql) => {
      if (/ALTER TABLE/i.test(sql)) throw new Error("database or disk is full");
    });
    await expect(ensureFeeGroupSchema(db)).rejects.toThrow(/disk is full/);
  });
});

/**
 * 真正读写库的那一步。仓库里没有真 SQLite，这里用一张够用的内存表：只认
 * 这个函数发出的四类语句（选未迁移的模型行、列出组、插一个组、按 id 更新
 * 模型行），别的语句一律抛——函数多发了一条没预料到的语句，测试应当知道。
 *
 * 要钉的是：**已经绑了组的行，不管旧价是多少，都只盖章不造组。** 标记曾经
 * 被 `modelUpsert` 每写一次就清回 NULL，组价又改过的话，旧价对不上任何组，
 * 迁移就会按模型名插一个重复组。
 */
describe("migrateModelPricesToFeeGroups", () => {
  interface ModelRow {
    id: string; name: string;
    fee_group_id: string | null; fee_migrated: number | null;
    price_in: number; price_cached_in: number; price_out: number;
    price_per_image: number | null; price_per_second: number | null;
  }

  function memoryDb(models: ModelRow[], groups: Record<string, unknown>[]) {
    const db = {
      select: async (sql: string) => {
        if (/FROM models WHERE fee_migrated IS NULL/.test(sql)) {
          return models
            .filter((m) => m.fee_migrated === null)
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
            .map((m) => ({ ...m }));
        }
        if (/FROM fee_groups/.test(sql)) return groups.map((g) => ({ ...g }));
        throw new Error(`unexpected select: ${sql}`);
      },
      execute: async (sql: string, values: unknown[] = []) => {
        if (/^\s*INSERT INTO fee_groups/.test(sql)) {
          const cols = /\(([^)]*)\)\s*VALUES/.exec(sql)![1].split(",").map((c) => c.trim());
          groups.push(Object.fromEntries(cols.map((c, i) => [c, values[i]])));
        } else if (/^\s*UPDATE models SET fee_group_id = COALESCE\(fee_group_id, \?\), fee_migrated = 1 WHERE id = \?/.test(sql)) {
          const m = models.find((x) => x.id === values[1])!;
          m.fee_group_id = m.fee_group_id ?? (values[0] as string | null);
          m.fee_migrated = 1;
        } else {
          throw new Error(`unexpected execute: ${sql}`);
        }
        return { rowsAffected: 1, lastInsertId: 0 };
      },
    };
    return db as unknown as Parameters<typeof migrateModelPricesToFeeGroups>[0];
  }

  const model = (patch: Partial<ModelRow> & { id: string }): ModelRow => ({
    name: patch.id, fee_group_id: null, fee_migrated: null,
    price_in: 0, price_cached_in: 0, price_out: 0, price_per_image: null, price_per_second: null,
    ...patch,
  });
  /** 组价后来被改过的那一组：输入 2.5，而模型行上的旧价还是 3。 */
  const editedGroup = () => ({
    id: "g-edited", name: "Sonnet", billing_mode: "token",
    input_price: 2.5, cache_input_price: null, output_price: 15, request_price: 0,
    output_unit: "image", output_rates: null, input_unit_price: 0, input_free_units: 0,
    created_at: 1,
  });

  it("已绑组的行丢了标记、旧价又对不上组价：不造组、绑定不变、盖章", async () => {
    const models = [model({ id: "m1", fee_group_id: "g-edited", price_in: 3, price_out: 15 })];
    const groups = [editedGroup()];
    const created = await migrateModelPricesToFeeGroups(memoryDb(models, groups));
    expect(created).toBe(0);
    expect(groups.map((g) => g.id)).toEqual(["g-edited"]);
    expect(models[0]).toMatchObject({ fee_group_id: "g-edited", fee_migrated: 1 });
  });

  it("没绑组、带旧价的行：建一个组并绑上——老版本升上来的正路", async () => {
    const models = [model({ id: "m1", name: "Sonnet", price_in: 3, price_out: 15 })];
    const groups: Record<string, unknown>[] = [];
    const created = await migrateModelPricesToFeeGroups(memoryDb(models, groups));
    expect(created).toBe(1);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: "Sonnet", input_price: 3, output_price: 15 });
    expect(models[0]).toMatchObject({ fee_group_id: groups[0].id, fee_migrated: 1 });
  });

  it("没绑组、旧价和现有的组一样：复用那个组，不长重复的", async () => {
    const same = { ...editedGroup(), id: "g-same", input_price: 3 };
    const models = [model({ id: "m1", price_in: 3, price_out: 15 })];
    const groups = [same];
    const created = await migrateModelPricesToFeeGroups(memoryDb(models, groups));
    expect(created).toBe(0);
    expect(groups).toHaveLength(1);
    expect(models[0]).toMatchObject({ fee_group_id: "g-same", fee_migrated: 1 });
  });

  it("没绑组、旧价全是 0：不造组、保持未绑定、盖章", async () => {
    const models = [model({ id: "m1" })];
    const groups: Record<string, unknown>[] = [];
    await migrateModelPricesToFeeGroups(memoryDb(models, groups));
    expect(groups).toHaveLength(0);
    expect(models[0]).toMatchObject({ fee_group_id: null, fee_migrated: 1 });
  });

  it("已经盖过章的行不被读，也不被写", async () => {
    const models = [model({ id: "m1", price_in: 3, fee_migrated: 1 })];
    const groups: Record<string, unknown>[] = [];
    const created = await migrateModelPricesToFeeGroups(memoryDb(models, groups));
    expect(created).toBe(0);
    expect(groups).toHaveLength(0);
    expect(models[0]).toMatchObject({ fee_group_id: null, fee_migrated: 1 });
  });

  it("一批里有绑的有没绑的：只有没绑的那几行进归并", async () => {
    const models = [
      model({ id: "bound", fee_group_id: "g-edited", price_in: 3, price_out: 15 }),
      model({ id: "free", price_in: 1, price_out: 2 }),
    ];
    const groups = [editedGroup()];
    const created = await migrateModelPricesToFeeGroups(memoryDb(models, groups));
    expect(created).toBe(1);
    expect(groups.map((g) => g.input_price)).toEqual([2.5, 1]);
    expect(models.find((m) => m.id === "bound")).toMatchObject({ fee_group_id: "g-edited", fee_migrated: 1 });
    expect(models.find((m) => m.id === "free")!.fee_group_id).toBe(groups[1].id);
  });
});
