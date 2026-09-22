/**
 * 计费组的库那一侧：`fee_groups` 表的 CRUD，以及从模型行上的旧价格列
 * 一次性迁出来的那一步。
 *
 * 表放在**全局 config.db**（appDataDir），和 providers / models 同一个库——
 * 组是配置，不是某个项目的数据；同一套价在所有项目里都是同一套。用量行
 * 才分项目（lib/ai/usageRow.ts）。
 *
 * 纯逻辑（模式、档位匹配、算钱）在 `feeGroup.ts`，这里只管行与列。
 */

import type Database from "@tauri-apps/plugin-sql";

import {
  parseBillingMode, parseOutputUnit,
  normalizeQuality, normalizeSeconds, normalizeSize,
  type FeeGroup, type SpecRate,
} from "./feeGroup";

type Db = Awaited<ReturnType<typeof Database.load>>;

/**
 * 可空与默认由语义决定，不是习惯：
 * - `cache_input_price` **可空、无默认**：空 = 同输入价，`0` = 真免费。用
 *   `DEFAULT 0` 加这一列会让所有老组一夜之间缓存全免费。
 * - `input_unit_price` / `input_free_units` 默认 0：0 就是「不收」，多数组的
 *   真实状态。
 * - `vendor` **可空、无默认**：厂商是词不是数，「没填」只有一种长相（NULL），
 *   空串在读和写两侧都折成它。
 */
export async function ensureFeeGroupSchema(db: Db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS fee_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      vendor TEXT,
      billing_mode TEXT NOT NULL DEFAULT 'token',
      input_price REAL NOT NULL DEFAULT 0,
      cache_input_price REAL,
      output_price REAL NOT NULL DEFAULT 0,
      request_price REAL NOT NULL DEFAULT 0,
      output_unit TEXT NOT NULL DEFAULT 'image',
      output_rates TEXT,
      input_unit_price REAL NOT NULL DEFAULT 0,
      input_free_units INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  // 表建完之后补老库缺的列。这一步归这个模块自己管，和 usageSchema.ts 一样：
  // 表结构的唯一归属在哪，补列就在哪。`configDb.ts` 里有一个同样的私有
  // `addColumn`，但它 import 了这个文件（`ensureAiSchema` 第一行），反向借用
  // 会成环——layering.test.ts 的零环约束会当场拦下。
  const cols = await db.select<{ name: string }[]>(`PRAGMA table_info(fee_groups)`);
  await addFeeGroupColumn(db, cols, "vendor", "TEXT");
}

/**
 * `ALTER TABLE … ADD COLUMN`，列已经在就跳过，抢输了也算成功。
 *
 * 「先读列、再补缺的」不是原子的，而这套 schema 检查历史上不止一处跑过：
 * 另一个进程（或另一个窗口）在读和写之间把列加上了，SQLite 会回
 * `duplicate column name`——那正是这个函数本来就想要的结果。
 */
async function addFeeGroupColumn(
  db: Db,
  existing: { name: string }[],
  column: string,
  type: string,
): Promise<void> {
  if (existing.some((c) => c.name === column)) return;
  try {
    await db.execute(`ALTER TABLE fee_groups ADD COLUMN ${column} ${type}`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e))) throw e;
  }
}

/** 空、空白、坏 JSON、非数组都读成**空表**——组按 0 计、用量页标「未覆盖」，不抛。 */
export function parseSpecRates(raw: unknown): SpecRate[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SpecRate[] = [];
  for (const r of parsed) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const price = typeof o.price === "number" && Number.isFinite(o.price) ? o.price : 0;
    // 条件在存进去之前就归一化过；再过一遍是为了手改过的库和跨版本的备份，
    // 匹配那一侧才敢是纯相等。
    const rate: SpecRate = { price };
    const size = normalizeSize(o.size);
    const quality = normalizeQuality(o.quality);
    const seconds = normalizeSeconds(o.seconds);
    if (size) rate.size = size;
    if (quality) rate.quality = quality;
    if (seconds !== undefined) rate.seconds = seconds;
    out.push(rate);
  }
  return out;
}

export function serializeSpecRates(rates: SpecRate[]): string | null {
  if (!rates.length) return null;
  return JSON.stringify(
    rates.map((r) => {
      const o: Record<string, unknown> = { price: r.price };
      if (r.size) o.size = r.size;
      if (r.quality) o.quality = r.quality;
      if (r.seconds !== undefined) o.seconds = r.seconds;
      return o;
    }),
  );
}

