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
import { parseDocFormat, type DocFormatPreset } from "./format";

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
        // 归一而不是直接当 DocFormat 用：一个坏字段不该让整套预设消失，三期
        // 之前存下的行也在这里补上新增的两块（见 parseDocFormat）。
        format: parseDocFormat(JSON.parse(r.format)),
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

/**
 * 从一份 .docx 读来的格式在本次会话里的 id。放在这里而不是 docFormatStore：agent 工具
 * 也要用，而 `lib/` 不 import `stores/`（docs/feature/code-structure-plan.md P3）。
 *用路径而不是内容哈希：同一份文件
 * 再读一次应该覆盖上一次的结果，而不是攒出两条。
 */
const IMITATED_PREFIX = "imitated:";

export function imitatedIdFor(path: string): string {
  return `${IMITATED_PREFIX}${path}`;
}

/**
 * 这套格式还只挂在本次会话里吗——即「照一份 .docx 模仿，但没存成预设」。
 *
 * 用 id 前缀而不是 `imitatedFrom`：作者点「存为预设」存下来的那一套**也**带着
 * `imitatedFrom`（列表里的「读自 甲方模板.docx」就是它），而那一套已经是作者
 * 自己的资产了，审批卡上不该再写「未存为预设」。
 */
export function isSessionImitated(id: string): boolean {
  return id.startsWith(IMITATED_PREFIX);
}
