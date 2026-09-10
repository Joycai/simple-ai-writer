/**
 * `convert_document` — land a Word / Excel / PDF / PowerPoint file in the
 * project as a markdown document beside it. The write half of what
 * `read_document` reads (docs/feature/agent/document-read-plan.md §10).
 *
 * L2: nothing is written until the author approves the card. The conversion
 * itself runs *now*, through the same cache `read_document` uses, so the card
 * can show what will land — how much text, how many pictures, and whether a
 * PDF turned out to be a scan with nothing to extract — and so that what was
 * approved and what lands are the same bytes (lib/import/materialize).
 */

import { convertExtOf } from "../import";
import { looksScanned } from "../import/cache";
import { convertCached } from "../import/cachedConvert";
import { conversionTargetFor } from "../import/materialize";
import { fileExists } from "../fs/fileio";
import { resolveWorkspacePath } from "../paths";
import type { ConvertProposal, ToolContext } from "./registry";
import type { ToolResult } from "./tools";

let proposalCounter = 0;

/** How much of the converted text the card shows. */
export const CONVERT_EXCERPT_CHARS = 600;

export async function convertDocumentTool(
  toolCallId: string,
  args: { path?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.requestApproval) {
    return {
      toolCallId,
      content: "Error: this surface cannot review a conversion — do not call this tool here.",
    };
  }
  const raw = args.path?.trim();
  if (!raw) {
    return { toolCallId, content: "Error: 'path' is required — the document to convert." };
  }
  const source = resolveWorkspacePath(ctx.projectPath, raw);
  if (!source) {
    return { toolCallId, content: "Error: Path is outside the project (the app's .ai-writer data is off-limits)." };
  }
  const ext = convertExtOf(source);
  if (!ext) {
    return {
      toolCallId,
      content: `Error: "${source}" is not a .docx / .xlsx / .pdf / .pptx file. Only those convert to markdown; a text file needs no conversion.`,
    };
  }
  if (!(await fileExists(source))) {
    return { toolCallId, content: `Error: there is no file at ${source}. Check the path with list_files.` };
  }

  let doc;
  try {
    doc = await convertCached(ctx.projectPath, source, ext);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { toolCallId, content: `Error converting "${source}": ${msg}.` };
  }

  const scanned = ext === "pdf" && looksScanned(doc.markdown);
  const proposal: ConvertProposal = {
    kind: "convert",
    id: `convert-${++proposalCounter}`,
    path: conversionTargetFor(source),
    sourcePath: source,
    ext,
    cacheDir: doc.dir,
    chars: doc.markdown.length,
    pictures: doc.pictures,
    scanned,
    excerpt: doc.markdown.slice(0, CONVERT_EXCERPT_CHARS),
    reason: args.reason,
  };

  const decision = await ctx.requestApproval(proposal);
  if (!decision.approved) {
    return {
      toolCallId,
      content: `The user REJECTED this conversion${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not retry it; read the file with read_document if you only need its content, or move on.`,
    };
  }
  return { toolCallId, content: decision.backupPath ?? `Converted to ${decision.resultPath ?? proposal.path}.` };
}
