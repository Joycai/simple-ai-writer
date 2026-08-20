/**
 * `.ai-writer/roleplay/` 的读写。
 *
 *   .ai-writer/roleplay/
 *   ├── agents.json          花名册：顺序、元数据、作者身份
 *   └── <agentId>/
 *       ├── agent.md         人设卡（frontmatter + 作者手写的扮演指令）
 *       ├── transcript.md    对话记录（资产，见 ./transcript）
 *       ├── memory.md        角色记忆：约定 / 待办 / 事件 / 关系（见 ./memory）
 *       ├── summary.md       滚动摘要（压缩时写）
 *       ├── session.json     wire history + meta（缓存，可丢）
 *       └── archive/         历次「新开会话」封存的旧场次
 *           ├── transcript-01.md
 *           ├── summary-01.md      （有才存）
 *           └── memory-01.md       （只在作者选了「同时清空记忆」时才有）
 *
 * 落在项目目录而不是 `chat_sessions` 表：那张表每次写入都把自己裁到最新
 * 5 个会话，对话助手的对话是缓存、删了无所谓，而攒了两周的角色互动被一次
 * 普通提问挤掉是不可接受的数据丢失。放在 `.ai-writer/` 下还顺带被
 * `projectBackup` 带走（它的排除表是白名单式的）。
 */

import {
  fileExists, makeDir, readDir, readFile, removeFile, renamePath, writeFile,
} from "../fs/fileio";
import {
  deserializeChatSession, serializeChatSession, type ChatSnapshot,
} from "../agent/chatSession";
import type { StreamMessage } from "../ai/types";
import {
  isValidAgentId, NO_PERSONA, type AuthorPersona, type RoleplayAgent,
} from "./model";

export function roleplayDir(projectPath: string): string {
  return `${projectPath}/.ai-writer/roleplay`;
}

export function agentDir(projectPath: string, agentId: string): string {
  if (!isValidAgentId(agentId)) throw new Error(`invalid agent id: ${agentId}`);
  return `${roleplayDir(projectPath)}/${agentId}`;
}

export const rosterPath = (p: string) => `${roleplayDir(p)}/agents.json`;
export const personaPath = (p: string, id: string) => `${agentDir(p, id)}/agent.md`;
export const transcriptPath = (p: string, id: string) => `${agentDir(p, id)}/transcript.md`;
export const summaryPath = (p: string, id: string) => `${agentDir(p, id)}/summary.md`;
export const memoryPath = (p: string, id: string) => `${agentDir(p, id)}/memory.md`;
export const sessionPath = (p: string, id: string) => `${agentDir(p, id)}/session.json`;

export interface Roster {
  authorPersona: AuthorPersona;
  /** 显示顺序即数组顺序。 */
  agents: RoleplayAgent[];
}

export const EMPTY_ROSTER: Roster = { authorPersona: NO_PERSONA, agents: [] };

// ─── 花名册 ──────────────────────────────────────────────────────────────────

function coercePersona(raw: unknown): AuthorPersona {
  if (!raw || typeof raw !== "object") return NO_PERSONA;
  const p = raw as Record<string, unknown>;
  const mode = p.mode === "lore" || p.mode === "prompt" ? p.mode : "none";
  return {
    mode,
    dirPath: typeof p.dirPath === "string" ? p.dirPath : null,
    prompt: typeof p.prompt === "string" ? p.prompt : "",
  };
}

function coerceAgent(raw: unknown): RoleplayAgent | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== "string" || !isValidAgentId(a.id)) return null;
  const kind = a.kind === "narrator" ? "narrator" : "character";
  return {
    id: a.id,
    kind,
    name: typeof a.name === "string" && a.name.trim() ? a.name : a.id,
    primaryDirPath: kind === "narrator" || typeof a.primaryDirPath !== "string" ? null : a.primaryDirPath,
    boundPaths: Array.isArray(a.boundPaths) ? a.boundPaths.filter((x): x is string => typeof x === "string") : [],
    modelId: typeof a.modelId === "string" ? a.modelId : null,
    authorPersona: a.authorPersona ? coercePersona(a.authorPersona) : null,
    createdAt: typeof a.createdAt === "number" ? a.createdAt : 0,
    updatedAt: typeof a.updatedAt === "number" ? a.updatedAt : 0,
    turnCount: typeof a.turnCount === "number" ? a.turnCount : 0,
    // 旧花名册没有这个字段，读成 null = 「没有基线」，于是不会误报「已更新」。
    boundHash: typeof a.boundHash === "string" ? a.boundHash : null,
  };
}