/** REAL 列里塞得进文本：错类型的格读作缺失，而不是让整页失败。 */
function real(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 可空的价：只有 `null` / 缺失 / 坏类型是「没填」；`0` 原样留下。 */
function nullableReal(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 厂商：空串、空白、缺失、坏类型都是「没填」。存下来的写法原样留着。 */
function vendorOf(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s || undefined;
}

export function rowToFeeGroup(r: Record<string, unknown>): FeeGroup {
  return {
    id: String(r.id ?? ""),
    name: typeof r.name === "string" ? r.name : "",
    vendor: vendorOf(r.vendor),
    billingMode: parseBillingMode(r.billing_mode),
    inputPrice: real(r.input_price),
    cacheInputPrice: nullableReal(r.cache_input_price),
    outputPrice: real(r.output_price),
    requestPrice: real(r.request_price),
    outputUnit: parseOutputUnit(r.output_unit),
    outputRates: parseSpecRates(r.output_rates),
    inputUnitPrice: real(r.input_unit_price),
    inputFreeUnits: Math.max(0, Math.floor(real(r.input_free_units))),
    sortOrder: typeof r.sort_order === "number" ? r.sort_order : undefined,
    createdAt: real(r.created_at),
  };
}

/** 没排过序的组排在排过序的之后，之后按创建时间——和渠道列表同一条规则。 */
export async function listFeeGroups(db: Db): Promise<FeeGroup[]> {
  const rows = await db.select<Record<string, unknown>[]>(
    `SELECT * FROM fee_groups
     ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order, created_at, id`,
  );
  return rows.map(rowToFeeGroup);
}

/**
 * 整行写入。
 *
 * `sort_order` **不在这里**：它以后会有自己的写入口（拖拽重排），而编辑器
 * 保存它打开时的那一行不能撤销中途落下的重排。列先留着，语句只加不改。
 */
export function feeGroupUpsert(g: FeeGroup): { sql: string; values: unknown[] } {
  return {
    sql: `INSERT INTO fee_groups
      (id, name, vendor, billing_mode, input_price, cache_input_price, output_price, request_price,
       output_unit, output_rates, input_unit_price, input_free_units, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        vendor = excluded.vendor,
        billing_mode = excluded.billing_mode,
        input_price = excluded.input_price,
        cache_input_price = excluded.cache_input_price,
        output_price = excluded.output_price,
        request_price = excluded.request_price,
        output_unit = excluded.output_unit,
        output_rates = excluded.output_rates,
        input_unit_price = excluded.input_unit_price,
        input_free_units = excluded.input_free_units`,
    values: [
      // 空厂商写 null 而不是空串：库里「没填」也只有一种长相。
      g.id, g.name, g.vendor?.trim() || null,
      g.billingMode, g.inputPrice, g.cacheInputPrice, g.outputPrice, g.requestPrice,
      g.outputUnit, serializeSpecRates(g.outputRates), g.inputUnitPrice, g.inputFreeUnits,
      g.createdAt || Math.floor(Date.now() / 1000),
    ],
  };
}

/**
 * 删组。
 *
 * 引用置空，不删模型，**更不动用量行**：行自带当时的价，历史一分不变。
 * 三条语句走一个事务——半删掉的组会让模型指着一个不存在的 id，界面读成
 * 「未绑定」，但下一次保存又会把那个死 id 写回去。
 */
export function feeGroupDeleteStatements(id: string): { sql: string; values: unknown[] }[] {
  return [
    { sql: `UPDATE models SET fee_group_id = NULL WHERE fee_group_id = ?`, values: [id] },
    { sql: `UPDATE providers SET default_fee_group_id = NULL WHERE default_fee_group_id = ?`, values: [id] },
    { sql: `DELETE FROM fee_groups WHERE id = ?`, values: [id] },
  ];
}

// ── 从模型行上的旧价格列迁出来 ───────────────────────────────────────────────

/** 一个模型的旧价格在「同一份价」意义上的身份。相同 ⇒ 合并进同一个组。 */
function priceSignature(m: LegacyPricedModel): string | null {
  const tok = m.priceIn > 0 || m.priceCachedIn > 0 || m.priceOut > 0
    ? `tok:${m.priceIn}/${m.priceCachedIn}/${m.priceOut}`
    : "";
  if (m.pricePerSecond && m.pricePerSecond > 0) return `sec:${m.pricePerSecond}|${tok}`;
  if (m.pricePerImage && m.pricePerImage > 0) return `img:${m.pricePerImage}|${tok}`;
  return tok || null;
}

export interface LegacyPricedModel {
  id: string;
  name: string;
  priceIn: number;
  priceCachedIn: number;
  priceOut: number;
  pricePerImage?: number;
  pricePerSecond?: number;
}

/**
 * 把一批旧模型行按「同一份价」归成组。纯函数，好钉住。
 *
 * 归并是这次改动的**理由本身**：同一家十几个模型抄着同一份价，改价要改
 * 十几处。按价签名去重之后，那十几个模型指向同一个组。
 *
 * 一个模型既填了每张价又填了 token 价时按**规格**建组（出图端点的主流
 * 形状），token 价照样写进这一行——三种模式共用一行、字段全保留，用户
 * 把组切回 token 模式时价还在。旧代码把两者**相加**，那是笔糊涂账：
 * 一个两边都填的模型会被收两次。
 *
 * `createdAt` 由调用方给（同一批用同一个时间戳），所以这个函数没有副作用。
 */
export function planFeeGroupsFromLegacy(
  models: LegacyPricedModel[],
  createdAt: number,
  idFor: (index: number) => string,
): { groups: FeeGroup[]; binding: Map<string, string> } {
  const groups: FeeGroup[] = [];
  const bySignature = new Map<string, FeeGroup>();
  const binding = new Map<string, string>();
  for (const m of models) {
    const sig = priceSignature(m);
    if (!sig) continue;
    let g = bySignature.get(sig);
    if (!g) {
      const perSecond = m.pricePerSecond && m.pricePerSecond > 0 ? m.pricePerSecond : 0;
      const perImage = m.pricePerImage && m.pricePerImage > 0 ? m.pricePerImage : 0;
      const spec = perSecond > 0 || perImage > 0;
      g = {
        id: idFor(groups.length),
        name: m.name,
        billingMode: spec ? "spec" : "token",
        inputPrice: m.priceIn,
        // 老的 `price_cached_in` 列有 `NOT NULL DEFAULT 0`，所以「没填」和
        // 「真免费」在库里长得一样。0 迁成 **null**（= 同输入价）而不是 0：
        // 把没填当成免费，会让所有老配置一夜之间缓存不要钱。
        cacheInputPrice: m.priceCachedIn > 0 ? m.priceCachedIn : null,
        outputPrice: m.priceOut,
        requestPrice: 0,
        outputUnit: perSecond > 0 ? "second" : "image",
        // 一行全空条件的兜底价：旧的单价本来就不分尺寸 / 质量。
        outputRates: spec ? [{ price: perSecond > 0 ? perSecond : perImage }] : [],
        inputUnitPrice: 0,
        inputFreeUnits: 0,
        createdAt,
      };
      bySignature.set(sig, g);
      groups.push(g);
    }
    binding.set(m.id, g.id);
  }
  return { groups, binding };
}

/**
 * 一次性把模型行上的价格搬进计费组。幂等，每行一次。
 *
 * 用 `models.fee_migrated` 这一列记「这行搬过了」，而不是「表里已经有组了」
 * 或者「把旧列清零」：前者会让用户删光组之后下次启动又长回来，后者会让
 * 同一台机器上的旧版本读到一堆零价。老版本加的新模型行没有这个标记，下次
 * 启动照样被搬。
 *
 * 旧的价格列**不清零**：迁移读它们，老版本也还在读它们。新代码一律走
 * `Model.fee`（`configDb.feeOf`）。
 */
export async function migrateModelPricesToFeeGroups(db: Db): Promise<number> {
  const rows = await db.select<Record<string, unknown>[]>(
    `SELECT id, name, price_in, price_cached_in, price_out, price_per_image, price_per_second
     FROM models WHERE fee_migrated IS NULL ORDER BY name, id`,
  );
  if (!rows.length) return 0;

  const existing = await listFeeGroups(db);
  const legacy: LegacyPricedModel[] = rows.map((r) => ({
    id: String(r.id ?? ""),
    name: typeof r.name === "string" && r.name ? r.name : String(r.id ?? ""),
    priceIn: real(r.price_in),
    priceCachedIn: real(r.price_cached_in),
    priceOut: real(r.price_out),
    pricePerImage: real(r.price_per_image),
    pricePerSecond: real(r.price_per_second),
  }));
  const now = Math.floor(Date.now() / 1000);
  const { groups, binding } = planFeeGroupsFromLegacy(
    legacy,
    now,
    (i) => `fee_${now}_${i}_${Math.random().toString(36).slice(2, 8)}`,
  );

  // 已经有同价的组就用它，不再造一个——第二次启动时老版本加的模型要落进
  // 第一次迁移建好的组里，而不是长出一份重复的价。
  const sigOf = (g: FeeGroup) => JSON.stringify([
    g.billingMode, g.inputPrice, g.cacheInputPrice, g.outputPrice,
    g.requestPrice, g.outputUnit, serializeSpecRates(g.outputRates),
    g.inputUnitPrice, g.inputFreeUnits,
  ]);
  const reuse = new Map(existing.map((g) => [sigOf(g), g.id]));
  const remap = new Map<string, string>();
  const fresh: FeeGroup[] = [];
  for (const g of groups) {
    const hit = reuse.get(sigOf(g));
    if (hit) remap.set(g.id, hit);
    else {
      fresh.push(g);
      reuse.set(sigOf(g), g.id);
    }
  }

  for (const g of fresh) {
    const { sql, values } = feeGroupUpsert(g);
    await db.execute(sql, values);
  }
  for (const r of rows) {
    const id = String(r.id ?? "");
    const bound = binding.get(id);
    const target = bound ? (remap.get(bound) ?? bound) : null;
    await db.execute(
      `UPDATE models SET fee_group_id = COALESCE(fee_group_id, ?), fee_migrated = 1 WHERE id = ?`,
      [target, id],
    );
  }
  return fresh.length;
}
