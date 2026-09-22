/**
 * 给老用量行补上分项的钱——**只在能自证的地方动手**。
 *
 * `usageSchema.ts` 立过一条规矩：「只加列、不改列：老行不回填价格——它们本来
 * 就是按当时的模型价记的，回填等于捏造历史」。这个模块不违反它，因为**回填的
 * 不是价，是同一笔钱的分法**：每一行的快照列（计费模式、各项单价、token 数、
 * 规格量与单位、上游报价）本来就全在行上，拿它们重建 `Billed`、喂给**同一个**
 * `costOf()`，算出来的总额必然等于行上已经存着的 `cost_usd`。
 *
 * 于是设一道**对账闸门**：重算的总额和行上的 `cost_usd` 对不上，就**不写**
 * 这一行，六列保持 NULL。对不上的只会是快照列出现之前的远古行（`billing_mode`
 * 为空、价全缺），它们老实留在用量页的「未分项」里——诚实，而且随着新用量
 * 累积会自然稀释。**宁可留白，不可编一个分法出来。**
 *
 * 为什么要回填而不是等新数据攒起来：不回填的话，升级当天打开用量页，历史数据
 * 的条整条是灰的，这个功能对老用户等于不存在。
 *
 * **库文件路径由调用点传进来**，这个模块不自己去 `lib/project` 要。理由和
 * `usageSchema.ts` 被单独拆出来是同一个：项目库那一侧由 `lib/project` 建表并
 * 调用这里，这个模块再回头 import 它就成了环（src/lib/__tests__/layering.test.ts
 * 不许有环）。
 */

import { sqlTransaction, type SqlStatement } from "../sqlTx";
import {
  costOf, parseBillingMode, segmentsOf, totalOf,
  type Billed, type OutputUnit,
} from "./feeGroup";

import type Database from "@tauri-apps/plugin-sql";

type Db = Awaited<ReturnType<typeof Database.load>>;

/**
 * 一批多少行。
 *
 * 定在 200 而不是 1000，是为了**缩短每次持写锁的时间**。这一趟走
 * `sqlTransaction`，Rust 那侧开一条私有连接，一批的 UPDATE 全落在一个事务里，
 * 期间 SQLite 的写锁归它。而 `recordUsage` 是**永不抛错**的——它撞上
 * `database is locked` 只会被自己的 try 吞掉，于是账少一行，没有任何东西报错。
 *
 * 同一个窗口里这不太会发生（回填挡在项目打开 / 配置加载的 await 上，那时还没有
 * 请求能完成），但这个应用**允许多开**：A 窗口正在跑一个请求、B 窗口刚开一个
 * 项目，两边都写 `config.db` 的同一张表。批小五倍，锁窗口就短五倍，对面的
 * busy timeout 就更容易等得过去。
 *
 * 再小就不划算了：几万行意味着几百个事务，每个都要一次 IPC 往返。
 */
const BATCH = 200;

/** SQLite 的 REAL / INTEGER 列里塞得进别的东西，读出来的坏格当 0。 */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 行 → `Billed`。
 *
 * 一处要小心：表的口径是 `prompt_tokens` **包含** `cached_tokens`，而 `Billed`
 * 要的是**不重叠**的两段（`usageSchema.ts` 文件头写着这条）。这里做的差，和
 * 写入口 `buildUsageRow` 做的是同一个差——口径在两边必须一致，否则回填出来的
 * 输入段会比当初记的多算一份缓存。
 *
 * `cache_price` 为空回退到 `input_price`：缓存价存在之前写的行就是这么读的。
 */
export function rowToBilled(r: Record<string, unknown>): Billed {
  const prompt = Math.max(0, num(r.prompt_tokens));
  const cached = Math.max(0, Math.min(num(r.cached_tokens), prompt));
  const cachePrice = typeof r.cache_price === "number" && Number.isFinite(r.cache_price)
    ? r.cache_price
    : num(r.input_price);
  return {
    billingMode: parseBillingMode(r.billing_mode),
    inputTokens: prompt - cached,
    cacheTokens: cached,
    outputTokens: Math.max(0, num(r.completion_tokens)),
    inputPrice: num(r.input_price),
    cachePrice,
    outputPrice: num(r.output_price),
    requests: num(r.request_count),
    requestPrice: num(r.request_price),
    outputUnits: num(r.output_units),
    outputUnitPrice: num(r.output_unit_price),
    inputUnits: num(r.input_units),
    inputUnitPrice: num(r.input_unit_price),
    // 空 ≠ 零：没报是 null，上游说 0 就是 0。`costOf()` 自己会判可信性。
    reportedCost: typeof r.reported_cost === "number" ? r.reported_cost : null,
  };
}

