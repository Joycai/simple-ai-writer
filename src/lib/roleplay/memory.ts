/**
 * 角色记忆 —— `memory.md` 的格式、解析与注入块。
 *
 * ## 为什么它不是摘要
 *
 * 滚动摘要是**有损压缩**，而且会被再次摘要：一条「他答应雪停了一起去塔下」
 * 折进摘要，三轮之后就变成「他们聊了一些计划」。但那不是「之前发生的事」，
 * 那是**一个还没兑现的状态**——它必须原样活着，直到被兑现或作废。
 *
 * 所以记忆走独立存储、独立注入位置、独立生命周期（不变量四）。
 *
 * ## 三条写入规则
 *
 * L1 自动写没有审批卡兜底，唯一的安全阀是让**最坏情况只是多噪音，不会丢东西**：
 *
 * 1. **只增改，不删。** 没有 forget；作废是把状态改成 `void` 并保留正文。
 * 2. **每次写入前备份**（调用方用 `lib/agent/backup`，与所有 L1 写工具一致）。
 * 3. **没有整篇重写的工具。** 模型只能「新增一条」和「按 id 改一条」，所以一次
 *    坏调用的爆炸半径是一条记录。
 *
 * ## id 永不复用
 *
 * 机器头里的 `next=` 是计数器，删掉中间一条也不回退——transcript 和对话里对
 * 某条记忆的引用必须永远指向同一件事。
 */

import i18n from "../../i18n";
import { fileExists, readFile, writeFile } from "../fs/fileio";
import type { MemoryKind, MemoryRecord, MemoryStatus } from "./model";

/** 注入块的字符上限。超出的部分被点名为「还有 N 条」，由 `recall` 去读。 */
export const MEMORY_BLOCK_CHAR_CAP = 4000;

/**
 * 分组顺序，也是超预算时的取舍顺序。
 *
 * 约定和待办排在前面不是因为它们更重要，是因为它们**尚未了结**——一条没兑现的
 * 承诺被挤出上下文，角色就会失信；一件已经发生的事被挤出去，最多是少一点色彩。
 *
 * 前情紧随其后：它一场只有一条，而它被挤掉的后果是新的一场从**冷启动**开始
 * ——角色不记得自己刚从哪儿来。
 */
export const MEMORY_KINDS: readonly MemoryKind[] =
  ["pact", "todo", "scene", "bond", "event", "note"];

/**
 * 哪些种类有「完成」这个状态。
 *
 * 事件、关系、前情没有——它们不是待了结的事。前情会被**作废**（转场时上一条
 * 让位给新的一条），但那是 `void`，不是 `done`。
 */
export function hasDoneState(kind: MemoryKind): boolean {
  return kind === "pact" || kind === "todo";
}

export function kindLabel(kind: MemoryKind): string {
  const fallback: Record<MemoryKind, string> = {
    pact: "约定", todo: "待办", scene: "前情", event: "事件", bond: "关系", note: "其他",
  };
  return i18n.t(`roleplay.memory.kind.${kind}`, { defaultValue: fallback[kind] });
}

// ─── 文件格式 ────────────────────────────────────────────────────────────────

const HEADER_RE = /^<!--\s*roleplay-memory\s+v1\s+agent=(\S+)\s+next=(\d+)\s*-->/;
const SECTION_RE = /^##\s+.*<!--\s*(pact|todo|scene|event|bond|note)\s*-->\s*$/;
const RECORD_RE = /^###\s*\[(m\d+)\]\s*(.+?)\s*$/;

const KIND_SET = new Set<string>(MEMORY_KINDS);

function isKind(v: string): v is MemoryKind {
  return KIND_SET.has(v);
}

function isStatus(v: string): v is MemoryStatus {
  return v === "open" || v === "done" || v === "void";
}

export interface MemoryDoc {
  records: MemoryRecord[];
  /** 下一个可用的 id 序号。永不回退。 */
  next: number;
}

export const EMPTY_MEMORY: MemoryDoc = { records: [], next: 1 };

/**
 * 解析 `memory.md`。**永不抛异常**——作者手改这个文件是被允许的行为。
 *
 * 认不出的块不会被丢弃：它带着原文降级成一条 `note`，于是下一次写入把文件
 * 规范化重排时，作者写的字仍然在里面。
 */
