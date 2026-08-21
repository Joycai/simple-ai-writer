/**
 * 一个 agent 回看**自己这一场**对话记录的两个工具。
 *
 * ## 为什么需要它，以及它替掉了什么
 *
 * 扮演 preset 原先带着 `search_text`，理由写在 02-design §7：「你还记得我们在
 * 雪原上说的话吗」这类问题需要检索。但 `search_text` 扫的是**工作区里的稿件**
 * 并且排除 `.ai-writer/`——transcript 就住在 `.ai-writer/roleplay/<id>/` 下，
 * 它一辈子搜不到。于是那个工具实际提供的能力恰好是设计说不该有的那个（让角色
 * 去翻作者的稿子），而且是个死胡同：它的结果是「路径:行号」，而扮演 preset
 * 故意没有 `read_file`，模型拿到之后只能去调一个不存在的工具。
 *
 * 这两个工具是那句设计意图的正确落地：搜的是这一场的对话，读的也是这一场的
 * 对话，且**只有自己这一场**。
 *
 * ## 和旁白的 scene 工具是两件事
 *
 * `sceneTools` 是旁白读**别人**的记录，每个调用都带一个 agent id；这里没有 id
 * 可传——通道由 `ToolContext.conversation` 绑死在本次运行的那个 agent 上。不变量
 * 三因此不受影响：角色仍然读不到任何别人的东西，代码里没有那条路径。
 *
 * 渲染逻辑和 `sceneTools` 形状相近却不共用：那边的说话人标签、越界提示、以及
 * 「先读摘要再读原文」的引导都是写给旁白的，而这边是写给一个正在戏里的角色。
 * 把两者参数化成一个函数，只会让每次改动都要先想清楚「这句话是对谁说的」。
 */

import type { ToolResult } from "../agent/tools";
import { DEFAULT_SCENE_WINDOW, SCENE_READ_CHAR_CAP, type SceneTurn } from "./model";
import { searchTurns, sliceTurns } from "./transcript";

export interface ConversationReader {
  /**
   * 本 agent 这一场的全部轮次。
   *
   * **每次调用都读盘，不缓存**：同一次运行里作者的这一问已经落盘了，而
   * ToolContext 是运行开始时的快照——缓存会让角色坚定地说刚发生的事没发生。
   * 理由和 `SceneReader` 那条一样。
   */
  read(): Promise<{ turns: SceneTurn[]; renumbered: boolean }>;
}

const NO_READER =
  "This tool only works inside a roleplay conversation.";

/** 一次 `search_conversation` 最多给多少条命中。 */
const SEARCH_HIT_CAP = 30;

function nameOf(turn: SceneTurn): string {
  if (turn.speaker === "author") return turn.speakerName || "对方";
  return "你";
}

function render(turns: SceneTurn[]): string {
  return turns.map((t) => `[${t.index}] ${nameOf(t)}\n${t.text}`).join("\n\n");
}

export async function searchConversationTool(
  id: string, args: { query?: string }, ctx: { conversation?: ConversationReader },
): Promise<ToolResult> {
  if (!ctx.conversation) return { toolCallId: id, content: NO_READER };
  const query = (args.query ?? "").trim();
  if (!query) return { toolCallId: id, content: "Provide a non-empty query." };

  const { turns } = await ctx.conversation.read();
  if (!turns.length) {
    return { toolCallId: id, content: "This conversation has no turns yet." };
  }
  const hits = searchTurns(turns, query, SEARCH_HIT_CAP);
  if (!hits.length) {
    // 说清楚搜过了多少，否则模型会把「没搜到」读成「工具坏了」并再试一次。
    return {
      toolCallId: id,
      content: `Nothing in this conversation matches "${query}" (searched all ${turns.length} turns). Matching is literal — try a distinctive word that was actually said.`,
    };
  }
  const lines = hits.map((h) => `- turn ${h.turn.index} · ${nameOf(h.turn)}: ${h.line}`);
  const more = hits.length >= SEARCH_HIT_CAP
    ? `\n(Stopped at ${SEARCH_HIT_CAP} matches — narrow the query.)`
    : "";
  return {
    toolCallId: id,
    content: `${lines.join("\n")}${more}\n\nUse read_conversation with those turn numbers to read what was actually said around them.`,
  };
}

export async function readConversationTool(
  id: string, args: { from?: number; to?: number }, ctx: { conversation?: ConversationReader },
): Promise<ToolResult> {
  if (!ctx.conversation) return { toolCallId: id, content: NO_READER };

  const { turns, renumbered } = await ctx.conversation.read();
  const total = turns.length;
  if (!total) return { toolCallId: id, content: "This conversation has no turns yet." };

  // 省略范围 = 最近一屏，和 read_scene 同一个判断：问「刚才那段」的次数远多于
  // 问「第 12 轮」。
  const explicit = args.from !== undefined || args.to !== undefined;
  const window = explicit
    ? sliceTurns(turns, args.from, args.to)
    : sliceTurns(turns, Math.max(1, total - DEFAULT_SCENE_WINDOW + 1), total);
  if (!window.length) {
    return {
      toolCallId: id,
      content: `No turns in that range. This conversation has turns 1–${total}.`,
    };
  }

  // 按轮丢，不按字符切——半句台词回不来，一整轮至少还能续读。
  const kept: SceneTurn[] = [];
  let used = 0;
  for (const t of window) {
    const cost = t.text.length + 24;
    if (used + cost > SCENE_READ_CHAR_CAP && kept.length) break;
    kept.push(t);
    used += cost;
  }
  const cut = window.length - kept.length;

  const notes = [`This conversation has ${total} turns.`];
  notes.push(`Returned [${kept[0].index}–${kept[kept.length - 1].index}].`);
  if (cut > 0) notes.push(`${cut} more turn(s) in that range were left out — narrow it with from/to.`);
  if (renumbered) notes.push("Turn numbers shifted while reading (the record was edited by hand), so an older reference may not line up.");

  return { toolCallId: id, content: `${render(kept)}\n\n(${notes.join(" ")})` };
}
