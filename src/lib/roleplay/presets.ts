/**
 * 扮演与旁白的 preset。
 *
 * 两条刻意的收紧，都不是省事：
 *
 * **扮演 agent 没有任何写工具，也没有 `read_file` / `search_text`。** 一个角色
 * 不需要读作者的稿子——它活在故事里，不在文档里。扮演到一半弹出一张「要不要改
 * 第三章」的审批卡，是把两种完全不同的心流搅在一起。
 *
 * `search_text` 曾经留在这里，理由是「你还记得我们在雪原上说的话吗」需要检索。
 * 那个理由是对的，那个工具是错的：它扫的是工作区里的稿件并且排除 `.ai-writer/`，
 * 而 transcript 就住在那底下——它一辈子搜不到那句话。它实际能做的恰好是上一段
 * 说不该做的事（翻作者的稿子），而且是个死胡同，因为它的结果要接 `read_file`，
 * 而这里没有。换成 `search_conversation` / `read_conversation`：搜的是这一场
 * 对话，读的也是这一场对话，作用域由 `ToolContext.conversation` 绑死在自己身上。
 *
 * **扮演 agent 的工具集里没有任何 scene 工具。** 这是不变量三的落地方式：
 * 记忆隔离是结构性的，不靠 prompt 约定——角色之间读不到对方，是因为代码里
 * 没有那条路径，不是因为我们请求它别看。
 */

import type { TaskPreset } from "../agent/presets";

export const ROLEPLAY_PRESET: TaskPreset = {
  id: "roleplay-character",
  tools: [
    "list_lore_entities",
    "read_lore_entity",
    "read_lore_image",
    "read_image",
    // 回看自己这一场说过的话。没有 agent id 可传，所以它只够得到自己。
    "search_conversation",
    "read_conversation",
    // 唯一能写的东西：自己的记忆。碰不到稿子，也碰不到知识库。
    "remember",
    "revise_memory",
    "recall",
  ],
  /**
   * 小是刻意的：扮演的期望响应是一句台词，不是一次调研。比只读那版多一轮，
   * 是给「顺手记一条约定」留的空间。撞到上限说明模型在做错的事，而扮演不接
   * `onRoundLimit`（那张卡会打断一场戏），撞到就按 force-text 收尾——对这个
   * 场景这是正确的降级，不是将就。
   */
  maxRounds: 5,
  finishPolicy: "force-text",
  serverTools: "off",
};

export const NARRATOR_PRESET: TaskPreset = {
  id: "roleplay-narrator",
  tools: [
    "list_lore_entities",
    "read_lore_entity",
    "read_lore_image",
    "read_image",
    "list_files",
    "read_file",
    "read_slides",
    "search_text",
    "read_memory",
    "list_scenes",
    "read_scene",
    "search_scenes",
    "read_scene_summary",
    "read_scene_memory",
    // 旁白也有自己的记忆：它跟的是故事线，不是某个角色的承诺。
    "remember",
    "revise_memory",
    "recall",
    // 「把对话写进正文」就是这四个——不新建写工具，见 01-overview §6 决策 3。
    "propose_edit",
    "append_file",
    "create_chapter",
    "rewrite_lines",
    "write_note",
    "read_note",
    "list_notes",
  ],
  maxRounds: 20,
  finishPolicy: "force-text",
  scratchpad: "offered",
};

export function presetFor(kind: "character" | "narrator"): TaskPreset {
  return kind === "narrator" ? NARRATOR_PRESET : ROLEPLAY_PRESET;
}