export function parseMemory(md: string): MemoryDoc {
  const lines = md.split(/\r?\n/);
  const records: MemoryRecord[] = [];
  let next = 1;
  let section: MemoryKind = "note";
  let current: MemoryRecord | null = null;
  let buf: string[] = [];
  let maxSeen = 0;

  const flush = () => {
    if (!current) return;
    current.body = buf.join("\n").trim();
    records.push(current);
    current = null;
    buf = [];
  };

  for (const line of lines) {
    const header = line.match(HEADER_RE);
    if (header) {
      const n = Number(header[2]);
      if (Number.isFinite(n) && n > 0) next = n;
      continue;
    }
    const sec = line.match(SECTION_RE);
    if (sec) {
      flush();
      section = isKind(sec[1]) ? sec[1] : "note";
      continue;
    }
    const rec = line.match(RECORD_RE);
    if (rec) {
      flush();
      const id = rec[1];
      const n = Number(id.slice(1));
      if (Number.isFinite(n)) maxSeen = Math.max(maxSeen, n);
      const fields = rec[2].split("·").map((f) => f.trim());
      const title = fields[0] ?? "";
      const status = fields.find((f) => isStatus(f));
      const turnField = fields.find((f) => /^turn\s+\d+$/.test(f));
      // `keys=…` 必须先于 subject 排除掉，否则它会被当成主语。
      const keysField = fields.find((f) => f.startsWith(KEYS_PREFIX));
      const subject = fields.find(
        (f) => f !== title && !isStatus(f) && !/^turn\s+\d+$/.test(f)
          && !f.startsWith(KEYS_PREFIX),
      );
      current = {
        id,
        kind: section,
        title,
        body: "",
        status: status && isStatus(status) ? status : "open",
        turn: turnField ? Number(turnField.split(/\s+/)[1]) : 0,
        subject: subject ?? null,
        updatedAt: 0,
        keys: keysField ? splitKeys(keysField.slice(KEYS_PREFIX.length)) : [],
      };
      continue;
    }
    if (current) buf.push(line);
  }
  flush();

  // 机器头丢了也不能让 id 回退——用见过的最大序号兜底。
  return { records, next: Math.max(next, maxSeen + 1) };
}

const KEYS_PREFIX = "keys=";

/** 关键字里不能出现字段分隔符和自己的分隔符，否则这一行读不回来。 */
function sanitizeKey(k: string): string {
  return k.replace(/[·,]/g, " ").replace(/\s+/g, " ").trim();
}

function splitKeys(raw: string): string[] {
  return raw.split(",").map((k) => k.trim()).filter(Boolean);
}

