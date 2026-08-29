/**
 * `export_docx` —— 把项目里的一份 markdown 文档转成 Word 文件。
 *
 * 分工和 `export_pptx` 同一条，但更彻底：模型写的是 markdown——这个 app 的原生
 * 文档格式，它每天都在写的东西——而**版面完全不由模型表达**，全部来自作者的
 * 排版预设。转换本身不跑任何模型（见 lib/docx）。
 *
 * 所以这个工具只做两件事：查路径、把一张**已经解析好的**规格表摆到作者面前。
 * 格式在这里就解析完并存进 proposal，而不是等批准后再解析——中间作者可能改了
 * 默认预设，那样批准的和执行的就是两套格式了。
 *
 * 真正的转换在 `applyProposal` 里做（同 pptx）：那里才该懒加载 1MB 的库并写
 * 二进制，工具循环里不该。
 */

import { fileExists, readFile } from "../fs/fileio";
import { baseName, resolveWorkspacePath } from "../paths";
import { docxPathFor, outlineMarkdown } from "../docx";
import { eastAsiaFontsOf, formatSpecRows, formatSummary } from "../docx/format";
import { missingFonts } from "../docx/fontCheck";
import { readDocFormat } from "../docx/read";
import { describeOrigin, FormatResolveError, resolveFormat, type DocFormatOverrides } from "../docx/resolve";
import { currentFormats, imitatedIdFor, useDocFormatStore } from "../../stores/docFormatStore";
import type { DocxProposal, ToolContext } from "./registry";
import type { ToolResult } from "./tools";

let proposalCounter = 0;

export async function exportDocxTool(
  toolCallId: string,
  args: {
    source_path?: string;
    out_path?: string;
    format_id?: string;
    overrides?: DocFormatOverrides;
    reason?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.requestApproval) {
    return {
      toolCallId,
      content: "Error: this surface cannot review a Word export — do not call this tool here.",
    };
  }

  const rawSource = args.source_path?.trim();
  if (!rawSource) {
    return { toolCallId, content: "Error: 'source_path' is required — the .md document to convert." };
  }
  const source = resolveWorkspacePath(ctx.projectPath, rawSource);
  if (!source) {
    return { toolCallId, content: "Error: Path is outside the project (the app's .ai-writer data is off-limits)." };
  }
  if (!/\.(md|markdown|txt)$/i.test(source)) {
    return {
      toolCallId,
      content: `Error: "${source}" is not a markdown document. Write the document with create_file first, then export it.`,
    };
  }
  if (!(await fileExists(source))) {
    return {
      toolCallId,
      content: `Error: there is no file at ${source}. Check the path with list_files, or write the document first.`,
    };
  }

  const target = resolveWorkspacePath(ctx.projectPath, args.out_path?.trim() || docxPathFor(source));
  if (!target) {
    return { toolCallId, content: "Error: the destination is outside the project." };
  }
  if (!/\.docx$/i.test(target)) {
    return { toolCallId, content: `Error: "${target}" does not end in .docx.` };
  }

  const { presets, defaultId } = currentFormats();
  let resolved;
  try {
    resolved = resolveFormat(presets, defaultId, {
      formatId: args.format_id,
      overrides: args.overrides,
    });
  } catch (e) {
    // 解析不下去时把原话回给模型——它多半能自己改对（拼错的预设 id、看不懂的
    // 行距写法）。绝不回落默认：那会静默导出一份合规性为零的文件。
    if (e instanceof FormatResolveError) return { toolCallId, content: `Error: ${e.message}` };
    throw e;
  }

  const { format, origin } = resolved;
  const source_text = await readFile(source);

  // 内容侧的预检，和 export_xlsx 「没有表格就早退」同一条：与其让作者批准一份
  // 空文件，不如现在就说清楚。frontmatter 不算正文，所以一份只有 frontmatter
  // 的文档在这里正是 0 块。
  const outline = outlineMarkdown(source_text);
  if (outline.blocks === 0) {
    return {
      toolCallId,
      content:
        `Error: "${source}" has no content to convert — nothing but frontmatter or whitespace. ` +
        "Write the document first, then export it.",
    };
  }

  const proposal: DocxProposal = {
    kind: "docx",
    id: `docx-${++proposalCounter}`,
    path: target,
    sourcePath: source,
    format,
    originKind: origin.kind,
    originLabel: describeOrigin(origin),
    originNote: originNote(origin, presets.length),
    changed: origin.kind === "overridden" ? origin.changed : undefined,
    spec: formatSpecRows(format),
    missingFonts: missingFonts(eastAsiaFontsOf(format)),
    sourceChars: source_text.length,
    outline,
    reason: args.reason,
  };

  const decision = await ctx.requestApproval(proposal);
  if (!decision.approved) {
    return {
      toolCallId,
      content: `The user REJECTED this export${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not retry it; adjust the document or the format per the reason, or move on.`,
    };
  }
  // 结果从 backupPath 这条共享的 apply 通道回来——见 agentStore 的 docx 分支，
  // 它把块数和降级项放在那里。
  return { toolCallId, content: decision.backupPath ?? `Exported to ${target}.` };
}

