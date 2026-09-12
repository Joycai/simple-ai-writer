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
import type { SubAgentConfig, SubAgentKind } from "../agent/subagent";

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
    // 这里**没有** read_slides / read_document：旁白读的是稿子和知识库，不是幻灯片
    // 或 Word 文件——把这一场对话写进正文，用不着翻一份 .pptx。两个工具一起缺
    // 是有意的：只留一个会更糟，`read_file` 撞上 .docx 时写死了「用 read_document」
    // 而那是一个这里没有的工具。缺全套时它至少是一句让模型停手的拒绝，不是死循环。
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

/**
 * 扮演角色认得的子代理——**白名单，只有 vision**。
 *
 * 这是不变量三的第二处落地，和「preset 里没有 scene 工具」同一条理由：隔离
 * 是结构性的。02-design §8 建 workspace 的论证从头到尾只讲一件事——作者开了
 * vision 子代理之后，`routeTools` 会把 `read_image` 摘掉，角色既不能自己看图
 * 也不能委派给会看图的，看图能力凭空消失。对策本身是对的，但 `routeTools` 里
 * 那句 `DELEGATE_KINDS.some(live)` 是**四选一**：只要 search / longread / pdf
 * 里任何一个开着，扮演角色就一并拿到 `delegate`，而 longread 子代理的工具集
 * 正是 `read_file` / `search_text` / `list_files`——这个 preset 开头刚说过一个
 * 角色不该做的那件事，隔了一层间接又回来了。`translate` 那句 push 同理。
 *
 * 所以这里是白名单而不是黑名单：这个 bug 的形状就是「新加一种子代理，从一个
 * `some()` 里漏进来」，而下一种子代理不该需要有人记得回来改这一行。
 *
 * 一并关掉的几种今天都不改变任何东西——`imagegen` 只让 `routeTools` 摘掉三个
 * 这个 preset 本来就没有的画图工具，`writer` 要 `RouteOptions.handoff` 而
 * roleplay 一次都没传过。关掉它们是为了让这份清单说的就是全部，而不是「今天
 * 恰好等价」。
 *
 * 旁白**原样返回**：读稿子、翻资料、联网查证本来就是它的活。
 *
 * 每一处拿 subs 去算工具、算预算、或者解析子代理连接的地方都要过这一层，否则
 * 三个数会各说各的：`routeTools` 给的工具集、`plannedToolTokens` 估的 schema
 * 开销、`resolveSubAgent` 真正放行的 kind。
 */
const CHARACTER_SUBAGENT_KINDS: readonly SubAgentKind[] = ["vision"];

export function subAgentsFor(
  kind: "character" | "narrator",
  subs: Record<SubAgentKind, SubAgentConfig>,
): Record<SubAgentKind, SubAgentConfig> {
  if (kind === "narrator") return subs;
  // 走**入参自己的键**而不是 `SUBAGENT_KINDS`：那样才真的是白名单。绕开
  // `withSessionOverrides`（它要的是一份「关掉这些」的清单）也是为了这个——
  // 从常量表推出来的关闭清单，对一个还没进那张表的 kind 是不设防的，而
  // 「新加一种子代理」正是这条不变量唯一会被打破的场合。
  const out = { ...subs };
  for (const k of Object.keys(out) as SubAgentKind[]) {
    if (CHARACTER_SUBAGENT_KINDS.includes(k)) continue;
    if (out[k]) out[k] = { ...out[k], enabled: false };
  }
  return out;
}
