/**
 * `token_usage` 这张表的形状——建表与补列，两个库共用。
 *
 * 单独一个模块是为了避开一个环：项目库那一侧由 `lib/project.ts` 建表，而
 * 写入口（`usageRow.ts`）要从 `lib/project.ts` 拿库句柄。表结构放在两边都
 * 能 import 的地方，`components → stores → lib` 这条分层上就没有回边
 * （src/lib/__tests__/layering.test.ts 不许有环）。
 */

import type Database from "@tauri-apps/plugin-sql";

type Db = Awaited<ReturnType<typeof Database.load>>;

/**
 * 两个库里这张表长得一模一样，只有总体库多一列 `project`。
 *
 * 一份 SQL 两处用，而不是各写一遍：两张表长歪了，用量页在「本项目 / 全部」
 * 之间一切就会少掉几列，而那种少法不报错。
 *
 * 几列的语义值得写下来：
 * - `prompt_tokens` 是**全部** prompt token，`cached_tokens` 是它的**子集**
 *   ——这是这张表从第一天起的口径，算钱时才分成不重叠的两段
 *   （`rowToBilled`，lib/ai/usageBackfill.ts）。改口径会让每一行历史被重新
 *   读成别的数。
 * - `cache_price` **可空**：只有在缓存价存在之前写的行上为空，读时回退到
 *   `input_price`。
 * - `reported_cost` **可空**：空 = 上游没报；`0` = 上游说这次免费。
 * - `cost_usd` 是 `costOf()` 的结果写下来的一份，不是第二套口径——汇总在
 *   SQL 里 `SUM` 它，所以不需要检查点，也不需要把几万行读进内存。
 */
const USAGE_COLUMNS = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      task TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())`;

/** 计费快照列。老行上它们是 NULL，读作「没有快照」——按当时的样子读。 */
const SNAPSHOT_COLUMNS: [string, string][] = [
  ["billing_mode", "TEXT"],
  ["input_price", "REAL"],
  ["cache_price", "REAL"],
  ["output_price", "REAL"],
  ["request_price", "REAL"],
  ["request_count", "INTEGER"],
  ["output_units", "REAL"],
  ["output_unit_price", "REAL"],
  ["output_unit", "TEXT"],
  ["output_spec", "TEXT"],
  // 命中档位没有。单独一列而不是从 `output_spec` 的 JSON 里 `json_extract`：
  // 用量页要按它做 `SUM(... )` 统计「未覆盖」，而 JSON1 在打包进来的
  // SQLite 里是不是编进去的，这张表不该赌。
  ["spec_matched", "INTEGER"],
  ["input_images", "INTEGER"],
  ["input_units", "REAL"],
  ["input_unit_price", "REAL"],
  ["reported_cost", "REAL"],
  // 分项的钱：`costOf()` 的七项经 `segmentsOf()` 折成的六段，记账那一刻抄下来。
  // 跟 `cost_usd` 同一条规矩——**结果落盘，不是第二套口径**：读的那一侧只
  // `SUM` 它们，不在 SQL 里把算式重写一遍。
  //
  // 落在写入时而不是读出时，还顺带解决了一件读的那侧永远解不开的事：`spec`
  // 那笔钱数的是张还是秒，只有 `output_unit` 知道，而 `GROUP BY` 之后一个桶里
  // 可能混着两种单位。写的那一刻单位是确定的单值，拆完再存，聚合就不必再问。
  //
  // **空 ≠ 零**：NULL = 这一行没有分项快照（老行），不是「这一段是 0」。用量页
  // 据此把分不出段的钱单独数成一份，而不是假装它不存在。
  ["cost_input", "REAL"],
  ["cost_cache", "REAL"],
  ["cost_output", "REAL"],
  ["cost_count", "REAL"],
  ["cost_duration", "REAL"],
  ["cost_other", "REAL"],
];

async function addUsageColumn(db: Db, existing: Set<string>, name: string, type: string) {
  if (existing.has(name)) return;
  try {
    await db.execute(`ALTER TABLE token_usage ADD COLUMN ${name} ${type}`);
  } catch (e) {
    // 「读出列再补缺的」不是原子的：另一个窗口在这中间补上了，SQLite 说
    // duplicate column name——那正是这里想要的结果，是成功不是失败。
    if (!/duplicate column name/i.test(String(e))) throw e;
  }
}

/**
 * 建表 + 补列。`scope: "global"` 的那份多一列 `project`。
 *
 * 只加列、不改列：老行**不回填价格**——它们本来就是按当时的模型价记的，
 * 回填等于捏造历史。
 *
 * 那六列 `cost_*` 分项是这条规矩之内的一个例外，而不是对它的破例：
 * `lib/ai/usageBackfill` 补的**不是价，是同一笔钱的分法**——价全在行上，
 * 拿它们喂给同一个 `costOf()`，重算的总额必须等于行上已经存着的 `cost_usd`
 * 才写，对不上就留白。没有一行的钱会因为回填而变成另一个数。
 */
export async function ensureUsageSchema(db: Db, scope: "project" | "global"): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS token_usage (${USAGE_COLUMNS}${scope === "global" ? ",\n      project TEXT" : ""}\n    )`,
  );
  const cols = await db.select<{ name: string }[]>(`PRAGMA table_info(token_usage)`);
  const have = new Set(cols.map((c) => c.name));
  for (const [name, type] of SNAPSHOT_COLUMNS) await addUsageColumn(db, have, name, type);
  if (scope === "global") {
    await addUsageColumn(db, have, "project", "TEXT");
    // 总体库里一个项目的行动辄上万，范围查询与「清掉这个项目」都靠它。
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_usage_project ON token_usage (project, created_at)`);
  }
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_usage_created ON token_usage (created_at)`);
  // 还没有分项的行。**部分索引**，不是整列索引：`lib/ai/usageBackfill` 每次
  // 开库都会去找它们，而对不上账的远古行永远补不上、永远命中这个条件——
  // 没有索引的话那就是每次开项目一次全表扫描，且随表增长只会更慢。
  // 有了它，回填跑完之后这个索引里只剩那几行对不上的，再开库就是一次很小的
  // 索引查找。行补上之后会自动退出索引，索引也就跟着缩。
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_usage_unsplit ON token_usage (id) WHERE cost_input IS NULL`,
  );
}

