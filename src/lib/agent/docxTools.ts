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
import { resolveWorkspacePath } from "../paths";
import { docxPathFor } from "../docx";
import { eastAsiaFontsOf, formatSpecRows } from "../docx/format";
import { missingFonts } from "../docx/fontCheck";
import { describeOrigin, FormatResolveError, resolveFormat, type DocFormatOverrides } from "../docx/resolve";
import { currentFormats } from "../../stores/docFormatStore";
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