/** 标题/主语和关键字同一条纪律：字段分隔符不能出现在字段里，否则这一行读不回来。 */
function sanitizeField(s: string): string {
  return s.replace(/·/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 正文行不能长得像本文件的结构行——`### [m9] …` 会被解析成一条新记录，把这条
 * 的正文劈成两半。前缀一个空格：markdown 视觉上无害，锚定 `^` 的三个正则都
 * 认不出它，往返时正文只多一个前导空格。
 */
function escapeBodyLine(line: string): string {
  return HEADER_RE.test(line) || SECTION_RE.test(line) || RECORD_RE.test(line)
    ? ` ${line}`
    : line;
}

function renderRecord(r: MemoryRecord): string {
  const keys = r.keys.map(sanitizeKey).filter(Boolean);
  const fields = [
    sanitizeField(r.title),
    ...(r.subject ? [sanitizeField(r.subject)] : []),
    r.status,
    `turn ${r.turn}`,
    ...(keys.length ? [`${KEYS_PREFIX}${keys.join(",")}`] : []),
  ];
  const body = r.body.trim().split(/\r?\n/).map(escapeBodyLine).join("\n");
  return `### [${r.id}] ${fields.join(" · ")}\n${body}\n`;
}

/** 把整份记忆写回规范格式。分组顺序固定，组内按 id 升序（＝记下的先后）。 */
export function renderMemory(agentId: string, doc: MemoryDoc): string {
  const out: string[] = [`<!-- roleplay-memory v1 agent=${agentId} next=${doc.next} -->\n`];
  for (const kind of MEMORY_KINDS) {
    const group = doc.records
      .filter((r) => r.kind === kind)
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    if (!group.length) continue;
    out.push(`## ${kindLabel(kind)} <!-- ${kind} -->\n`);
    for (const r of group) out.push(renderRecord(r));
  }
  return `${out.join("\n")}`;
}

// ─── 增 / 改 ─────────────────────────────────────────────────────────────────

export type NewRecord =
  Pick<MemoryRecord, "kind" | "title" | "body" | "turn" | "subject"> & { keys?: string[] };

/** 追加一条，分配一个**永不复用**的 id。返回新文档和那条记录。 */
export function addRecord(doc: MemoryDoc, rec: NewRecord, now: number): {
  doc: MemoryDoc;
  record: MemoryRecord;
} {
  const record: MemoryRecord = {
    ...rec, keys: rec.keys ?? [], id: `m${doc.next}`, status: "open", updatedAt: now,
  };
  return {
    doc: { records: [...doc.records, record], next: doc.next + 1 },
    record,
  };
}

/**
 * 改一条已有记录的正文或状态。id 不存在时返回 null——**不新建**。
 *
 * 静默新建会让模型以为自己改成功了，而作者会看到两条内容矛盾的记录，谁都不知道
 * 哪条在生效。
 */
/**
 * 回退到某一轮时丢掉在那之后记下的记录。
 *
 * 「记忆只增改不删」防的是**模型**删自己不想要的记录；作者按下回退是另一回事——
 * 一条「我们约好雪停了去塔下」如果诞生在一段已经被撤销的对话里，留着它比删掉它
 * 更糟：角色会言之凿凿地提起一件从没发生过的事。
 *
 * `turn: 0` 是作者自己写的，永远不动——它不属于任何一轮。
 *
 * **不撤销修订**：某条旧记录在被撤销的那几轮里被标成了 `done`，这里不会把它翻
 * 回 `open`。要那样就得给每条记录存一份状态变更史，而回退是个低频动作，代价
 * 不成比例。`next` 同样不回退，id 只增不重用。
 */
export function dropRecordsFrom(doc: MemoryDoc, fromTurn: number): {
  doc: MemoryDoc;
  dropped: MemoryRecord[];
} {
  const dropped = doc.records.filter((r) => r.turn > 0 && r.turn >= fromTurn);
  if (!dropped.length) return { doc, dropped: [] };
  return {
    doc: { records: doc.records.filter((r) => !dropped.includes(r)), next: doc.next },
    dropped,
  };
}

/**
 * 转场时的分拣：哪些记录沉进记忆区、常驻层剩下什么。
 *
 * 规则按性质，不按预算（06 §3.1）：欠着的约定/待办、关系留在常驻层；其余
 * （事件、其他、旧前情、已兑现/已作废的约定）**移出**常驻层，由调用方逐条写进
 * 记忆区。
 *
 * 是**移出**而不是标 `void` 留档——这半句话曾经写错过：沉降后的记录被标成
 * `void` 留在 memory.md 里，而这个过滤器对 `void` 记录永远命中，于是每转一场，
 * 全部历史记录都被再灌进记忆区一遍，条目随转场次数平方级膨胀。移出也正是设计
 * 文档的原文（「移出常驻层」）；「只增改不删」那条纪律防的是模型删自己不想要的
 * 记录，转场分拣和回退（`dropRecordsFrom`）一样，是作者按下的动作。
 *
 * `next` 计数器不动：id 永不复用，即使那条记录已经沉走。
 */
export function takeSinkable(doc: MemoryDoc): { doc: MemoryDoc; sinking: MemoryRecord[] } {
  const sinking = doc.records.filter(
    (r) => !((r.kind === "pact" || r.kind === "todo") && r.status === "open") && r.kind !== "bond",
  );
  if (!sinking.length) return { doc, sinking: [] };
  return {
    doc: { records: doc.records.filter((r) => !sinking.includes(r)), next: doc.next },
    sinking,
  };
}

export function reviseRecord(
  doc: MemoryDoc,
  id: string,
  patch: { body?: string; status?: MemoryStatus },
  now: number,
): { doc: MemoryDoc; record: MemoryRecord } | null {
  const i = doc.records.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const record: MemoryRecord = {
    ...doc.records[i],
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    updatedAt: now,
  };
  const records = [...doc.records];
  records[i] = record;
  return { doc: { ...doc, records }, record };
}

// ─── 注入块 ──────────────────────────────────────────────────────────────────

/**
 * 渲染进上下文的那一块。
 *
 * **只放 `open` 的记录**：已经兑现或作废的约定不再是「现在生效的状态」，把它们
 * 也送进去既费预算又误导——模型会以为那件事还悬着。`done` / `void` 只能通过
 * `recall({include_closed: true})` 读到。
 */
export function renderMemoryBlock(records: readonly MemoryRecord[], cap = MEMORY_BLOCK_CHAR_CAP): string {
  const open = records.filter((r) => r.status === "open");
  if (!open.length) return "";

  const lines: string[] = [];
  let used = 0;
  let dropped = 0;

  for (const kind of MEMORY_KINDS) {
    const group = open.filter((r) => r.kind === kind);
    if (!group.length) continue;
    const heading = `【${kindLabel(kind)}】`;
    let headed = false;
    for (const r of group) {
      const subject = r.subject ? `对 ${r.subject}：` : "";
      const body = r.body ? `：${r.body.replace(/\s*\n\s*/g, " ")}` : "";
      const line = `- (${r.id}) ${subject}${r.title}${body}`;
      const cost = line.length + (headed ? 0 : heading.length + 1);
      if (used + cost > cap) { dropped += 1; continue; }
      if (!headed) { lines.push(heading); headed = true; used += heading.length + 1; }
      lines.push(line);
      used += line.length;
    }
  }

  if (!lines.length) return "";
  if (dropped > 0) {
    // 和 read_file 分页读同一套话术——模型已经学会了这个形状。
    lines.push(i18n.t("roleplay.memory.blockOverflow", {
      n: dropped,
      defaultValue: `（还有 ${dropped} 条较早的记录没有列出，需要时用 recall 读。）`,
    }));
  }
  return lines.join("\n");
}

// ─── IO ──────────────────────────────────────────────────────────────────────

export async function loadMemoryDoc(path: string): Promise<MemoryDoc> {
  try {
    if (!(await fileExists(path))) return EMPTY_MEMORY;
    return parseMemory(await readFile(path));
  } catch (e) {
    console.warn(`[roleplay] memory unreadable at ${path}:`, e);
    return EMPTY_MEMORY;
  }
}

export async function saveMemoryDoc(path: string, agentId: string, doc: MemoryDoc): Promise<void> {
  await writeFile(path, renderMemory(agentId, doc));
}
