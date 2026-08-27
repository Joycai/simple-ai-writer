/**
 * 旁白的只读 scene 工具。
 *
 * ## 不变量三
 *
 * 这五个工具是旁白「看得见全场」的**全部**通道，而它们只触达 `transcript.md` /
 * `summary.md` / `memory.md` / 记忆区——别人的 wire history 在这里没有路径。
 * 隔离因此是结构性的：扮演 agent 读不到对方，不是因为提示词请它别看，是因为
 * 它的工具集里没有这些名字，而这些名字也够不到那个东西。
 *
 * ## 场次地址
 *
 * 每个工具的 `scene` 参数收 `<agentId>` 或 `<agentId>#<N>`（见 ./scene）。裸 id
 * ＝当前这一场；`#N` ＝那个角色自己的第 N 场，可以是当前的也可以是归档的。
 * 地址空间是全的，模型不需要记特例。
 *
 * ## 废弃场次
 *
 * 作者用「另起一场」作废的场次**默认不可见**：不进 `list_scenes` 的清单、不进
 * `search_scenes` 的任何一层。显式给出地址仍然读得到——作者说「把上次那个试验场
 * 翻出来看看」时旁白得够得着——但内容前面必须挂一句「这一场已被作者废弃」，
 * 因为旁白是会往正文里写字的。
 *
 * ## 缓存
 *
 * `SceneReader` 对**当前**这一场每次都从磁盘读，不缓存：ToolContext 是一次运行
 * 的快照，而旁白讨论到一半时作者完全可能切去和某个角色又聊了三轮——一个捕获了
 * 快照的 reader 会让旁白坚定地说那三轮不存在。
 *
 * **归档是可以缓存的**，而且必须缓存：它 rename 进 `archive/` 之后永不再改，
 * 而一次跨场检索要把每个角色的每一场都读一遍。缓存的是**文件内容**，不是目录
 * 列表——列表每次重读，否则运行中途新封存的一场会消失。
 */

import type { ToolResult } from "../agent/tools";
import { formatSceneMemory } from "./memoryTools";
import {
  AREA_NOTE_LIMIT, ARCHIVE_DETAIL_LIMIT, DEFAULT_SCENE_WINDOW, SCENE_READ_CHAR_CAP,
  SEARCH_ARCHIVE_LIMIT, type MemoryRecord, type SceneTurn,
} from "./model";
import { formatSceneAddress, parseSceneAddress, resolveScene } from "./scene";
import { sliceTurns, searchTurns, type SceneHit } from "./transcript";

/** 一场归档在清单里的样子。 */
export interface ArchiveInfo {
  no: number;
  /** 作者作废了这一场（「另起一场」）。 */
  discarded: boolean;
  /**
   * `summary-NN.md` 的首行。空串 = 那一场没有摘要——**一直点「另起一场」的项目
   * 归档里根本不会有摘要**，那时日期就是唯一的抓手。
   */
  title: string;
  /** 轮数与首末时间。只有最近 `ARCHIVE_DETAIL_LIMIT` 场算，其余是 0。 */
  turnCount: number;
  from: number;
  to: number;
}

export interface SceneInfo {
  agentId: string;
  name: string;
  /** 主角条目名，没有则空串。 */
  primary: string;
  turnCount: number;
  /** 仍在生效的记忆条数——旁白扫一眼就知道哪条线还欠着东西。 */
  openMemory: number;
  /** Unix 秒，0 表示从没说过话。 */
  lastAt: number;
  /** 摘要首句，没有摘要时是最后一轮的预览。 */
  gist: string;
  /** 当前这一场的号（＝最大归档号 + 1）。 */
  sceneNo: number;
  /** 归档场次，新的在前。 */
  archives: ArchiveInfo[];
}

export interface SceneSlice {
  turns: SceneTurn[];
  total: number;
  renumbered: boolean;
}

/**
 * 记忆区里的一条——角色**以为**的事，转场时从常驻层沉下来的。
 *
 * 只带元数据不带正文：正文本身就是某一场的复述，而旁白现在能读到那一场的**原文**，
 * 那是严格更好的来源。所以这里给的是「标题 + 一句话 + 场次地址」，够它决定要不要
 * 去读原文。
 */
