/**
 * `transcript.md` — 一个 agent 的对话记录，**只追加，永不改写**。
 *
 * 这是不变量一：transcript 是资产，wire history 是缓存。压缩可以折叠 wire
 * history、`session.json` 可以损坏、模型可以换，这个文件都不受影响；反过来，
 * 它读不出来就没有任何东西能补回作者写下的字。
 *
 * 格式（设计与理由见 docs/feature/roleplay/02-design.md §3）：
 *
 *   <!-- roleplay-transcript v1 agent=rp-… -->
 *
 *   ## [1] 我 · 林 · 2026-08-20 14:03
 *
 *   *推开门，屋里没有点灯。*
 *   「你还在等？」
 *
 *   ## [2] 沈砚 · 2026-08-20 14:03
 *
 *   「等谁不重要。」
 *
 * 作者手改这个文件是**被允许的**，不是错误——所以解析永不抛异常，坏掉的块
 * 并入上一轮，全篇认不出就整篇当成一轮。宁可显示得难看，也不能让一次手误
 * 把整个面板打黑。
 */

import { appendFile, fileExists, readFile, writeFile } from "../fs/fileio";
import type { SceneTurn } from "./model";

/** 作者回合在标题里的固定标记。角色名来自知识库条目，撞上它的概率不值得设计。 */
const AUTHOR_TOKEN = "我";

const HEADING_RE = /^##\s*\[(\d+)\]\s*(.+?)\s*$/;

export function transcriptHeader(agentId: string): string {
  return `<!-- roleplay-transcript v1 agent=${agentId} -->\n`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2026-08-20 14:03`——本地时间，因为读它的是作者，不是机器。 */
export function formatStamp(at: number): string {
  const d = new Date(at * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseStamp(s: string): number | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function renderTurn(turn: SceneTurn): string {
  const fields = turn.speaker === "author"
    ? [AUTHOR_TOKEN, ...(turn.speakerName ? [turn.speakerName] : []), formatStamp(turn.at)]
    : [turn.speakerName || AUTHOR_TOKEN, formatStamp(turn.at)];
  return `\n## [${turn.index}] ${fields.join(" · ")}\n\n${turn.text.trim()}\n`;
}

export interface ParsedTranscript {
  turns: SceneTurn[];
  /**
   * 轮号缺失或重复，已按出现顺序重排。调用方（scene 工具）要把这件事如实
   * 告诉模型——它可能正拿着一个旧轮号来引用。
   */
  renumbered: boolean;
}

/**
 * 解析一份 transcript。永不抛。
 *
 * 认不出任何标题时返回单条记录承载全文，而不是空数组：空数组会让上层以为
 * 「这个 agent 没说过话」并渲染空态，而文件里明明有字。
 */
export function parseTranscript(md: string): ParsedTranscript {
  const body = md.replace(/^<!--[^>]*-->\s*/, "");
  const lines = body.split(/\r?\n/);

  const turns: SceneTurn[] = [];
  let current: { headIndex: number | null; speaker: "author" | "agent"; name: string; at: number; buf: string[] } | null = null;
  let sawHeading = false;
  let renumbered = false;

  const flush = () => {
    if (!current) return;
    const text = current.buf.join("\n").trim();
    turns.push({
      index: turns.length + 1,
      speaker: current.speaker,
      speakerName: current.name,
      at: current.at,
      text,
    });
    if (current.headIndex !== turns.length) renumbered = true;
    current = null;
  };

  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (!m) {
      if (current) current.buf.push(line);
      // 标题之前的散文没有归属：并进第一轮之前是不可能的，所以丢弃。
      // 这只会发生在作者在文件开头写了备注，而那不是一轮对话。
      continue;
    }
    sawHeading = true;
    flush();
    const fields = m[2].split("·").map((f) => f.trim()).filter(Boolean);
    const stamp = fields.length ? parseStamp(fields[fields.length - 1]) : null;
    const names = stamp === null ? fields : fields.slice(0, -1);
    const isAuthor = names[0] === AUTHOR_TOKEN;
    current = {
      headIndex: Number(m[1]),
      speaker: isAuthor ? "author" : "agent",
      name: isAuthor ? (names[1] ?? "") : (names[0] ?? ""),
      at: stamp ?? 0,
      buf: [],
    };
  }
  flush();

  if (!sawHeading) {
    const text = body.trim();
    if (!text) return { turns: [], renumbered: false };
    return {
      turns: [{ index: 1, speaker: "agent", speakerName: "", at: 0, text }],
      renumbered: true,
    };
  }

  return { turns, renumbered };
}

/** 读一份 transcript；文件不在就是「还没说过话」，不是错误。 */
export async function loadTranscript(path: string): Promise<ParsedTranscript> {
  try {
    if (!(await fileExists(path))) return { turns: [], renumbered: false };
    return parseTranscript(await readFile(path));
  } catch (e) {
    console.warn(`[roleplay] transcript unreadable at ${path}:`, e);
    return { turns: [], renumbered: false };
  }
}

/**
 * 追加一轮，返回分配到的轮号。
 *
 * 轮号由**调用方**从已加载的记录算出并传进来，而不是这里重读文件：一次
 * 发送要连写作者轮和角色轮，中间还夹着一次几十秒的模型调用，重读只会让
 * 两次读之间的手改变成一次轮号冲突。
 */
export async function appendTurn(path: string, agentId: string, turn: SceneTurn): Promise<void> {
  if (!(await fileExists(path))) {
    await writeFile(path, transcriptHeader(agentId) + renderTurn(turn));
    return;
  }
  await appendFile(path, renderTurn(turn));
}

/** 按轮号闭区间切片，越界钳到有效范围。 */
export function sliceTurns(turns: SceneTurn[], from?: number, to?: number): SceneTurn[] {
  if (!turns.length) return [];
  const lo = Math.max(1, from ?? 1);
  const hi = Math.min(turns.length, to ?? turns.length);
  if (hi < lo) return [];
  return turns.slice(lo - 1, hi);
}

export interface SceneHit {
  turn: SceneTurn;
  /** 命中所在的那一行，供模型判断要不要展开读。 */
  line: string;
}

/** 逐轮朴素检索。不建索引——见 02-design §7.3。 */
export function searchTurns(turns: SceneTurn[], query: string, cap: number): SceneHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SceneHit[] = [];
  for (const turn of turns) {
    if (!turn.text.toLowerCase().includes(q)) continue;
    const line = turn.text.split(/\r?\n/).find((l) => l.toLowerCase().includes(q)) ?? turn.text;
    hits.push({ turn, line: line.trim() });
    if (hits.length >= cap) break;
  }
  return hits;
}
