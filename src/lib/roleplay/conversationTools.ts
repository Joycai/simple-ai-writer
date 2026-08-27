/**
 * 一个 agent 回看**自己的**对话记录的两个工具。
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
 * 这两个工具是那句设计意图的正确落地：搜的是自己的对话，读的也是自己的对话。
 *
 * ## 作用域：自己的每一场，但只有自己的
 *
 * 转场之后旧的那一场进了 `archive/`，而「你还记得我们在雪原上说的话吗」问的多半
 * 就是那种场次——只能读当前这一场，等于让这两个工具在它们最该起作用的时候答不
 * 出来。所以它们**认场号**，覆盖这个角色自己的每一场。
 *
 * **作废的场次（作者的「另起一场」）一律不可见，连显式点名也不行**：过滤发生在
 * `ConversationReader.scenes()` 那一层，工具够不到它们。对角色来说那一场没有发生
 * 过，而「没发生过」不该是一个可以绕开的提示词约定。
 *
 * ## 和旁白的 scene 工具是两件事
 *
 * `sceneTools` 是旁白读**别人**的记录，每个调用都带一个 agent id；这里**没有 id
 * 可传**——通道由 `ToolContext.conversation` 绑死在本次运行的那个 agent 上。加了
 * 场号也不改变这一点：场号选的是「自己的哪一场」，不是「谁的场」。不变量三因此
 * 不受影响：角色仍然读不到任何别人的东西，代码里没有那条路径。
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
   * 这个 agent **自己**有哪几场可读：当前场号，加上封存过的旧场次。
   *
   * **作废的场次不在这里**（作者用「另起一场」标掉的）。过滤发生在这一层而不是
   * 工具里，所以角色连显式点名都够不到它们——那一场按作者的意思没有发生过，而
   * 「没发生过」不该是一个可以绕开的提示词约定。
   */
  scenes(): Promise<{ current: number; past: number[] }>;
  /**
   * 某一场的全部轮次。`scene` 由调用方从 `scenes()` 里挑，所以到这里已经保证
   * 可读。
   *
   * **当前这一场每次调用都读盘，不缓存**：同一次运行里作者的这一问已经落盘了，
   * 而 ToolContext 是运行开始时的快照——缓存会让角色坚定地说刚发生的事没发生。
   * 理由和 `SceneReader` 那条一样。
   */
  read(scene: number): Promise<{ turns: SceneTurn[]; renumbered: boolean }>;
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

/** 这一场在输出里怎么被称呼。当前场不加前缀——绝大多数调用问的就是它。 */
function where(scene: number, current: number): string {
  return scene === current ? "" : `scene ${scene} · `;
}

/**
 * 把一个场号落到可读的一场。返回字符串＝要原样回给模型的错误。
 *
 * 作废的场次走的是「不存在」这条路，而不是一句「你不能读它」——对角色来说那一场
 * 确实没有发生过，多说一句反而是在告诉它有一段它不该知道的历史。
 */
function pick(
  scenes: { current: number; past: number[] }, scene: number | undefined,
): number | string {
  if (scene === undefined) return scenes.current;
  if (scene === scenes.current || scenes.past.includes(scene)) return scene;
  const known = [...scenes.past, scenes.current].sort((a, b) => a - b).join(", ");
  return `You have no scene ${scene}. Yours are: ${known} (${scenes.current} is the one you are in now).`;
}

export async function searchConversationTool(
  id: string,
  args: { query?: string; scene?: number },
  ctx: { conversation?: ConversationReader },
): Promise<ToolResult> {
  if (!ctx.conversation) return { toolCallId: id, content: NO_READER };
  const query = (args.query ?? "").trim();
  if (!query) return { toolCallId: id, content: "Provide a non-empty query." };

  const scenes = await ctx.conversation.scenes();
  // 省略 scene = 搜**自己的每一场**。「你还记得我们在雪原上说的话吗」问的多半
  // 不是这一场——只搜当前场，等于让这个工具在它最该起作用的时候答不出来。
  let targets: number[];
  if (args.scene === undefined) {
    targets = [scenes.current, ...scenes.past];
  } else {
    const one = pick(scenes, args.scene);
    if (typeof one === "string") return { toolCallId: id, content: one };
    targets = [one];
  }

  const lines: string[] = [];
  let searched = 0;
  for (const scene of targets) {
    if (lines.length >= SEARCH_HIT_CAP) break;
    const { turns } = await ctx.conversation.read(scene);
    searched += turns.length;
    for (const h of searchTurns(turns, query, SEARCH_HIT_CAP - lines.length)) {
      lines.push(`- ${where(scene, scenes.current)}turn ${h.turn.index} · ${nameOf(h.turn)}: ${h.line}`);
    }
  }

  if (!searched) return { toolCallId: id, content: "This conversation has no turns yet." };
  if (!lines.length) {
    // 说清楚搜过了多少，否则模型会把「没搜到」读成「工具坏了」并再试一次。
    const scope = targets.length > 1 ? `all ${targets.length} of your scenes` : "this scene";
    return {
      toolCallId: id,
      content: `Nothing matches "${query}" (searched ${searched} turns across ${scope}). Matching is literal — try a distinctive word that was actually said.`,
    };
  }
  const more = lines.length >= SEARCH_HIT_CAP
    ? `\n(Stopped at ${SEARCH_HIT_CAP} matches — narrow the query.)`
    : "";
  return {
    toolCallId: id,
    content: `${lines.join("\n")}${more}\n\nUse read_conversation with those turn numbers `
      + "(and the scene, if it was not this one) to read what was actually said around them.",
  };
}

export async function readConversationTool(
  id: string,
  args: { from?: number; to?: number; scene?: number },
  ctx: { conversation?: ConversationReader },
): Promise<ToolResult> {
  if (!ctx.conversation) return { toolCallId: id, content: NO_READER };

  const scenes = await ctx.conversation.scenes();
  const scene = pick(scenes, args.scene);
  if (typeof scene === "string") return { toolCallId: id, content: scene };

  const { turns, renumbered } = await ctx.conversation.read(scene);
  const total = turns.length;
  if (!total) {
    return {
      toolCallId: id,
      content: scene === scenes.current
        ? "This conversation has no turns yet."
        : `Scene ${scene} has no turns.`,
    };
  }

  // 省略范围 = 最近一屏，和 read_scene 同一个判断：问「刚才那段」的次数远多于
  // 问「第 12 轮」。
  const explicit = args.from !== undefined || args.to !== undefined;
  const window = explicit
    ? sliceTurns(turns, args.from, args.to)
    : sliceTurns(turns, Math.max(1, total - DEFAULT_SCENE_WINDOW + 1), total);
  if (!window.length) {
    return {
      toolCallId: id,
      content: scene === scenes.current
        ? `No turns in that range. This conversation has turns 1–${total}.`
        : `No turns in that range. Scene ${scene} has turns 1–${total}.`,
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

  const notes = [
    scene === scenes.current
      ? `This conversation has ${total} turns.`
      : `Scene ${scene} (an earlier one of yours) has ${total} turns.`,
  ];
  notes.push(`Returned [${kept[0].index}–${kept[kept.length - 1].index}].`);
  if (cut > 0) notes.push(`${cut} more turn(s) in that range were left out — narrow it with from/to.`);
  if (renumbered) notes.push("Turn numbers shifted while reading (the record was edited by hand), so an older reference may not line up.");

  return { toolCallId: id, content: `${render(kept)}\n\n(${notes.join(" ")})` };
}