/** 格式来源右边那句安静的话。 */
function originNote(origin: ReturnType<typeof resolveFormat>["origin"], _total: number): string | undefined {
  switch (origin.kind) {
    case "default":
      return origin.presetLabel;
    case "preset":
      return undefined;
    case "imitated":
      return undefined;
    case "overridden":
      return origin.base.kind === "default" || origin.base.kind === "preset"
        ? origin.base.presetLabel
        : undefined;
  }
}


/**
 * `read_doc_format` —— 「这套格式到底是什么」和「照这份文件来」两件事的同一个
 * 入口。
 *
 * 返回的是**人话摘要**，不是 `DocFormat` 的 JSON：模型只需要能**指认**一套
 * 格式，不需要能写出一套（01-agent-design I2）。读文件时顺手把它挂成一个会话
 * 内的临时预设，把 id 一并给回去——模型下一步就能拿它调 `export_docx`。
 */
export async function readDocFormatTool(
  toolCallId: string,
  args: { target?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = args.target?.trim();
  if (!target) {
    return { toolCallId, content: "Error: 'target' is required — a format preset id, or the path of a .docx to copy." };
  }

  // 先当预设 id 认。作者说「用公文那套」时模型抄的就是清单里的 id，走这条路
  // 不碰盘。
  const { presets, defaultId } = currentFormats();
  const preset = presets.find((p) => p.id === target);
  if (preset) {
    return {
      toolCallId,
      content: [
        `Format "${preset.id}" (${preset.label})${preset.id === defaultId ? " — the author's default" : ""}:`,
        ...formatSummary(preset.format).map((line) => `- ${line}`),
        `Use it with export_docx format_id="${preset.id}".`,
      ].join("\n"),
    };
  }

  const path = resolveWorkspacePath(ctx.projectPath, target);
  if (!path) {
    return { toolCallId, content: "Error: that path is outside the project, and it is not a known format id." };
  }
  if (!/\.(docx|dotx)$/i.test(path)) {
    return {
      toolCallId,
      content: `Error: "${target}" is neither a format preset id nor a .docx/.dotx file. Only Word files carry the exact numbers a format needs — a PDF or a screenshot would be a guess.`,
    };
  }
  if (!(await fileExists(path))) {
    return { toolCallId, content: `Error: there is no file at ${path}.` };
  }

  let result;
  try {
    result = await readDocFormat(path);
  } catch (e) {
    return { toolCallId, content: `Error: could not read the layout of ${path} — ${e instanceof Error ? e.message : String(e)}` };
  }

  const file = baseName(path);
  const id = imitatedIdFor(path);
  useDocFormatStore.getState().addImitated({
    id,
    label: file,
    builtin: false,
    imitatedFrom: file,
    format: result.format,
  });

  return {
    toolCallId,
    content: [
      `Read the layout of ${file}:`,
      ...formatSummary(result.format).map((line) => `- ${line}`),
      // 「它写死了什么」和「它长什么样」是两件事：一份全用 Word 默认值的文件
      // 也会给出一份完整的规格，但那份规格不是它要求的，是我们填的。
      result.declaredCount > 0
        ? `Of those, ${result.declaredCount} are pinned down by the file itself: ${result.rows
            .filter((r) => r.source === "declared")
            .map((r) => `${r.label} ${r.value}`)
            .join("; ")}.`
        : "NOTE: that file pins down nothing — every value above is a Word default we filled in, not a requirement it states. Say so before the author treats it as a template.",
      ...result.notes.map((n) => `NOTE: ${n}`),
      `Use it with export_docx format_id="${id}". It lives for this session only until the author saves it as a preset.`,
    ].join("\n"),
  };
}