/** 行上快照的单位。只有它知道 `spec` 那笔钱数的是张还是秒；不认识就交给 null。 */
function rowUnit(v: unknown): OutputUnit | null {
  return v === "image" || v === "second" || v === "clip" ? v : null;
}

/**
 * 重算的总额对得上行上存的 `cost_usd` 吗。
 *
 * 用相对误差而不是 `===`：两边都是一串浮点乘加，位模式相等是运气不是保证。
 * `cost_usd` 为 0 的行（没配价）用绝对误差兜底，否则相对误差恒为无穷。
 */
function reconciles(recomputed: number, stored: number): boolean {
  const scale = Math.max(Math.abs(stored), Math.abs(recomputed));
  if (scale < 1e-12) return true;
  return Math.abs(recomputed - stored) / scale < 1e-9;
}

export interface BackfillResult {
  /** 对上了账、六列写下去的行数。 */
  filled: number;
  /** 对不上账、保持 NULL 的行数——它们在用量页里是「未分项」。 */
  skipped: number;
}

const SELECT_SQL = `SELECT id, cost_usd, billing_mode, prompt_tokens, cached_tokens,
         completion_tokens, input_price, cache_price, output_price,
         request_price, request_count, output_units, output_unit_price,
         output_unit, input_units, input_unit_price, reported_cost
   FROM token_usage WHERE cost_input IS NULL AND id > ?
   ORDER BY id LIMIT ?`;

const UPDATE_SQL = `UPDATE token_usage
   SET cost_input = ?, cost_cache = ?, cost_output = ?,
       cost_count = ?, cost_duration = ?, cost_other = ?
   WHERE id = ?`;

/**
 * 把这个库里还没有分项的行补上。
 *
 * **幂等**：写过的行不再命中 `cost_input IS NULL`。对不上账的行会被反复选中
 * 却永远写不进去，所以每一批都必须**推进游标**（`WHERE id > lastId`），
 * 否则一批全是对不上的行时会原地打转。
 */
export async function backfillUsageParts(db: Db, dbPath: string): Promise<BackfillResult> {
  let filled = 0;
  let skipped = 0;
  let after = -1;
  for (;;) {
    const rows = await db.select<Record<string, unknown>[]>(SELECT_SQL, [after, BATCH]);
    if (rows.length === 0) break;
    const before = after;
    const updates: SqlStatement[] = [];
    for (const r of rows) {
      // id 只读一次，游标和 `WHERE id = ?` 用**同一个**值：两处各读各的，
      // 一个走 `num()` 一个走裸值，它们就可能在坏数据上指向不同的行。
      const id = num(r.id);
      after = Math.max(after, id);
      const parts = costOf(rowToBilled(r));
      if (!reconciles(totalOf(parts), num(r.cost_usd))) {
        skipped++;
        continue;
      }
      const s = segmentsOf(parts, rowUnit(r.output_unit));
      updates.push({
        sql: UPDATE_SQL,
        values: [s.input, s.cache, s.output, s.count, s.duration, s.other, id],
      });
    }
    if (updates.length > 0) await sqlTransaction(dbPath, updates);
    filled += updates.length;
    // **游标没动就收工。** 正常情况下不可能——`id` 是自增主键，`ORDER BY id`
    // 取回来的一定比 `after` 大。但只要有一整批的 `id` 读不成数字（`num()`
    // 把它们全读成 0），`after` 就不会推进，而对不上账的行永远写不进去、
    // 每次都被重新选中——于是这里原地打转。这一趟挂在 `openProject` 的
    // await 链上，挂死的表现是**项目再也开不出来，且没有任何征兆**，
    // 所以宁可在一个不该发生的情况下提前收工。
    if (after <= before) break;
    if (rows.length < BATCH) break;
  }
  return { filled, skipped };
}

/**
 * 建表补列之后跟着跑的那一次，**永不抛错**。
 *
 * 回填失败只是有些行停在「未分项」，不该让用量页打不开、更不该让项目开不了
 * ——这和写入口「记账永不抛错」是同一条脾气：账目的事不配让已经能用的东西失败。
 */
export async function backfillUsagePartsQuietly(db: Db, dbPath: string, label: string): Promise<void> {
  try {
    const { filled, skipped } = await backfillUsageParts(db, dbPath);
    // **说出来。** 闸门是这一片唯一的安全装置，而「挡掉 3 行远古记录」和
    // 「口径写歪了、挡掉三万行」在界面上长得一模一样——都只是条变灰，
    // 没有任何东西报错。数字留一行在控制台，出事时才有得查。
    if (filled > 0 || skipped > 0) {
      console.info(`[usageBackfill] ${label}: filled ${filled} row(s), left ${skipped} unsplit.`);
    }
  } catch (e) {
    console.warn(`[usageBackfill] ${label}: backfill failed, rows stay unsplit:`, e);
  }
}
