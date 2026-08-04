/**
 * .docx → Markdown, via mammoth (docx → semantic HTML) and the shared
 * HTML → Markdown pass. Mammoth is ~700 kB and only needed the moment an
 * author actually imports a Word file, so it loads lazily.
 *
 * Legacy binary .doc is deliberately unsupported — mammoth can't read it, and
 * a half-garbled import is worse than asking the author to save as .docx.
 */

import { htmlToMarkdown } from "./markdown";

export async function docxToMarkdown(data: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  // Hand mammoth its own copy: `data` may be a view over a larger buffer, and
  // the arrayBuffer is consumed by the unzip step.
  const arrayBuffer = data.slice().buffer as ArrayBuffer;
  const result = await mammoth.convertToHtml({ arrayBuffer });
  return htmlToMarkdown(result.value);
}
