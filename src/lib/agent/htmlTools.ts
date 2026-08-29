/**
 * `inspect_html` — lay a project page out and report what the browser made of
 * it.
 *
 * The one tool in the writing loop that is a **verifier**: everything else
 * tells the model what it wrote, this tells it what that turned into. The
 * model authors HTML it cannot see, and before this the only channel for "the
 * heading spills off slide 3" was the author noticing it in the preview and
 * describing it in prose — a human turn per defect. A coding agent's accuracy
 * does not come from a better model, it comes from having a cheap
 * deterministic checker it can run itself; for pages, this is that checker.
 *
 * Read-only and side-effect free, so no approval card: it renders offscreen in
 * the same sandboxed frame the exporter uses (`lib/pptx/harvest`) — no
 * `allow-same-origin`, the page's own scripts still blocked by the app's CSP —
 * and writes nothing anywhere.
 *
 * Ungated, unlike `export_pptx`. Measuring a page is not exporting one: the
 * HTML deliverable itself is a shipped feature with a task of its own
 * (`htmlArtifact`), and the author who never turns the PowerPoint Beta on is
 * exactly the author whose diagrams nobody is checking.
 */

import { fileExists, readFile } from "../fs/fileio";
import { dirName, resolveWorkspacePath } from "../paths";
import { harvestDeck } from "../pptx/harvest";
import { formatDeckReport, inspectDeck } from "../pptx/inspect";
import { splitHtmlDeck } from "../pptx/htmlSlides";
import type { ToolContext } from "./registry";
import type { ToolResult } from "./tools";

export async function inspectHtmlTool(
  toolCallId: string,
  args: { path?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const raw = args.path?.trim();
  if (!raw) {
    return { toolCallId, content: "Error: 'path' is required — the .html page to measure." };
  }
  const path = resolveWorkspacePath(ctx.projectPath, raw);
  if (!path) {
    return {
      toolCallId,
      content: "Error: Path is outside the project (the app's .ai-writer data is off-limits).",
    };
  }
  if (!/\.html?$/i.test(path)) {
    return {
      toolCallId,
      content: `Error: "${path}" is not an .html file. This measures rendered pages; use read_file for text.`,
    };
  }
  if (!(await fileExists(path))) {
    return {
      toolCallId,
      content: `Error: there is no file at ${path}. Check the path with list_files, or write the page first.`,
    };
  }

  let html: string;
  try {
    html = await readFile(path);
  } catch (e) {
    return { toolCallId, content: `Error reading file: ${String(e)}` };
  }

  try {
    // The split is text-level and the measurement is layout-level; both are
    // reported because they answer different questions — "how did it divide"
    // and "did anything fall off". They agree by construction: harvester.js
    // and htmlSlides.ts share the selector list, held by a test.
    const { tier } = splitHtmlDeck(html);
    const deck = await harvestDeck(html, dirName(path) || null);
    return { toolCallId, content: formatDeckReport(inspectDeck(deck), path, tier) };
  } catch (e) {
    // A page that cannot be laid out is a finding, not a tool failure — say so
    // in words the model can act on rather than as an internal error.
    return {
      toolCallId,
      content:
        `Could not measure ${path}: ${e instanceof Error ? e.message : String(e)}. ` +
        "A page that never finishes rendering usually has a script that throws or a resource it waits on; " +
        "the conversion to .pptx would fail the same way.",
    };
  }
}
