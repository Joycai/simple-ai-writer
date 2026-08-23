/**
 * `translate` 工具的处理器。
 *
 * 助手对 Sakura 的**唯一**接口。它不是一次 delegate 子对话——那需要对方能读
 * 任务描述，而 Sakura 会把任务描述当日文原文翻掉（实测 E3）。所以形态照
 * `generate_image` 抄：绑定 + 工具，模型本体由 `lib/translate/run` 直接调用。
 *
 * 两条路：
 *
 * - `text` —— 对话里的一段。一次请求，译文直接回给模型，什么都不写。
 * - `path` —— 项目里的一份文档。分块跑完写成 `<原名>.zh.md`，**走审批卡片**。
 *   译文和图片一样是不可逆地覆盖认知的东西：机翻的结果作者应该在落盘前看见。
 *
 * 两条路共享一件事：产物的**形状**就是原文的形状。空行、URL、分隔线原位不动，
 * 因为它们根本没被送进模型（见 `chunk.isTranslatable`）。
 */

import { costFor } from "../ai/configDb";
import { connOptions, type AiConn } from "../ai/conn";
import { persistUsage } from "../ai/usage";
import { loadApiKey } from "../keyStore";
import { fileExists, readFile } from "../fs/fileio";
import { baseName, resolveWorkspacePath } from "../paths";
import type { ToolContext } from "../agent/registry";
import type { ToolResult } from "../agent/tools";
import { subAgentModel } from "../agent/subagent";
import { parseFrontmatter } from "../fs/markdown";
import { splitDocument } from "./chunk";
import { isTranslateLoreEnabled } from "./flag";
import { isDictEntity, parseDictBody, type GlossaryEntry } from "./glossary";
import { runChunk, runDocument, type DocProgress } from "./run";

let proposalCounter = 0;

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

/**
 * 读「翻译词典」条目的正文，解析成词条。
 *
 * 别名通道一个条目只能表达一个译名；名叫「翻译词典」的条目（任何分类下）用
 * 正文整批装 `原文->译文 #备注`。正文不在 LoreIndex 里（懒加载），所以一次
 * 运行开始时读一遍——词表属于整份文档，逐块命中筛选仍在 `collectGlossary`。
 */
async function loadTranslateDict(ctx: ToolContext): Promise<GlossaryEntry[]> {
  if (!isTranslateLoreEnabled() || !ctx.loreIndex) return [];
  const out: GlossaryEntry[] = [];
  for (const list of Object.values(ctx.loreIndex)) {
    for (const e of list) {
      if (!isDictEntity(e)) continue;
      try {
        const raw = await readFile(`${e.dirPath}/index.md`);
        out.push(...parseDictBody(parseFrontmatter(raw).content));
      } catch {
        // 条目可能正被删或还没有 index.md——词典缺席只是少一批词条，不是错误。
      }
    }
  }
  return out;
}

export interface TranslateArgs {
  text?: string;
  path?: string;
  reason?: string;
}

/** 译文文件的名字：同目录、同主名、`.zh.md`。 */
function translatedPath(source: string): string {
  const name = baseName(source);
  const dir = source.slice(0, source.length - name.length);
  const stem = name.replace(/\.[^./\\]+$/, "") || name;
  return `${dir}${stem}.zh.md`;
}

/**
 * 一行进度，写进执行日志。
 *
 * 复用同一个 `toolCallId` 让 `appendAgentEventTo` **就地替换**这一行（它按
 * kind + parentStep + toolCallId + name 找），于是日志里是一行数字在走，而不是
 * 三十行「块 N 完成」。挂在 `parentStep` 下面，所以运行时自己那一行不受影响。
 */
function progressReporter(ctx: ToolContext, callId: string, name: string) {
  return (p: DocProgress) => {
    ctx.onNestedEvent?.({
      kind: "tool-step",
      parentStep: callId,
      step: {
        round: 0,
        toolCallId: `${callId}-progress`,
        name: "translate",
        argumentSummary: name,
        status: p.done === p.total ? "done" : "running",
        resultSummary:
          `${p.done}/${p.total} 块` + (p.failed ? ` · ${p.failed} 块失败` : ""),
        argsTruncated: false,
        resultTruncated: false,
      },
      at: Date.now(),
    });
  };
}

/** 一次运行花了多少，记在作者能看到的账上。本地模型价格为 0，账依然记得住。 */
async function recordUsage(
  ctx: ToolContext,
  conn: AiConn,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  if (!ctx.projectPath) return;
  await persistUsage(
    ctx.projectPath,
    conn.model.id,
    usage.inputTokens,
    usage.outputTokens,
    costFor(conn.model, usage.inputTokens, usage.outputTokens),
    "subagent:translate",
  );
}

