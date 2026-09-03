/**
 * `read_document` — the agent's reader for Word / Excel / PDF files.
 *
 * `read_file` cannot open these (a .docx or .xlsx is a zip, a PDF is binary),
 * and until this tool the only agent-side way to their text was the author
 * converting each one by hand from the file tree. This runs the same
 * converters the import dialog does (`lib/import`'s `convertToMarkdown`) and
 * pages the result exactly like `read_file`; the markdown lands in a cache
 * under `.ai-writer/tmp/` rather than beside the source, so nothing appears in
 * the project (docs/feature/agent/document-read-plan.md D2).
 *
 * A separate tool rather than a branch of `read_file`, for the reasons
 * `read_slides` is (pptx-plan D5): the three readers refuse each other's
 * files by name in the same round instead of one tool guessing from the
 * extension (D1, D6). `.pptx` stays with `read_slides` — its coordinate is the
 * slide and it is parsed a slide at a time; a converted document's is the line.
 */

import { convertExtOf, type ConvertExt } from "../import";
import { convertCached } from "../import/cachedConvert";
import { looksScanned } from "../import/cache";
import { isPptxPath } from "../fs/pptx";
import { baseName, resolveWorkspacePath } from "../paths";
import { headingIndex, pageLines, paragraphIndex, type ToolResult } from "./tools";

/** Legacy binary formats no converter here reads; refused with the fix named. */
const LEGACY: Record<string, string> = {
  doc: "Word 97-2003",
  xls: "Excel 97-2003",
  ppt: "PowerPoint 97-2003",
};

/** What the converters make of each format — for the "not a text file" redirects. */
export const DOCUMENT_KIND: Record<ConvertExt, string> = {
  docx: "Word document",
  xlsx: "Excel workbook",
  pdf: "PDF document",
  pptx: "PowerPoint presentation",
};

function extOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Read a .docx / .xlsx / .pdf in the workspace as paged markdown. Containment
 * is `read_file`'s — the project minus `.ai-writer/` — because this is a
 * text-returning tool and the exfiltration argument that keeps `read_file`
 * out of the app's own data applies unchanged.
 */
export async function readDocumentFile(
  toolCallId: string,
  rawPath: string,
  projectPath: string,
  startLine?: number,
): Promise<ToolResult> {
  const path = resolveWorkspacePath(projectPath, rawPath);
  if (!path) {
    return { toolCallId, content: "Error: Path is outside the project (the app's .ai-writer data is off-limits)." };
  }

  // Every redirect is one round: the model lands on the right tool next call.
  if (isPptxPath(path)) {
    return { toolCallId, content: `Error: "${path}" is a presentation. Use read_slides to read it.` };
  }
  const ext = convertExtOf(path);
  if (!ext) {
    const legacy = LEGACY[extOf(path)];
    if (legacy) {
      return {
        toolCallId,
        content: `Error: "${path}" is a legacy ${legacy} file; it cannot be converted. Ask the author to save it as .${extOf(path)}x first.`,
      };
    }
    return {
      toolCallId,
      content: `Error: "${path}" is not a Word, Excel or PDF document. Use read_file for text files and read_image for pictures.`,
    };
  }

  let doc;
  try {
    doc = await convertCached(projectPath, path, ext);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = ext === "pdf" ? " For a PDF this large, delegate it to the pdf subagent instead." : "";
    return { toolCallId, content: `Error converting "${path}": ${msg}.${hint}` };
  }

  const page = pageLines(doc.markdown, startLine ?? 1);
  if ("error" in page) return { toolCallId, content: `Error: ${page.error}` };

  const notes = [...page.notes];
  // Same gutter rule as read_file: the numbers are coordinates, not content.
  notes.splice(1, 0, "the number before each tab is the line number, not document content — never copy it into a file");
  notes.push(`converted from ${baseName(path)} (the original is untouched; nothing was written to the project)`);
  if (doc.pictures > 0) {
    notes.push(
      `${doc.pictures} picture${doc.pictures === 1 ? "" : "s"} extracted under ${doc.dir}/assets — view one with read_image only if the task depends on it`,
    );
  }

  // A scan comes out as page markers and page images and nothing else. Said in
  // the result, where it applies, rather than as a rule in the description (D5).
  const scanned = ext === "pdf" && looksScanned(doc.markdown);
  const preface = scanned
    ? "Note: this PDF has no text layer — it is most likely a scan, so nothing could be extracted as text. " +
      (doc.pictures > 0
        ? "Its pages were extracted as pictures (paths below), which a multimodal model can view with read_image; "
        : "") +
      "or delegate it to the pdf subagent, if one is configured.\n\n"
    : "";

  const index = page.whole ? "" : headingIndex(doc.markdown) || paragraphIndex(doc.markdown);
  return {
    toolCallId,
    content: `${preface}${index ? `${index}\n\n` : ""}${page.body}\n\n[... ${notes.join("; ")} ...]`,
  };
}