/**
 * 读花名册。**损坏时扫目录重建**，而不是把作者的 agent 全部当作不存在。
 *
 * 每个 agent.md 的 frontmatter 重复了 id/kind/name/primary，正是为了这一刻：
 * agents.json 是权威，但它不是唯一的真相来源。重建结果不写回——写回会在
 * 一次读失败上叠加一次写失败的风险；调用方拿到 `rebuilt` 自己决定。
 */
export async function loadRoster(projectPath: string): Promise<{ roster: Roster; rebuilt: boolean }> {
  const path = rosterPath(projectPath);
  try {
    if (await fileExists(path)) {
      const raw = JSON.parse(await readFile(path)) as Record<string, unknown>;
      const agents = Array.isArray(raw.agents)
        ? raw.agents.map(coerceAgent).filter((a): a is RoleplayAgent => a !== null)
        : [];
      if (agents.length > 0 || !Array.isArray(raw.agents)) {
        return { roster: { authorPersona: coercePersona(raw.authorPersona), agents }, rebuilt: false };
      }
      return { roster: { authorPersona: coercePersona(raw.authorPersona), agents }, rebuilt: false };
    }
  } catch (e) {
    console.warn("[roleplay] agents.json unreadable, rebuilding from directories:", e);
  }
  const agents = await rebuildRoster(projectPath);
  return { roster: { authorPersona: NO_PERSONA, agents }, rebuilt: agents.length > 0 };
}

async function rebuildRoster(projectPath: string): Promise<RoleplayAgent[]> {
  const dir = roleplayDir(projectPath);
  if (!(await fileExists(dir))) return [];
  const out: RoleplayAgent[] = [];
  for (const entry of await readDir(dir)) {
    if (!entry.isDirectory || !isValidAgentId(entry.name)) continue;
    try {
      const meta = parsePersonaFrontmatter(await readFile(personaPath(projectPath, entry.name)));
      out.push({
        id: entry.name,
        kind: meta.kind,
        name: meta.name || entry.name,
        primaryDirPath: null,   // 只有花名册记绝对路径，人设卡里是相对的展示用值
        boundPaths: [],
        modelId: null,
        authorPersona: null,
        createdAt: 0,
        updatedAt: 0,
        turnCount: 0,
        boundHash: null,
      });
    } catch {
      // 连人设卡都读不出的目录不值得猜，跳过。
    }
  }
  return out;
}

export async function saveRoster(projectPath: string, roster: Roster): Promise<void> {
  await makeDir(roleplayDir(projectPath));
  const data = { v: 1, authorPersona: roster.authorPersona, agents: roster.agents };
  await writeFile(rosterPath(projectPath), `${JSON.stringify(data, null, 2)}\n`);
}

// ─── 人设卡 ──────────────────────────────────────────────────────────────────

interface PersonaMeta {
  kind: "character" | "narrator";
  name: string;
}

function parsePersonaFrontmatter(md: string): PersonaMeta {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta: PersonaMeta = { kind: "character", name: "" };
  if (!m) return meta;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    if (kv[1] === "kind" && kv[2].trim() === "narrator") meta.kind = "narrator";
    if (kv[1] === "name") meta.name = kv[2].trim();
  }
  return meta;
}

/** 人设卡正文（frontmatter 之后的一切）。读不到就是空指令，不是错误。 */
export async function loadPersonaCard(projectPath: string, agentId: string): Promise<string> {
  try {
    const path = personaPath(projectPath, agentId);
    if (!(await fileExists(path))) return "";
    const md = await readFile(path);
    const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    return (m ? md.slice(m[0].length) : md).trim();
  } catch (e) {
    console.warn(`[roleplay] persona card unreadable for ${agentId}:`, e);
    return "";
  }
}

