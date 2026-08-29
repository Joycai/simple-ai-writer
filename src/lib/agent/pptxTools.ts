/**
 * `export_pptx` — turn a project `.html` page into a PowerPoint deck.
 *
 * The division of labour is the whole point: the model writes HTML, which is
 * the layout language it is actually good at and which this app already
 * previews, reviews and lets the author edit. The conversion itself runs no
 * model at all — it renders the page and reads the browser's own layout (see
 * lib/pptx). So the tool's job here is only to check the paths and put a card
 * in front of the author; the work happens on approval, in `applyProposal`,
 * because that is where a renderer (and therefore a DOM to lay the page out
 * in) exists.
 *
 * Gated by the Beta switch — `routeTools` strips this tool entirely when the
 * author has not turned it on, so the model never proposes a feature that is
 * off (lib/agent/routing.ts).
 */

import { fileExists, readFile } from "../fs/fileio";
import { resolveWorkspacePath } from "../paths";
import { pptxPathFor } from "../pptx";
import { WHOLE_PAGE_TIER, splitHtmlDeck } from "../pptx/htmlSlides";
import type { PptxProposal, ToolContext } from "./registry";
import type { ToolResult } from "./tools";

let proposalCounter = 0;

export async function exportPptxTool(
  toolCallId: string,
  args: { html_path?: string; out_path?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.requestApproval) {
    return {
      toolCallId,
      content: "Error: this surface cannot review a PPTX export — do not call this tool here.",
    };
  }

  const rawSource = args.html_path?.trim();
  if (!rawSource) {
    return { toolCallId, content: "Error: 'html_path' is required — the .html page to convert." };
  }
  const source = resolveWorkspacePath(ctx.projectPath, rawSource);
  if (!source) {
    return { toolCallId, content: "Error: Path is outside the project (the app's .ai-writer data is off-limits)." };
  }
  if (!/\.html?$/i.test(source)) {
    return {
      toolCallId,
      content: `Error: "${source}" is not an .html file. Write the deck as HTML with create_file first, then export it.`,
    };
  }
  if (!(await fileExists(source))) {
    return {
      toolCallId,
      content: `Error: there is no file at ${source}. Check the path with list_files, or write the page first.`,
    };
  }

  const target = resolveWorkspacePath(ctx.projectPath, args.out_path?.trim() || pptxPathFor(source));
  if (!target) {
    return { toolCallId, content: "Error: the destination is outside the project." };
  }
  if (!/\.pptx$/i.test(target)) {
    return { toolCallId, content: `Error: "${target}" does not end in .pptx.` };
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
