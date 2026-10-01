/** Native exports prepare an immutable artifact before approval; legacy HTML stays compatible. */
import { fileExists, readFile } from "../fs/fileio";
import { resolveWorkspacePath } from "../paths";
import { pptxPathFor } from "../pptx";
import { WHOLE_PAGE_TIER, splitHtmlDeck } from "../pptx/htmlSlides";
import { lintDeckSource } from "../pptx/lint";
import type { PptxProposal, ToolContext } from "./registry";
import type { ToolResult } from "./tools";

let proposalCounter = 0;

export async function exportPptxTool(
  toolCallId: string,
  args: { source_path?: string; html_path?: string; out_path?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.requestApproval) {
    return {
      toolCallId,
      content: "Error: this surface cannot review a PPTX export — do not call this tool here.",
    };
  }

  if (args.source_path?.trim() && args.html_path?.trim() &&
      resolveWorkspacePath(ctx.projectPath, args.source_path.trim()) !== resolveWorkspacePath(ctx.projectPath, args.html_path.trim())) {
    return { toolCallId, content: "Error: source_path and html_path disagree. Supply one source." };
  }
  const rawSource = args.source_path?.trim() || args.html_path?.trim();
  if (!rawSource) {
    return { toolCallId, content: "Error: 'source_path' is required — a .slides.json or .html file (html_path is a legacy alias)." };
  }
  const source = resolveWorkspacePath(ctx.projectPath, rawSource);
  if (!source) {
    return { toolCallId, content: "Error: Path is outside the project (the app's .ai-writer data is off-limits)." };
  }
  const native = /\.slides\.json$/i.test(source);
  if (!native && !/\.html?$/i.test(source)) {
    return {
      toolCallId,
      content: `Error: "${source}" is not an .html file or .slides.json deck. Read the PPTX workflow and create the source first.`,
    };
  }
  if (!(await fileExists(source))) {
    return {
      toolCallId,
      content: `Error: there is no file at ${source}. Check the path with list_files, or write the page first.`,
    };
  }

  const target = resolveWorkspacePath(ctx.projectPath, args.out_path?.trim() || (native ? source.replace(/\.slides\.json$/i, ".pptx") : pptxPathFor(source)));
  if (!target) {
    return { toolCallId, content: "Error: the destination is outside the project." };
  }
  if (!/\.pptx$/i.test(target)) {
    return { toolCallId, content: `Error: "${target}" does not end in .pptx.` };
  }

  if (native) {
    const { prepareNativePptx, formatNativeDiagnostics, releaseNativePptx } = await import("../pptx/native/approval");
    let artifactId: string | undefined;
    try {
      const prepared = await prepareNativePptx(ctx.projectPath, source, target);
      if (!prepared.ok) return { toolCallId, content: `Error: native PPTX preflight failed. Fix these fields and export again:\n${formatNativeDiagnostics(prepared.diagnostics)}` };
      artifactId = prepared.receipt.artifactId;
      const decision = await ctx.requestApproval({
        kind: "pptx", format: "native", id: `pptx-${artifactId}`, path: target,
        sourcePath: source, slides: prepared.receipt.slides, native: prepared.receipt, reason: args.reason,
      });
      // The shared approval channel reports apply errors as rejected decisions.
      // Keep those distinct from the author's refusal so stale-input recovery can proceed.
      if (!decision.approved && decision.reason?.startsWith("apply failed:"))
        return { toolCallId, content: `Error: ${decision.reason}. Prepare a fresh export for review if still requested.` };
      return { toolCallId, content: decision.approved
        ? decision.backupPath ?? `Exported to ${target}.`
        : `The user REJECTED this export${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not retry without addressing their feedback.` };
    } catch (error) {
      return { toolCallId, content: `Error: ${String(error)}` };
    } finally {
      if (artifactId) releaseNativePptx(artifactId);
    }
  }

  // The division is text-level, so it costs one read and is knowable before
  // anything is rendered — see PptxProposal. Everything else about the
  // conversion still needs a DOM and still waits for approval.
  let html: string;
  try {
    html = await readFile(source);
  } catch (e) {
    return { toolCallId, content: `Error reading ${source}: ${String(e)}` };
  }
  const { tier, slides } = splitHtmlDeck(html);
  const wholePage = tier === WHOLE_PAGE_TIER;

  const proposal: PptxProposal = {
    kind: "pptx",
    id: `pptx-${++proposalCounter}`,
    path: target,
    sourcePath: source,
    slides: slides.length,
    tier,
    wholePage,
    // Same read, same reason: what the page *says* it does is knowable now,
    // and the author approving a deck with a ::before bullet on every slide
    // should be approving it knowing the bullets will not be there.
    lint: lintDeckSource(html),
    reason: args.reason,
  };

  const decision = await ctx.requestApproval(proposal);
  if (!decision.approved) {
    return {
      toolCallId,
      content: `The user REJECTED this export${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not retry it; adjust the page per the reason, or move on.`,
    };
  }
  // The applied outcome rides back on backupPath, the shared apply channel —
  // see agentStore's pptx case, which puts the slide count and any
  // degradations there.
  return { toolCallId, content: decision.backupPath ?? `Exported to ${target}.` };
}
