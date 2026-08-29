/**
 * `export_xlsx` —— 把项目里一份 markdown 文档的表格转成 Excel 工作簿。
 *
 * 分工同 `export_docx`：模型写的是 markdown 表格——它每天都在写的东西，作者在
 * 预览里读得到、改得动——转换本身不跑任何模型（见 lib/xlsx）。
 *
 * 和那两个导出工具的一处差别，并且是有意的：工作簿**在这里就建好**，连同每个
 * 格子的类型判定一起存进 proposal。pptx 非要等批准后才能转（它得先有 DOM 才能
 * 量版面），而这条链上没有任何东西非等不可，于是「作者批的」和「写下去的」可以
 * 严格是同一本——中间源文件被改一笔也不影响。卡片上要核对的正是这些判定。
 */

import { fileExists } from "../fs/fileio";
import { resolveWorkspacePath } from "../paths";
import { planWorkbookFromFile, xlsxPathFor } from "../xlsx";
import type { ToolContext, XlsxProposal } from "./registry";
import type { ToolResult } from "./tools";

let proposalCounter = 0;

export async function exportXlsxTool(
  toolCallId: string,
  args: { source_path?: string; out_path?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.requestApproval) {
    return {
      toolCallId,
      content: "Error: this surface cannot review an Excel export — do not call this tool here.",
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
      content: `Error: "${source}" is not a markdown document. Write the tables with create_file first, then export them.`,
    };
  }
  if (!(await fileExists(source))) {
    return {
      toolCallId,
      content: `Error: there is no file at ${source}. Check the path with list_files, or write the document first.`,
    };
  }

  const target = resolveWorkspacePath(ctx.projectPath, args.out_path?.trim() || xlsxPathFor(source));
  if (!target) {
    return { toolCallId, content: "Error: the destination is outside the project." };
  }
  if (!/\.xlsx$/i.test(target)) {
    return { toolCallId, content: `Error: "${target}" does not end in .xlsx.` };
  }

  const plan = await planWorkbookFromFile(source);
  if (plan.sheets.length === 0) {
    // 没有表格就没有工作簿。这条要在提案之前答，否则作者会看见一张卡片，批准它，
    // 然后得到一个空文件——而真正的问题是文档里根本没有表格。
    return {
      toolCallId,
      content: `Error: ${source} has no markdown tables, so there is nothing to put in a workbook. Write the data as a markdown table (a header row and a --- separator row) first.`,
    };
  }

  const proposal: XlsxProposal = {
    kind: "xlsx",
    id: `xlsx-${++proposalCounter}`,
    path: target,
    sourcePath: source,
    sheets: plan.sheets,
    summaries: plan.summaries,
    skipped: plan.skipped,
    reason: args.reason,
  };

  const decision = await ctx.requestApproval(proposal);
  if (!decision.approved) {
    return {
      toolCallId,
      content: `The user REJECTED this export${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not retry it; adjust the tables per the reason, or move on.`,
    };
  }
  // 结果从 backupPath 这条共享的 apply 通道回来——见 agentStore 的 xlsx 分支。
  return { toolCallId, content: decision.backupPath ?? `Exported to ${target}.` };
}