export async function savePersonaCard(
  projectPath: string, agent: RoleplayAgent, instruction: string,
): Promise<void> {
  await makeDir(agentDir(projectPath, agent.id));
  const front = [
    "---",
    `id: ${agent.id}`,
    `kind: ${agent.kind}`,
    `name: ${agent.name}`,
    ...(agent.primaryDirPath ? [`primary: ${agent.primaryDirPath.split(/[/\\]/).slice(-2).join("/")}`] : []),
    "---",
    "",
  ].join("\n");
  await writeFile(personaPath(projectPath, agent.id), `${front}\n${instruction.trim()}\n`);
}

// ─── 会话（wire history） ────────────────────────────────────────────────────

export interface RoleplaySession {
  history: StreamMessage[];
  snapshot: ChatSnapshot;
  /** 绑定块在 history 里的位置，刷新绑定时按它定位。null = 没有绑定块。 */
  boundBlock: StreamMessage | null;
}

interface SerializedSession {
  v: 1;
  agentId: string;
  /** ./agent/chatSession 的 blob，原样嵌套——那套下标↔身份的重链接不重写第二遍。 */
  chat: string;
  /** 绑定块在 history 里的下标，-1 表示没有。 */
  boundBlock: number;
}

/**
 * 存一次会话。
 *
 * `turns` 传空数组是**故意**的：显示用的对话来自 transcript.md，不来自这个
 * blob。少存一份就少一份要和 transcript 保持一致的东西，而这正是不变量一
 * 想要的——session.json 丢了只损失模型脑子里的细节，不损失一个字的对话。
 */
export async function saveSession(
  projectPath: string, agentId: string, session: RoleplaySession,
): Promise<void> {
  const data: SerializedSession = {
    v: 1,
    agentId,
    chat: serializeChatSession({ ...session.snapshot, turns: [], history: session.history }),
    boundBlock: session.boundBlock ? session.history.indexOf(session.boundBlock) : -1,
  };
  await makeDir(agentDir(projectPath, agentId));
  await writeFile(sessionPath(projectPath, agentId), JSON.stringify(data));
}

/** 读一次会话。任何形状意外都返回 null——调用方从 transcript 重新播种。 */
export async function loadSession(
  projectPath: string, agentId: string,
): Promise<RoleplaySession | null> {
  try {
    const path = sessionPath(projectPath, agentId);
    if (!(await fileExists(path))) return null;
    const raw = JSON.parse(await readFile(path)) as SerializedSession;
    if (raw.v !== 1 || typeof raw.chat !== "string") return null;
    const snapshot = deserializeChatSession(raw.chat);
    if (!snapshot) return null;
    const i = raw.boundBlock;
    const boundBlock = Number.isInteger(i) && i >= 0 && i < snapshot.history.length
      ? snapshot.history[i]
      : null;
    return { history: snapshot.history, snapshot, boundBlock };
  } catch (e) {
    console.warn(`[roleplay] session unreadable for ${agentId}, will reseed:`, e);
    return null;
  }
}

// ─── 摘要 ────────────────────────────────────────────────────────────────────

export async function loadSummary(projectPath: string, agentId: string): Promise<string> {
  try {
    const path = summaryPath(projectPath, agentId);
    return (await fileExists(path)) ? (await readFile(path)).trim() : "";
  } catch {
    return "";
  }
}

export async function saveSummary(projectPath: string, agentId: string, text: string): Promise<void> {
  await makeDir(agentDir(projectPath, agentId));
  await writeFile(summaryPath(projectPath, agentId), `${text.trim()}\n`);
}

// ─── 新开会话 ────────────────────────────────────────────────────────────────

export const archiveDir = (p: string, id: string) => `${agentDir(p, id)}/archive`;

/**
 * 下一个存档编号。按**已有文件名解析出的最大值 + 1**，不按文件个数——作者
 * 手动删掉中间一场之后，按个数会撞名并覆盖掉另一场的记录。
 */
