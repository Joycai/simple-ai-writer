/**
 * 转场时的前情摘要。
 *
 * 设计见 `docs/feature/roleplay/06-scene-and-memory-area.md` §5。三条不能改的：
 *
 * 1. **由角色自己写，第一人称。** 不是旁观者。这不是风格偏好，是隔离性要求——
 *    一段第三人称全知摘要会写进角色不该知道的事（它当时不在场的部分、别人的
 *    心理活动）。让它写「我会记住什么」，天然只含它知道的。
 * 2. **不进 transcript，也不进 wire history。** 它是出戏的一步，不是一轮对话。
 *    所以走结构化单发，而不是往会话里塞一轮。
 * 3. **`keys` 现在没人读，仍然要收。** 记忆区（PR 2）靠关键字命中，而那时再回头
 *    给已有的前情补关键字，就得把整场戏重新摘要一遍——那时 transcript 已经进
 *    archive，代价和现在收下它完全不成比例。
 */

import i18n from "../../i18n";
import { runStructuredTask } from "../agent/structured";
import { pickConnOptions, type ConnOptions } from "../ai/conn";
import type { ToolDefinition } from "../ai/types";
import { renderTurn } from "./transcript";
import type { MemoryRecord, SceneTurn } from "./model";

/** 一场戏最多喂多少字给摘要。超出取**最近的**——转场关心的是「刚发生了什么」。 */
export const RECAP_INPUT_CHAR_CAP = 24000;

export interface SceneRecap {
  title: string;
  body: string;
  /** 关键字。PR 1 只负责存下来，见文件头第 3 条。 */
  keys: string[];
}

const OUTPUT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "write_recap",
    description: "Record what you will remember from the scene that just ended.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "One short line naming the scene, in your own voice. No quotes.",
        },
        body: {
          type: "string",
          description:
            "What you will carry out of this scene, first person, a few sentences. " +
            "Only what you yourself witnessed or were told.",
        },
        keys: {
          type: "array",
          items: { type: "string" },
          description:
            "3-8 keywords that should bring this memory back later: names, places, " +
            "objects, promises. Use the words as they appear in the scene.",
        },
      },
      required: ["title", "body", "keys"],
    },
  },
};

/** 喂给摘要的那一段戏。最近优先，整轮为单位——半轮对话读不出谁在说话。 */
export function recapInput(turns: readonly SceneTurn[], cap = RECAP_INPUT_CHAR_CAP): string {
  const picked: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const text = renderTurn(turns[i]);
    if (used + text.length > cap && picked.length) break;
    picked.unshift(text);
    used += text.length;
  }
  return picked.join("");
}

/**
 * 跑一次前情摘要。
 *
 * `systemPrompt` 传角色自己的那一份（`buildSystemPrompt` 的产物），这样它是**以
 * 这个角色的身份**在回忆，而不是一个通用摘要器在压缩文本。
 */
export async function runSceneRecap(args: ConnOptions & {
  systemPrompt: string;
  turns: readonly SceneTurn[];
  /** 作者写的侧重，留空则由角色自行判断。 */
  brief?: string;
  /** 现有的记忆，让它别把已经记着的东西再抄一遍。 */
  memory: readonly MemoryRecord[];
  signal?: AbortSignal;
  onText?: (accumulated: string) => void;
}): Promise<SceneRecap> {
  const standing = args.memory
    .filter((r) => r.status === "open")
    .map((r) => `- ${r.title}${r.body ? `：${r.body}` : ""}`)
    .join("\n");

  const userContent = [
    i18n.t("ai.instructions.roleplayRecapLead", {
      defaultValue:
        "这一场结束了，你要去别的地方继续。下面是刚刚发生的事，写下**你**会带走的部分。",
    }),
    "",
    "【这一场 · THE SCENE】",
    recapInput(args.turns) || "(empty)",
    standing ? `\n【你已经记着的 · ALREADY IN YOUR MEMORY】\n${standing}` : "",
    args.brief?.trim()
      ? `\n【作者要你侧重 · WHAT THE AUTHOR WANTS KEPT】\n${args.brief.trim()}`
      : "",
  ].filter(Boolean).join("\n");

  const raw = await runStructuredTask({
    ...pickConnOptions(args),
    // 角色自己的 system prompt + 一句改写口径。不换 system 是关键：换掉它就等于
    // 换了一个人来回忆这场戏。
    systemPrompt: `${args.systemPrompt}\n\n${i18n.t("ai.instructions.roleplayRecap", {
      defaultValue:
        "## 现在做一件出戏的事\n" +
        "你要为刚结束的这一场写一份**只属于你自己**的记忆。\n" +
        "- 第一人称，用你平时说话的语气。\n" +
        "- **只写你亲历或听说的**。你不在场的事、别人心里想的事，你不知道。\n" +
        "- 已经记在你记事本里的东西不要重抄一遍，写这一场**新**发生的。\n" +
        "- 具体过细节，抽象过头等于没记：宁可写「她说雪停了就去塔下」，不要写「我们聊了计划」。",
    })}`,
    toolInstruction: "Call write_recap exactly once.",
    jsonInstruction:
      'Respond with ONLY a JSON object — no markdown fences, no prose — shaped ' +
      '{"title": string, "body": string, "keys": string[]}.',
    outputTool: OUTPUT_TOOL,
    userContent,
    signal: args.signal,
    onText: args.onText,
  });

  const parsed = JSON.parse(raw) as Partial<SceneRecap>;
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!title && !body) throw new Error("empty recap");
  return {
    // 标题空但正文有，仍然可用——给它一个能认的标题，别让整次摘要白跑。
    title: title || i18n.t("roleplay.recap.untitled", { defaultValue: "上一场" }),
    body,
    keys: Array.isArray(parsed.keys)
      ? parsed.keys.filter((k): k is string => typeof k === "string" && k.trim() !== "")
        .map((k) => k.trim()).slice(0, 12)
      : [],
  };
}