export interface AreaNote {
  title: string;
  summary: string;
  keys: string[];
  /** 来自第几场。0 = 不详，或这个区是继承来的、场号指不到当前 agent 的归档。 */
  scene: number;
}

export interface SceneReader {
  list(): Promise<SceneInfo[]>;
  /** 读某一场的逐轮记录。`scene` 已经由调用方解析成一个确实存在的号。 */
  read(agentId: string, scene: number): Promise<SceneSlice>;
  /** 某一场的摘要（当前场读 `summary.md`，归档读 `summary-NN.md`）。 */
  summary(agentId: string, scene: number): Promise<string>;
  /** 那个角色**现在**还记着的事。不分场次——记忆是角色的，不是场次的。 */
  memory(agentId: string, includeClosed: boolean): Promise<MemoryRecord[]>;
  /** 已经沉进记忆区的旧事。 */
  area(agentId: string): Promise<AreaNote[]>;
}

const NO_READER =
  "Scene tools are only available to a narrator agent in the roleplay panel.";

const DISCARDED_LEAD =
  "⚠ 这一场已被作者标为作废（「另起一场」）：它不属于故事，角色不记得它，也不该被写进正文。"
  + "作者点名要看时才在这里，请不要主动把它当作情节依据。\n\n";

function unknownScene(scenes: SceneInfo[], agentId: string): string {
  const ids = scenes.map((s) => `${s.agentId} (${s.name})`).join(", ");
  return `No scene with id "${agentId}". Known scenes: ${ids || "none"}. Call list_scenes first.`;
}

function renderTurns(turns: SceneTurn[], nameOf: (t: SceneTurn) => string): string {
  return turns
    .map((t) => `[${t.index}] ${nameOf(t)}\n${t.text}`)
    .join("\n\n");
}

