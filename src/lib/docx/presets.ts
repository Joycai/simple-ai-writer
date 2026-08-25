/**
 * 作者自建的排版格式，落在 `config.db`。
 *
 * **装机级，不是项目级**：一套公文格式要跨所有项目复用，和供应商 / 模型 /
 * Prompt 同级（01-agent-design §7）。放进同一个库的连带好处是它自然落进
 * 「应用配置备份」的范围——排版预设正是典型的「换台机器要带走」的东西。
 *
 * 整套格式存成一列 JSON，不拆成三十个字段：`DocFormat` 是个嵌套结构，而且还会
 * 长；拆开意味着每加一个排版属性就要改一次表结构，而这张表从来不需要按字段
 * 查询——它永远是整套读出来、整套写回去。
 *
 * 建表放在这里而不是 `ensureAiSchema`：那个函数是「AI 配置」的 schema，也是
 * 配置备份读写的那一份；排版格式的生命周期和它一样但语义不同，各自负责自己
 * 的表，比把它塞进一个名字不对的地方清楚。
 */

import { getGlobalDb } from "../project";
import type { DocFormat, DocFormatPreset } from "./format";

const TABLE = "doc_format";

let schema: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  schema ??= (async () => {
    const db = await getGlobalDb();
    await db.execute(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        format TEXT NOT NULL,
        imitated_from TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
  })();
  return schema;
}

interface Row {
  id: string;
  label: string;
  format: string;
  imitated_from: string | null;
}

/** 作者自建的全部预设，建的先来后到。 */
export async function loadCustomFormats(): Promise<DocFormatPreset[]> {
  await ensureSchema();
  const db = await getGlobalDb();
  const rows = await db.select<Row[]>(`SELECT id, label, format, imitated_from FROM ${TABLE} ORDER BY created_at`);
  return rows.flatMap((r) => {
    try {
      return [{
        id: r.id,
        label: r.label,
        builtin: false,
        ...(r.imitated_from ? { imitatedFrom: r.imitated_from } : {}),
        format: JSON.parse(r.format) as DocFormat,
      }];
    } catch (e) {
      // 一行坏了不该让整页打不开——它被跳过，其余照常。
      console.warn(`[docx] 排版格式 ${r.id} 的 JSON 读不出来，已跳过：`, e);
      return [];
    }
  });
}

export async function saveCustomFormat(preset: DocFormatPreset): Promise<void> {
  await ensureSchema();
  const db = await getGlobalDb();
  await db.execute(
    `INSERT INTO ${TABLE} (id, label, format, imitated_from) VALUES ($1, $2, $3, $4)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, format = excluded.format,
       imitated_from = excluded.imitated_from`,
    [preset.id, preset.label, JSON.stringify(preset.format), preset.imitatedFrom ?? null],
  );
}

export async function deleteCustomFormat(id: string): Promise<void> {
  await ensureSchema();
  const db = await getGlobalDb();
  await db.execute(`DELETE FROM ${TABLE} WHERE id = $1`, [id]);
}
