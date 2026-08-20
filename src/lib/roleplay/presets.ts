/**
 * 扮演与旁白的 preset。
 *
 * 两条刻意的收紧，都不是省事：
 *
 * **扮演 agent 没有任何写工具，也没有 `read_file`。** 一个角色不需要读作者
 * 的稿子——它活在故事里，不在文档里。扮演到一半弹出一张「要不要改第三章」
 * 的审批卡，是把两种完全不同的心流搅在一起。`search_text` 留着，因为
 * 「你还记得我们在雪原上说的话吗」需要它。
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
    "search_text",
  ],
  /**
   * 小是刻意的：扮演的期望响应是一句台词，不是一次调研。撞到上限说明模型
   * 在做错的事，而扮演面板不接 `onRoundLimit`（不渲染那张卡），撞到就按
   * force-text 收尾——对这个场景这是正确的降级，不是将就。
   */
  maxRounds: 4,
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
