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
import { isTranslateLoreEnabled, translateLinesPerChunk } from "./flag";
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
 * 读勾了「翻译词典」开关的条目正文，解析成词对。
 *
 * 别名通道一个条目只能表达一个译名；词典条目用正文整批装 `原文->译文 #备注`
 * （`=`/`→` 也认，见 parseDictBody）。正文不在 LoreIndex 里（懒加载），所以
 * 一次运行开始时读一遍——词表属于整份文档，逐块命中筛选仍在 `collectGlossary`。
 *
 * `warning`：词典条目**存在**却一条都没解析出来，几乎必然是格式没对上（比如
 * 每行写成了表格或散文）。这曾是静默的——作者以为词典在生效，其实一条都没
 * 送出去，且没有任何信号。现在把它说出来。
 */
async function loadTranslateDict(
  ctx: ToolContext,
): Promise<{ entries: GlossaryEntry[]; warning?: string }> {
  if (!isTranslateLoreEnabled() || !ctx.loreIndex) return { entries: [] };
  const entries: GlossaryEntry[] = [];
  let dictEntities = 0;
  for (const list of Object.values(ctx.loreIndex)) {
    for (const e of list) {
      if (!isDictEntity(e)) continue;
      dictEntities++;
      try {
        const raw = await readFile(`${e.dirPath}/index.md`);
        entries.push(...parseDictBody(parseFrontmatter(raw).content));
      } catch {
        // 条目可能正被删或还没有 index.md——词典缺席只是少一批词对，不是错误。
      }
    }
  }
  const warning =
    dictEntities > 0 && entries.length === 0
      ? `WARNING: ${dictEntities} dictionary entr${dictEntities > 1 ? "ies are" : "y is"} marked 翻译词典 but ZERO term pairs parsed from their bodies. ` +
        "Each line must be `原文->译文` (`=` and `→` also accepted, optional ` #note`). " +
        "Tell the author their dictionary is currently having no effect."
      : undefined;
  return { entries, warning };
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
 * 「约剩 …」。
 *
 * 两块之后才给：第一块的耗时里含着本地模型的加载和显存预热，拿它外推六十块会
 * 报出一个荒唐的数——而作者只会记住报出来的第一个数。译完最后一块也不给，那一刻
 * 剩下的是审批卡，不是翻译。
 */
function remainingLabel(startedAt: number, p: DocProgress): string | null {
  if (p.done < 2 || p.done >= p.total) return null;
  const seconds = Math.round((((Date.now() - startedAt) / p.done) * (p.total - p.done)) / 1000);
  if (seconds < 60) return `约剩 ${Math.max(1, seconds)} 秒`;
  return `约剩 ${Math.round(seconds / 60)} 分`;
}

/**
 * 一行进度，交给执行日志就地更新那一行工具调用。
 *
 * 这条链上唯一没有别的信号的地方：一份三万字的稿子要在这个工具里待四五分钟，
 * 而工具循环期间日志上只有一行不动的「日中翻译 · foo.md」——它和一个卡死的端点
 * 长得一模一样，而那两件事作者的反应完全不同。
 *
 * 三个分母都给：块是我们的切法，行和字才是作者对稿子的度量。名字不进 label——
 * 行和标题行已经写着是哪个工具、哪份文件了。
 */
function progressReporter(ctx: ToolContext) {
  const startedAt = Date.now();
  return (p: DocProgress) => {
    const parts = [
      `${p.done}/${p.total} 块`,
      `${p.lines.toLocaleString()}/${p.totalLines.toLocaleString()} 行`,
      `${p.chars.toLocaleString()}/${p.totalChars.toLocaleString()} 字`,
    ];
    const eta = remainingLabel(startedAt, p);
    if (eta) parts.push(eta);
    if (p.failed) parts.push(`${p.failed} 块失败`);
    ctx.onProgress?.({
      label: parts.join(" · "),
      ratio: p.total ? p.done / p.total : undefined,
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

  const { allLines, chunks } = splitDocument(text, { linesPerChunk: translateLinesPerChunk() });
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

  const dict = await loadTranslateDict(ctx);
  const outcome = await runChunk(chunks[0], {
    conn: connOptions(conn),
    loreIndex: isTranslateLoreEnabled() ? ctx.loreIndex : undefined,
    dict: dict.entries,
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
  // 词典报警放译文后面、明确括开：这段 content 的主体是译文本身，警告只能
  // 作为附注出现，避免模型把它当译文的一部分抄进文档。
  return {
    toolCallId,
    content: out.join("\n") + (dict.warning ? `\n\n[${dict.warning}]` : ""),
  };
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
  const dict = await loadTranslateDict(ctx);
  const outcome = await runDocument(original, {
    conn: connOptions(conn),
    loreIndex: isTranslateLoreEnabled() ? ctx.loreIndex : undefined,
    dict: dict.entries,
    signal: ctx.signal,
    linesPerChunk: translateLinesPerChunk(),
    onProgress: progressReporter(ctx),
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
        `The author REJECTED the translation${decision.reason ? ` — reason: ${decision.reason}` : "."} ` +
        "Nothing was written. Do not re-run the same translation; ask what they want changed.",
    };
  }

  return {
    toolCallId,
    content: [
      `Saved to ${dest}. ${summary}`,
      ...(dict.warning ? [dict.warning] : []),
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
