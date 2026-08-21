/**
 * 记忆区：一个角色**以为的事**。
 *
 * 设计见 `docs/feature/roleplay/06-scene-and-memory-area.md` §4。三条不能动的：
 *
 * 1. **格式与知识库完全相同，但绝不进项目的 `loreIndex`。** 复用的是代码
 *    （`readEntityFolder` / `selectLore` / 条目详情页），不是索引。并进去的话，
 *    隔离性就从「它不在那里」降级成一个要在六个地方同时正确的过滤器——逐轮注入、
 *    知识库读工具、**一致性检查**（它会把角色的错误认知报成正文矛盾）、知识库墙、
 *    同步导出、旁白上下文。漏一个就是静默泄漏。
 * 2. **区归自己，不归 agent**（`areas/<areaId>/`，不是 `<agentId>/`）。所以它能被
 *    继承：删掉角色，记忆区还在；新角色绑上它，知识就接上了。agent 因此是一个壳。
 * 3. **一个区同时只能被一个 agent 绑定。** 两个角色共用一份记忆等于隔离性不存在，
 *    而这不是一个值得留的口子。
 *
 * 条目就是 lore 条目：`name` 是标题，**`aliases` 就是关键字**（`selectLore` 认的
 * 正是它），`summary` 是一句话，正文在 body。目录名用编号而不是标题——标题是中文，
 * 而这个名字要进文件路径（和 agent id 同一条纪律：校验，不转义）。
 */

import {
  fileExists, makeDir, readDir, readFile, renamePath, writeFile,
} from "../fs/fileio";
import { scanEntityFolder } from "../lore/entity";
import type { LoreEntity, LoreIndex } from "../lore/model";

/** 区内唯一的分类。平铺——记忆区的导航靠搜索和关键字，不靠分类（06 §9）。 */
export const AREA_CATEGORY = "history";

const AREA_ID_RE = /^rp-area-[a-z0-9-]{1,60}$/;

export function isValidAreaId(id: string): boolean {
  return AREA_ID_RE.test(id);
}

export function generateAreaId(now: number, rand: number): string {
  return `rp-area-${now.toString(36)}${Math.floor(rand * 1296).toString(36).padStart(2, "0")}`;
}

export function areasRoot(projectPath: string): string {
  return `${projectPath}/.ai-writer/roleplay/areas`;
}

export function areaDir(projectPath: string, areaId: string): string {
  if (!isValidAreaId(areaId)) throw new Error(`invalid area id: ${areaId}`);
  return `${areasRoot(projectPath)}/${areaId}`;
}

const entriesDir = (p: string, id: string) => `${areaDir(p, id)}/${AREA_CATEGORY}`;
const metaPath = (p: string, id: string) => `${areaDir(p, id)}/meta.json`;

export interface AreaMeta {
  id: string;
  name: string;
  createdAt: number;
  /** 当前挂在哪个 agent 上。`null` = 空闲，可以被继承。 */
  boundTo: string | null;
  /** 上一个使用者的显示名。角色删了之后这是唯一还能说清它从哪来的东西。 */
  formerName: string | null;
  /** 最后写入发生在第几场。列表按它排序。 */
  lastScene: number;
}

function coerceMeta(id: string, raw: unknown): AreaMeta {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id,
    name: typeof o.name === "string" && o.name.trim() ? o.name : id,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
    boundTo: typeof o.boundTo === "string" ? o.boundTo : null,
    formerName: typeof o.formerName === "string" ? o.formerName : null,
    lastScene: typeof o.lastScene === "number" ? o.lastScene : 0,
  };
}

export async function loadAreaMeta(projectPath: string, areaId: string): Promise<AreaMeta> {
  try {
    return coerceMeta(areaId, JSON.parse(await readFile(metaPath(projectPath, areaId))));
  } catch {
    // meta 读不出来不是致命的：条目都还在，名字退回 id。
    return coerceMeta(areaId, null);
  }
}

export async function saveAreaMeta(projectPath: string, meta: AreaMeta): Promise<void> {
  await makeDir(areaDir(projectPath, meta.id));
  await writeFile(metaPath(projectPath, meta.id), JSON.stringify(meta, null, 2));
}

/** 一个区，加上它现在有多少条——列表和绑定选择器都要这个数。 */
export interface AreaSummary extends AreaMeta {
  count: number;
}

export async function listAreas(projectPath: string): Promise<AreaSummary[]> {
  const root = areasRoot(projectPath);
  if (!(await fileExists(root))) return [];
  const out: AreaSummary[] = [];
  for (const e of await readDir(root)) {
    if (!e.isDirectory || !isValidAreaId(e.name)) continue;
    const meta = await loadAreaMeta(projectPath, e.name);
    out.push({ ...meta, count: (await scanArea(projectPath, e.name))[AREA_CATEGORY]?.length ?? 0 });
  }
  // 空闲的在前（可以被继承的先看见），组内按最后写入倒序。
  return out.sort((a, b) =>
    (a.boundTo === null ? 0 : 1) - (b.boundTo === null ? 0 : 1) || b.lastScene - a.lastScene);
}

export async function createArea(
  projectPath: string, name: string, now: number, rand: number,
): Promise<AreaMeta> {
  const meta: AreaMeta = {
    id: generateAreaId(now, rand),
    name: name.trim() || "记忆区",
    createdAt: now,
    boundTo: null,
    formerName: null,
    lastScene: 0,
  };
  await makeDir(entriesDir(projectPath, meta.id));
  await saveAreaMeta(projectPath, meta);
  return meta;
}

