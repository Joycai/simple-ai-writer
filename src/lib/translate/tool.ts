/**
 * `translate` 工具的处理器。
 *
 * 助手对 Sakura 的**唯一**接口。它不是一次 delegate 子对话——那需要对方能读
 * 任务描述，而 Sakura 会把任务描述当日文原文翻掉（实测 E3）。所以形态照
 * `generate_image` 抄：绑定 + 工具，模型本体由 `lib/translate/run` 直接调用。
 *
 * 本片只做 `text`（对话里的一段文本）。整文件那条路在 PR 4，所以超过一块的
 * 输入在这里**明确拒绝并说清楚**，而不是偷偷截断——截断的译文看起来是完整的。
 */

import { connOptions, type AiConn } from "../ai/conn";
import { loadApiKey } from "../keyStore";
import type { ToolContext } from "../agent/registry";
import type { ToolResult } from "../agent/tools";
import { subAgentModel } from "../agent/subagent";
import { splitDocument } from "./chunk";
import { isTranslateLoreEnabled } from "./flag";
import { runChunk } from "./run";

/**
 * 绑定的翻译模型 + 它的端点 + 凭据，或者说清为什么没有。
 *
 * 动态 import aiStore，和 `imageTools.activeImageModel` 同一条理由：`lib/` 不
 * 反向依赖 `stores/`，而这个工具确实需要读作者在设置里绑了什么。
 */
async function resolveTranslateConn(): Promise<AiConn | { error: string }> {
  const { useAiStore } = await import("../../stores/aiStore");
  const { models, providers, subAgents } = useAiStore.getState();

  const model = subAgentModel("translate", models, subAgents);
  if (!model) {
    return {
      error:
        "the translation subagent is not usable. Tell the author to enable it in Settings → 子代理 " +
        "and bind a model whose 翻译模型格式 is set (Settings → 供应商与模型).",
    };
  }
  const provider = providers.find((p) => p.id === model.providerId);
  if (!provider) return { error: `the provider serving "${model.name}" is gone. Tell the author to re-add it.` };

  // 本地端点通常没有 key，空串是**合法**的——这里不像别的子代理那样把"没有 key"
  // 当成配置错误报出去，否则 LM Studio / Ollama 这条主线永远走不通。
  const apiKey = (await loadApiKey(provider.id)) ?? "";
  return { provider, model, apiKey };
}

export interface TranslateArgs {
  text?: string;
}

export async function translateTool(
  toolCallId: string,
  args: TranslateArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fail = (msg: string): ToolResult => ({ toolCallId, content: `Error: ${msg}` });

  const text = args.text?.trim();
  if (!text) {
    return fail("'text' is required — pass the Japanese text to translate, verbatim.");
  }

  const { allLines, chunks } = splitDocument(text);
  if (!chunks.length) {
    return fail(
      "nothing to translate — no Japanese was found in that text. This model only translates Japanese into Chinese.",
    );
  }
  if (chunks.length > 1) {
    return fail(
      `that text is ${chunks.reduce((n, c) => n + c.lines.length, 0)} lines, which is more than one request can carry. ` +
        "Pass a shorter passage.",
    );
  }

  const conn = await resolveTranslateConn();
  if ("error" in conn) return fail(conn.error);

  const outcome = await runChunk(chunks[0], {
    conn: connOptions(conn),
    loreIndex: isTranslateLoreEnabled() ? ctx.loreIndex : undefined,
    signal: ctx.signal,
  });

  if (!outcome.ok) {
    const last = outcome.attempts[outcome.attempts.length - 1];
    return fail(
      `the translation model failed on this passage after ${outcome.attempts.length} attempts` +
        (last?.detail ? ` (${last.reason}: ${last.detail})` : "") +
        ". Try a shorter passage. Do NOT translate it yourself — you are not the translation model here.",
    );
  }

  // 按行号装回，于是空行和 URL 保持原位——原文的形状就是译文的形状。
  const out = [...allLines];
  for (const l of outcome.lines) out[l.index] = l.text;
  return { toolCallId, content: out.join("\n") };
}