/** `2026-08-14`，本地时间——读它的是作者和模型，不是机器。 */
function day(at: number): string {
  if (!at) return "";
  const d = new Date(at * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function span(from: number, to: number): string {
  const a = day(from);
  const b = day(to);
  if (!a && !b) return "";
  if (!b || a === b) return a || b;
  return `${a}~${b}`;
}

/** 一场归档在清单附行里的样子：`#3「雪停之后」40轮 08-14~08-16`。 */
function archiveChip(a: ArchiveInfo): string {
  const bits = [`#${a.no}`];
  if (a.title) bits.push(`「${a.title}」`);
  const tail: string[] = [];
  if (a.turnCount) tail.push(`${a.turnCount}轮`);
  const range = span(a.from, a.to);
  if (range) tail.push(range);
  return tail.length ? `${bits.join("")} ${tail.join(" ")}` : bits.join("");
}

// ─── list_scenes ─────────────────────────────────────────────────────────────

export async function listScenesTool(id: string, ctx: { scenes?: SceneReader }): Promise<ToolResult> {
  if (!ctx.scenes) return { toolCallId: id, content: NO_READER };
  const scenes = await ctx.scenes.list();
  if (!scenes.length) {
    return { toolCallId: id, content: "No roleplay scenes yet — the author has not created any character agents." };
  }

  const lines: string[] = [];
  for (const s of scenes) {
    const primary = s.primary ? ` · ${s.primary}` : "";
    const memory = s.openMemory > 0 ? ` · ${s.openMemory} live memory record(s)` : "";
    lines.push(
      `- ${s.agentId} — ${s.name}${primary} · 当前第 ${s.sceneNo} 场 ${s.turnCount} 轮`
      + `${memory}${s.gist ? ` · ${s.gist}` : ""}`,
    );

    // 归档压成一条附行。一场一行会让这份清单本身变成上下文负担。
    const kept = s.archives.filter((a) => !a.discarded);
    if (kept.length) {
      const shown = kept.slice(0, ARCHIVE_DETAIL_LIMIT).map(archiveChip);
      const rest = kept.length - shown.length;
      lines.push(
        `    已封存 ${kept.length} 场：${shown.join(" · ")}`
        + (rest > 0 ? ` · 另有 ${rest} 场更早的（按 #编号 直接读）` : ""),
      );
    }
    const voided = s.archives.filter((a) => a.discarded);
    if (voided.length) {
      // 说出来但不展开：作者要翻的时候旁白得知道它们存在，而它们不是情节。
      lines.push(
        `    另有 ${voided.length} 场已作废（${voided.map((a) => `#${a.no}`).join(" ")}）`
        + `——作者标为试验，不计入故事，除非他点名否则不要读`,
      );
    }
  }

  return {
    toolCallId: id,
    content: `${lines.join("\n")}\n\n场次地址是 <id> 或 <id>#<场号>（裸 id ＝当前这一场）。`
      + `先 read_scene_memory（这个角色还欠着什么）或 read_scene_summary（那一场发生了什么），`
      + `再用 read_scene 只读要紧的几轮。找不确定在哪一场的旧事，用 search_scenes。`,
  };
}

// ─── 地址解析 ────────────────────────────────────────────────────────────────

/**
 * 场景寻址一律用 `scene`（`list_scenes` 给出的 id，可带 `#场号`）。`agent` 是
 * 1.28 之前的拼法，仍然接受：模型面对的词汇是「场景」，只有线上参数名曾经说
 * agent，那个错位已经修掉。
 */
interface SceneArg { scene?: string; agent?: string }

interface Located {
  info: SceneInfo;
  no: number;
  discarded: boolean;
}

/** 把一个地址落到具体的一场。返回字符串＝要原样回给模型的错误。 */
function locate(scenes: SceneInfo[], args: SceneArg): Located | string {
  const raw = (args.scene ?? args.agent ?? "").trim();
  const { agentId, scene } = parseSceneAddress(raw);
  const info = scenes.find((s) => s.agentId === agentId);
  if (!info) return unknownScene(scenes, agentId);

  const resolved = resolveScene(info.archives.map((a) => a.no), scene);
  if (resolved.kind === "unknown") {
    const known = [
      ...info.archives.map((a) => `#${a.no}${a.discarded ? "(作废)" : ""}`),
      `#${info.sceneNo}(当前)`,
    ].join(" ");
    return `${info.name} 没有第 ${resolved.scene} 场。已有的场次：${known}。`;
  }
  return {
    info,
    no: resolved.scene,
    discarded: info.archives.some((a) => a.no === resolved.scene && a.discarded),
  };
}

/** 这一场在输出里怎么被称呼。 */
function label(loc: Located): string {
  const archive = loc.info.archives.find((a) => a.no === loc.no);
  const title = archive?.title ? `「${archive.title}」` : "";
  const which = loc.no === loc.info.sceneNo ? "当前这一场" : `第 ${loc.no} 场`;
  return `${loc.info.name} · ${which}${title}`;
}

// ─── read_scene ──────────────────────────────────────────────────────────────

interface ReadArgs extends SceneArg { from?: number; to?: number }

export async function readSceneTool(
  id: string, args: ReadArgs, ctx: { scenes?: SceneReader },
): Promise<ToolResult> {
  if (!ctx.scenes) return { toolCallId: id, content: NO_READER };
  const scenes = await ctx.scenes.list();
  const loc = locate(scenes, args);
  if (typeof loc === "string") return { toolCallId: id, content: loc };

  const { turns, total, renumbered } = await ctx.scenes.read(loc.info.agentId, loc.no);
  if (!total) return { toolCallId: id, content: `${label(loc)}：还没有任何对话。` };

  // 省略范围 = 最近一屏。作者问「刚才那段」的次数远多于问「第 12 轮」。
  const explicit = args.from !== undefined || args.to !== undefined;
  const window = explicit
    ? sliceTurns(turns, args.from, args.to)
    : sliceTurns(turns, Math.max(1, total - DEFAULT_SCENE_WINDOW + 1), total);

  const nameOf = (t: SceneTurn) => (t.speaker === "author" ? "作者" : t.speakerName || "角色");
  let body = renderTurns(window, nameOf);
  let cut = 0;
  if (body.length > SCENE_READ_CHAR_CAP) {
    // 按轮丢，不按字符切——半句话回不来，一整轮至少还能续读。
    const kept: SceneTurn[] = [];
    let used = 0;
    for (const t of window) {
      const cost = t.text.length + 24;
      if (used + cost > SCENE_READ_CHAR_CAP && kept.length) break;
      kept.push(t);
      used += cost;
    }
    cut = window.length - kept.length;
    body = renderTurns(kept, nameOf);
  }

  const notes: string[] = [`${label(loc)} 共 ${total} 轮。`];
  if (window.length) {
    notes.push(`本次返回 [${window[0].index}–${window[window.length - 1 - cut]?.index ?? window[0].index}]。`);
  }
  if (cut > 0) notes.push(`这个范围里还有 ${cut} 轮没有包含，用 from/to 收窄。`);
  if (renumbered) notes.push("读取时轮号被重排过（文件被手改过），旧的轮号引用可能对不上。");

  const lead = loc.discarded ? DISCARDED_LEAD : "";
  return { toolCallId: id, content: `${lead}${body}\n\n(${notes.join(" ")})` };
}

// ─── search_scenes ───────────────────────────────────────────────────────────

interface SearchArgs extends SceneArg { query?: string }

const HIT_CAP = 30;

/**
 * 跨场检索，**两层合一**。
 *
 * 逐字层搜 transcript（作者记得原话时命中），索引层搜场次前情和记忆区（作者只
 * 记得大意、用自己的话转述时命中——而那才是常态：他说「那次吵架」，而两人当时
 * 说的是「你根本没听我说」，一个字都对不上）。
 *
 * 不拆成两个工具：两层产出的是同一种可操作的东西（一个场次地址 + 一个理由），
 * 合在一起模型一次就能决策，而每加一个工具名都是每轮固定头部多一份 schema
 * 开销（见 docs/feature/agent/agent-tool-context.md）。
 */
export async function searchScenesTool(
  id: string, args: SearchArgs, ctx: { scenes?: SceneReader },
): Promise<ToolResult> {
  if (!ctx.scenes) return { toolCallId: id, content: NO_READER };
  const query = (args.query ?? "").trim();
  if (!query) return { toolCallId: id, content: "Provide a non-empty query." };

  const scenes = await ctx.scenes.list();
  const only = (args.scene ?? args.agent ?? "").trim();
  const targets = only
    ? scenes.filter((s) => s.agentId === parseSceneAddress(only).agentId)
    : scenes;
  if (only && !targets.length) {
    return { toolCallId: id, content: unknownScene(scenes, parseSceneAddress(only).agentId) };
  }

  const q = query.toLowerCase();
  const verbatim: string[] = [];
  const index: string[] = [];
  let found = 0;
  /** 逐字层没搜到那么早的场次数——必须说出来，不能让它看起来像「搜过了没有」。 */
  let skipped = 0;

  for (const s of targets) {
    // 废弃场次一层都不进。
    const kept = s.archives.filter((a) => !a.discarded);

    // ── 逐字层：当前这一场 + 最近 SEARCH_ARCHIVE_LIMIT 场归档 ──
    const deep = [s.sceneNo, ...kept.map((a) => a.no).slice(0, SEARCH_ARCHIVE_LIMIT)];
    skipped += Math.max(0, kept.length - SEARCH_ARCHIVE_LIMIT);
    for (const no of deep) {
      if (found >= HIT_CAP) break;
      const { turns } = await ctx.scenes.read(s.agentId, no);
      const hits: SceneHit[] = searchTurns(turns, query, HIT_CAP - found);
      for (const hit of hits) {
        verbatim.push(`- ${formatSceneAddress(s.agentId, no)}（${s.name}）第 ${hit.turn.index} 轮：${hit.line}`);
      }
      found += hits.length;
    }

    // ── 索引层：场次前情的标题 ──
    for (const a of kept) {
      if (a.title && a.title.toLowerCase().includes(q)) {
        index.push(`- ${formatSceneAddress(s.agentId, a.no)}（${s.name}）前情「${a.title}」`);
      }
    }

    // ── 索引层：记忆区 ──
    for (const note of await ctx.scenes.area(s.agentId)) {
      const hay = [note.title, note.summary, ...note.keys].join(" ").toLowerCase();
      if (!hay.includes(q)) continue;
      // 场号指得到才给地址：这个区可能是继承来的，那时 `scene: N` 说的是**上一个
      // 绑定者**的第 N 场，给出去就是一个指错场的链接。
      const addr = note.scene > 0 && (note.scene === s.sceneNo || kept.some((a) => a.no === note.scene))
        ? ` → ${formatSceneAddress(s.agentId, note.scene)}`
        : "";
      const keys = note.keys.length ? ` · 关键字 ${note.keys.join("·")}` : "";
      index.push(`- ${s.name} 记忆区「${note.title}」${keys}${note.summary ? ` · ${note.summary}` : ""}${addr}`);
    }
  }

  if (!verbatim.length && !index.length) {
    const note = skipped > 0
      ? `\n（逐字检索只覆盖了每个角色最近 ${SEARCH_ARCHIVE_LIMIT} 场，还有 ${skipped} 场更早的没有逐字搜过——用 read_scene 加场号直接读。）`
      : "";
    return { toolCallId: id, content: `没有任何一处匹配「${query}」。${note}` };
  }

  const parts: string[] = [];
  if (verbatim.length) parts.push(`逐字命中（对话原文）\n${verbatim.join("\n")}`);
  if (index.length) {
    parts.push(
      `索引命中（场次前情 / 记忆区 —— 这是角色**以为**的事，未必与正文一致）\n${index.join("\n")}`,
    );
  }
  parts.push("用 read_scene 加上面的场次地址读原文。");
  if (skipped > 0) {
    parts.push(`（逐字检索只覆盖了每个角色最近 ${SEARCH_ARCHIVE_LIMIT} 场，还有 ${skipped} 场更早的只搜了索引层。）`);
  }
  return { toolCallId: id, content: parts.join("\n\n") };
}

// ─── read_scene_summary ──────────────────────────────────────────────────────

export async function readSceneSummaryTool(
  id: string, args: SceneArg, ctx: { scenes?: SceneReader },
): Promise<ToolResult> {
  if (!ctx.scenes) return { toolCallId: id, content: NO_READER };
  const scenes = await ctx.scenes.list();
  const loc = locate(scenes, args);
  if (typeof loc === "string") return { toolCallId: id, content: loc };

  const summary = await ctx.scenes.summary(loc.info.agentId, loc.no);
  if (!summary) {
    return {
      toolCallId: id,
      content: `${label(loc)} 没有摘要——要么这一场短到没有折叠过，要么它是「另起一场」`
        + `结束的（那一支不产出前情）。用 read_scene 直接读。`,
    };
  }
  const lead = loc.discarded ? DISCARDED_LEAD : "";
  return { toolCallId: id, content: `${lead}${label(loc)} 摘要：\n\n${summary}` };
}

// ─── read_scene_memory ───────────────────────────────────────────────────────

export async function readSceneMemoryTool(
  id: string, args: SceneArg & { include_closed?: boolean }, ctx: { scenes?: SceneReader },
): Promise<ToolResult> {
  if (!ctx.scenes) return { toolCallId: id, content: NO_READER };
  const scenes = await ctx.scenes.list();
  const loc = locate(scenes, args);
  if (typeof loc === "string") return { toolCallId: id, content: loc };

  const records = await ctx.scenes.memory(loc.info.agentId, args.include_closed === true);
  const parts = [formatSceneMemory(records, loc.info.name)];

  // 第二层：已经沉下去的旧事。转场把常驻层里不再欠着的东西移进记忆区，所以
  // 只读第一层的旁白会以为这个角色什么都不记得——而它记得，只是不在眼前。
  const notes = await ctx.scenes.area(loc.info.agentId);
  if (notes.length) {
    const shown = notes.slice(0, AREA_NOTE_LIMIT).map((n) => {
      const where = n.scene > 0 ? `（第 ${n.scene} 场）` : "";
      const keys = n.keys.length ? ` · 关键字 ${n.keys.join("·")}` : "";
      return `- ${n.title}${where}${n.summary ? `：${n.summary}` : ""}${keys}`;
    });
    const rest = notes.length - shown.length;
    parts.push(
      `${loc.info.name} 的记忆区（已经沉下去的旧事，**这是它以为的事**，可能和正文不一致）：\n`
      + shown.join("\n")
      + (rest > 0 ? `\n（另有 ${rest} 条，用 search_scenes 按关键字找。）` : ""),
    );
  }

  return { toolCallId: id, content: parts.join("\n\n") };
}