async function nextArchiveNo(dir: string): Promise<number> {
  if (!(await fileExists(dir))) return 1;
  let max = 0;
  for (const e of await readDir(dir)) {
    const m = /^transcript-(\d+)\.md$/.exec(e.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * 「新开会话」：把当前这一场封存，让 agent 从空白重新开始。
 *
 * **封存靠 rename，不靠改写**——transcript 是只追加、永不改写的资产（不变量
 * 一），移动一个文件不违反它，就地清空则会。作者攒了两周的互动必须一个字都
 * 不少地留在盘上，只是不再是「当前这一场」。
 *
 * `session.json` 是唯一直接删掉的：它按定义就是缓存，而且封存它毫无意义——
 * 一段接不回任何 transcript 的 wire history 谁也读不懂。
 *
 * 记忆默认**不动**。它是角色的长期知识，本就设计成能跨越压缩活下来；换一场
 * 戏不该让角色忘掉你们约好的事。作者明确要求清空时才一并封存（同样是移动）。
 *
 * @returns 这一场被存成了第几号，没有任何东西可封存时返回 null。
 */
export async function archiveSession(
  projectPath: string, agentId: string, opts: { clearMemory: boolean },
): Promise<number | null> {
  const transcript = transcriptPath(projectPath, agentId);
  const hasTranscript = await fileExists(transcript);
  const memory = memoryPath(projectPath, agentId);
  const hasMemory = opts.clearMemory && (await fileExists(memory));
  if (!hasTranscript && !hasMemory) {
    // 没有对话也没有要清的记忆——但 session.json 仍可能挂着一段坏掉的历史。
    await dropIfPresent(sessionPath(projectPath, agentId));
    return null;
  }

  const dir = archiveDir(projectPath, agentId);
  const no = String(await nextArchiveNo(dir)).padStart(2, "0");
  await makeDir(dir);

  if (hasTranscript) await renamePath(transcript, `${dir}/transcript-${no}.md`);
  const summary = summaryPath(projectPath, agentId);
  if (await fileExists(summary)) await renamePath(summary, `${dir}/summary-${no}.md`);
  if (hasMemory) await renamePath(memory, `${dir}/memory-${no}.md`);
  await dropIfPresent(sessionPath(projectPath, agentId));
  return Number(no);
}

async function dropIfPresent(path: string): Promise<void> {
  try {
    if (await fileExists(path)) await removeFile(path);
  } catch (e) {
    console.warn("[roleplay] stale cache not removed:", path, e);
  }
}

/** 一场封存的旧对话。`turns` 由调用方用 `parseTranscript` 解析。 */
export interface ArchivedScene {
  no: number;
  path: string;
}

/**
 * 列出封存过的场次，新的在前。
 *
 * 只认 `transcript-NN.md`——`summary-NN.md` / `memory-NN.md` 是它的附属品，
 * 没有对话的一场不该在列表里冒出来。
 */
export async function listArchives(
  projectPath: string, agentId: string,
): Promise<ArchivedScene[]> {
  const dir = archiveDir(projectPath, agentId);
  if (!(await fileExists(dir))) return [];
  const out: ArchivedScene[] = [];
  for (const e of await readDir(dir)) {
    const m = /^transcript-(\d+)\.md$/.exec(e.name);
    if (m) out.push({ no: Number(m[1]), path: `${dir}/${e.name}` });
  }
  return out.sort((a, b) => b.no - a.no);
}

// ─── 删除 ────────────────────────────────────────────────────────────────────

/**
 * 删一个 agent：整个目录移进 `.ai-writer/backups/`，和删条目、删文档一致。
 *
 * 不真删，因为里面有 transcript——那是作者写的字。
 */
export async function deleteAgentDir(
  projectPath: string, agentId: string, now: number,
): Promise<string | null> {
  const src = agentDir(projectPath, agentId);
  if (!(await fileExists(src))) return null;
  const backups = `${projectPath}/.ai-writer/backups`;
  await makeDir(backups);
  const dest = `${backups}/roleplay-${now}-${agentId}`;
  await renamePath(src, dest);
  return dest;
}