/**
 * 一个区的索引。形状就是 `LoreIndex`，所以 `selectLore` 可以直接吃它——这正是
 * 「复用代码不复用索引」这句话在代码上的样子。
 */
export async function scanArea(projectPath: string, areaId: string): Promise<LoreIndex> {
  return { [AREA_CATEGORY]: await scanEntityFolder(entriesDir(projectPath, areaId), AREA_CATEGORY) };
}

export function areaEntities(index: LoreIndex): LoreEntity[] {
  return index[AREA_CATEGORY] ?? [];
}

export interface NewAreaEntry {
  title: string;
  body: string;
  /** 关键字。落盘成 `aliases`——`selectLore` 认的就是这个字段。 */
  keys: string[];
  /** 摘要行。留空则取正文首句。 */
  summary?: string;
  /** 来自第几场。写进 frontmatter，详情页据此显示「来自第 3 场」。 */
  scene: number;
}

/** 正文的第一句，用作没有 summary 时的兜底。 */
function firstSentence(body: string, cap = 60): string {
  const line = body.trim().split(/\n/)[0] ?? "";
  const cut = line.search(/[。！？.!?]/);
  const s = cut >= 0 ? line.slice(0, cut + 1) : line;
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

function yamlList(items: readonly string[]): string {
  return `[${items.map((k) => JSON.stringify(k)).join(", ")}]`;
}

/**
 * 往区里写一条。目录名是**顺序编号**，不是标题的转写——中文标题进不了一个安全的
 * 路径，而编号永不复用也永不撞车。
 */
export async function addAreaEntry(
  projectPath: string, areaId: string, entry: NewAreaEntry, now: number,
): Promise<string> {
  const dir = entriesDir(projectPath, areaId);
  await makeDir(dir);
  let max = 0;
  try {
    for (const e of await readDir(dir)) {
      const m = /^e(\d+)$/.exec(e.name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* 目录刚建，没有条目 */ }
  const id = `e${String(max + 1).padStart(3, "0")}`;

  const front = [
    "---",
    `name: ${JSON.stringify(entry.title)}`,
    `aliases: ${yamlList(entry.keys)}`,
    `summary: ${JSON.stringify(entry.summary?.trim() || firstSentence(entry.body))}`,
    `scene: ${entry.scene}`,
    `recordedAt: ${now}`,
    "---",
    "",
    entry.body.trim(),
    "",
  ].join("\n");

  await makeDir(`${dir}/${id}`);
  await writeFile(`${dir}/${id}/index.md`, front);
  return id;
}

/** 一条的可改部分。标题也能改——它是 `name`，也就是命中时最先被匹配的那个词。 */
export interface AreaEntryPatch {
  title?: string;
  body?: string;
  keys?: string[];
  summary?: string;
}

/**
 * 改一条。**整份重写**，因为 frontmatter 里那几行是有序的，就地补丁比重写更容易
 * 写出一个读不回来的文件；而一条记忆最多几百字，重写的代价可以忽略。
 *
 * 认不出的字段原样带过去——作者手改过这个文件是被允许的行为，和 `memory.md` 一个
 * 规矩。
 */
export async function updateAreaEntry(
  projectPath: string, areaId: string, entryId: string, patch: AreaEntryPatch,
): Promise<void> {
  const path = `${entriesDir(projectPath, areaId)}/${entryId}/index.md`;
  const raw = await readFile(path);
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  const front = m ? m[1].split("\n") : [];
  const body = patch.body !== undefined ? patch.body.trim() : (m ? m[2].trim() : raw.trim());

  const set = (key: string, value: string) => {
    const i = front.findIndex((l) => l.startsWith(`${key}:`));
    if (i >= 0) front[i] = `${key}: ${value}`;
    else front.push(`${key}: ${value}`);
  };
  if (patch.title !== undefined) set("name", JSON.stringify(patch.title.trim()));
  if (patch.keys !== undefined) set("aliases", yamlList(patch.keys.map((k) => k.trim()).filter(Boolean)));
  if (patch.summary !== undefined || patch.body !== undefined) {
    set("summary", JSON.stringify(patch.summary?.trim() || firstSentence(body)));
  }

  await writeFile(path, `---\n${front.join("\n")}\n---\n\n${body}\n`);
}

/**
 * 删一条：移进 `.ai-writer/backups/`，不真删。
 *
 * 这里的东西是攒了很多场的，而它最可能被删的时刻，恰恰是作者以为自己不再需要它
 * 的时刻。和删条目、删 agent 一个规矩。
 */
export async function deleteAreaEntry(
  projectPath: string, areaId: string, entryId: string, now: number,
): Promise<void> {
  const src = `${entriesDir(projectPath, areaId)}/${entryId}`;
  if (!(await fileExists(src))) return;
  const backups = `${projectPath}/.ai-writer/backups`;
  await makeDir(backups);
  await renamePath(src, `${backups}/roleplay-entry-${now}-${areaId}-${entryId}`);
}

/**
 * 删一个区：整个目录移进 `.ai-writer/backups/`，和删 agent、删条目一致。
 *
 * 不真删，因为里面是攒了很多场的东西——而它最可能被删的时刻，恰恰是作者以为
 * 自己不再需要它的时刻。
 */
export async function deleteAreaDir(
  projectPath: string, areaId: string, now: number,
): Promise<string | null> {
  const src = areaDir(projectPath, areaId);
  if (!(await fileExists(src))) return null;
  const backups = `${projectPath}/.ai-writer/backups`;
  await makeDir(backups);
  const dest = `${backups}/roleplay-area-${now}-${areaId}`;
  await renamePath(src, dest);
  return dest;
}