export async function translateTool(
  toolCallId: string,
  args: TranslateArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fail = (msg: string): ToolResult => ({ toolCallId, content: `Error: ${msg}` });

  const text = args.text?.trim();
  const path = args.path?.trim();
  if (!text && !path) {
    return fail("give either 'text' (a passage) or 'path' (a document in the project) — not neither.");
  }
  if (text && path) {
    return fail("give either 'text' or 'path', not both.");
  }

  const conn = await resolveTranslateConn();
  if ("error" in conn) return fail(conn.error);

  return path
    ? translateFile(toolCallId, path, args.reason, conn, ctx)
    : translatePassage(toolCallId, text!, conn, ctx);
}

/** 对话里的一段。一次请求，什么都不写。 */
async function translatePassage(
  toolCallId: string,
  text: string,
  conn: AiConn,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fail = (msg: string): ToolResult => ({ toolCallId, content: `Error: ${msg}` });

  const { allLines, chunks } = splitDocument(text);
  if (!chunks.length) {
    return fail(
      "nothing to translate — no Japanese was found in that text. This model only translates Japanese into Chinese.",
    );
  }
  if (chunks.length > 1) {
    return fail(
      `that passage is ${chunks.reduce((n, c) => n + c.lines.length, 0)} lines — too long for one request. ` +
        "Pass a shorter passage, or save it as a file in the project and call this tool with 'path'.",
    );
  }

  const outcome = await runChunk(chunks[0], {
    conn: connOptions(conn),
    loreIndex: isTranslateLoreEnabled() ? ctx.loreIndex : undefined,
    dict: await loadTranslateDict(ctx),
    signal: ctx.signal,
  });
  await recordUsage(ctx, conn, outcome.usage);

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

/** 项目里的一份文档。分块跑完，产物走审批卡片。 */
async function translateFile(
  toolCallId: string,
  rawPath: string,
  reason: string | undefined,
  conn: AiConn,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fail = (msg: string): ToolResult => ({ toolCallId, content: `Error: ${msg}` });

  if (!ctx.requestApproval) {
    return fail("this surface cannot review file changes — call this tool with 'text' here, not 'path'.");
  }
  // 与 create_file 同一条containment 规则：项目内、且不在 .ai-writer 里。
  const source = resolveWorkspacePath(ctx.projectPath, rawPath);
  if (!source) {
    return fail(`"${rawPath}" is outside the project's documents.`);
  }
  if (!(await fileExists(source))) {
    return fail(`no file at "${source}". Paths come from list_files (folder line + "/" + filename).`);
  }

  const dest = translatedPath(source);
  if (await fileExists(dest)) {
    return fail(
      `"${dest}" already exists — this tool never overwrites a translation. ` +
        "Rename or delete it first if you want a fresh one.",
    );
  }

  const original = await readFile(source);
  const outcome = await runDocument(original, {
    conn: connOptions(conn),
    loreIndex: isTranslateLoreEnabled() ? ctx.loreIndex : undefined,
    dict: await loadTranslateDict(ctx),
    signal: ctx.signal,
    onProgress: progressReporter(ctx, toolCallId, baseName(source)),
  });
  // 记在账上，无论成败：失败的那些请求也真的发出去了。
  await recordUsage(ctx, conn, outcome.usage);

  if (!outcome.chunkCount) {
    return fail(`no Japanese was found in "${baseName(source)}". This model only translates Japanese into Chinese.`);
  }
  // 一块都没成，写出去的会是一份加了标记的原文——那不是产物，是噪音。
  if (outcome.failed.length === outcome.chunkCount) {
    const f = outcome.failed[0];
    return fail(
      `every one of the ${outcome.chunkCount} chunks failed (${f.reason}${f.detail ? `: ${f.detail}` : ""}). ` +
        "Nothing was written. Tell the author — the endpoint or the binding is probably wrong.",
    );
  }

  const ok = outcome.chunkCount - outcome.failed.length;
  const summary =
    `${baseName(source)} → ${baseName(dest)}：${ok}/${outcome.chunkCount} 块译出` +
    (outcome.failed.length ? `，${outcome.failed.length} 块保留原文` : "") +
    (outcome.aborted ? "（作者已中断，其余保留原文）" : "");

  const decision = await ctx.requestApproval({
    kind: "create",
    id: `translate-${++proposalCounter}`,
    path: dest,
    content: outcome.text,
    reason: reason?.trim() || summary,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content:
        `The user REJECTED the translation${decision.reason ? ` — reason: ${decision.reason}` : "."} ` +
        "Nothing was written. Do not re-run the same translation; ask what they want changed.",
    };
  }

  return {
    toolCallId,
    content: [
      `Saved to ${dest}. ${summary}`,
      ...(outcome.failed.length
        ? [
            `${outcome.failed.length} chunk(s) could not be translated and are left as the ORIGINAL Japanese, ` +
              `each preceded by an HTML comment saying so. Do NOT translate those yourself — tell the author ` +
              `which lines they are (first lines: ${outcome.failed.map((f) => f.firstLine + 1).join(", ")}).`,
          ]
        : []),
      ...(outcome.aborted ? ["The run was INTERRUPTED, so this is not a finished translation."] : []),
    ].join("\n"),
  };
}
