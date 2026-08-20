/**
 * 旁白的只读 scene 工具。
 *
 * ## 不变量三
 *
 * 这四个工具是旁白「看得见全场」的**全部**通道，而它们只触达
 * `transcript.md` / `summary.md`——别人的 wire history 在这里没有路径。
 * 隔离因此是结构性的：扮演 agent 读不到对方，不是因为提示词请它别看，是
 * 因为它的工具集里没有这些名字，而这些名字也够不到那个东西。
 *
 * `SceneReader` **每次调用都从磁盘读，不缓存**。ToolContext 是一次运行的
 * 快照，而旁白讨论到一半时作者完全可能切去和某个角色又聊了三轮——一个捕获
 * 了快照的 reader 会让旁白坚定地说那三轮不存在。
 */

import type { ToolResult } from "../agent/tools";
import { formatSceneMemory } from "./memoryTools";
import {
  DEFAULT_SCENE_WINDOW, SCENE_READ_CHAR_CAP, type MemoryRecord, type SceneTurn,
} from "./model";
import { sliceTurns, searchTurns, type SceneHit } from "./transcript";

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
}

export interface SceneSlice {
  turns: SceneTurn[];
  total: number;
  renumbered: boolean;
}

export interface SceneReader {
  list(): Promise<SceneInfo[]>;
  read(agentId: string): Promise<SceneSlice>;
  summary(agentId: string): Promise<string>;
  /** 那个角色记下的、仍在生效的事。比读整份记录便宜得多，也更是重点。 */
  memory(agentId: string, includeClosed: boolean): Promise<MemoryRecord[]>;
}

const NO_READER =
  "Scene tools are only available to a narrator agent in the roleplay panel.";

function unknownScene(reader: SceneInfo[], agentId: string): string {
  const ids = reader.map((s) => `${s.agentId} (${s.name})`).join(", ");
  return `No scene with id "${agentId}". Known scenes: ${ids || "none"}. Call list_scenes first.`;
}

function renderTurns(turns: SceneTurn[], nameOf: (t: SceneTurn) => string): string {
  return turns
    .map((t) => `[${t.index}] ${nameOf(t)}\n${t.text}`)
    .join("\n\n");
}

export async function listScenesTool(id: string, ctx: { scenes?: SceneReader }): Promise<ToolResult> {
  if (!ctx.scenes) return { toolCallId: id, content: NO_READER };
  const scenes = await ctx.scenes.list();
  if (!scenes.length) {
    return { toolCallId: id, content: "No roleplay scenes yet — the author has not created any character agents." };
  }
  const lines = scenes.map((s) => {
    const primary = s.primary ? ` · ${s.primary}` : "";
    const memory = s.openMemory > 0 ? ` · ${s.openMemory} live memory record(s)` : "";
    return `- ${s.agentId} — ${s.name}${primary} · ${s.turnCount} turns${memory}${s.gist ? ` · ${s.gist}` : ""}`;
  });
  return {
    toolCallId: id,
    content: `${lines.join("\n")}\n\nStart with read_scene_memory (what a character is still committed to) or read_scene_summary (what happened), then read_scene only for the turns that matter.`,
  };
}

interface ReadArgs { agent?: string; from?: number; to?: number }

export async function readSceneTool(
  id: string, args: ReadArgs, ctx: { scenes?: SceneReader },
): Promise<ToolResult> {
  if (!ctx.scenes) return { toolCallId: id, content: NO_READER };
  const agentId = (args.agent ?? "").trim();
  const scenes = await ctx.scenes.list();
  if (!scenes.some((s) => s.agentId === agentId)) {
    return { toolCallId: id, content: unknownScene(scenes, agentId) };
  }

  const { turns, total, renumbered } = await ctx.scenes.read(agentId);
  if (!total) return { toolCallId: id, content: "This scene has no turns yet." };

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

  const notes: string[] = [`Scene has ${total} turns total.`];
  if (window.length) notes.push(`Returned [${window[0].index}–${window[window.length - 1 - cut]?.index ?? window[0].index}].`);
  if (cut > 0) notes.push(`${cut} more turn(s) in this range were not included — narrow it with from/to.`);
  if (renumbered) notes.push("Turn numbers were renumbered while reading (the file was edited by hand), so an older reference may not line up.");

  return { toolCallId: id, content: `${body}\n\n(${notes.join(" ")})` };
}

interface SearchArgs { query?: string; agent?: string }

export async function searchScenesTool(
  id: string, args: SearchArgs, ctx: { scenes?: SceneReader },
): Promise<ToolResult> {
  if (!ctx.scenes) return { toolCallId: id, content: NO_READER };
  const query = (args.query ?? "").trim();
  if (!query) return { toolCallId: id, content: "Provide a non-empty query." };

  const scenes = await ctx.scenes.list();
  const targets = args.agent ? scenes.filter((s) => s.agentId === args.agent) : scenes;
  if (args.agent && !targets.length) {
    return { toolCallId: id, content: unknownScene(scenes, args.agent) };
  }

  const lines: string[] = [];
  let found = 0;
  for (const scene of targets) {
    const { turns } = await ctx.scenes.read(scene.agentId);
    const hits: SceneHit[] = searchTurns(turns, query, 30 - found);
    for (const hit of hits) {
      lines.push(`- ${scene.agentId} (${scene.name}) turn ${hit.turn.index}: ${hit.line}`);
    }
    found += hits.length;
    if (found >= 30) break;
  }
  if (!lines.length) return { toolCallId: id, content: `No turn matches "${query}".` };
  return {
    toolCallId: id,
    content: `${lines.join("\n")}\n\nUse read_scene with the turn numbers above to read the surrounding conversation.`,
  };
}

export async function readSceneSummaryTool(
  id: string, args: { agent?: string }, ctx: { scenes?: SceneReader },
): Promise<ToolResult> {
  if (!ctx.scenes) return { toolCallId: id, content: NO_READER };
  const agentId = (args.agent ?? "").trim();
  const scenes = await ctx.scenes.list();
  const scene = scenes.find((s) => s.agentId === agentId);
  if (!scene) return { toolCallId: id, content: unknownScene(scenes, agentId) };

  const summary = await ctx.scenes.summary(agentId);
  if (!summary) {
    return {
      toolCallId: id,
      content: `No rolling summary for "${scene.name}" yet — the scene is short enough that nothing has been folded away. Use read_scene to read it directly (${scene.turnCount} turns).`,
    };
  }
  return { toolCallId: id, content: `${scene.name} — rolling summary:\n\n${summary}` };
}

export async function readSceneMemoryTool(
  id: string, args: { agent?: string; include_closed?: boolean }, ctx: { scenes?: SceneReader },
): Promise<ToolResult> {
  if (!ctx.scenes) return { toolCallId: id, content: NO_READER };
  const agentId = (args.agent ?? "").trim();
  const scenes = await ctx.scenes.list();
  const scene = scenes.find((s) => s.agentId === agentId);
  if (!scene) return { toolCallId: id, content: unknownScene(scenes, agentId) };

  const records = await ctx.scenes.memory(agentId, args.include_closed === true);
  return { toolCallId: id, content: formatSceneMemory(records, scene.name) };
}
