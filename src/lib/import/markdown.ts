/**
 * HTML → Markdown for imported documents.
 *
 * The docx path produces HTML (mammoth's output format) and lands here; kept
 * as its own module so the conversion rules are testable without a Word file
 * or a dialog. Turndown carries its own DOM (domino) in Node, so the tests
 * run in the plain vitest environment.
 */

import TurndownService from "turndown";
// The joplin fork of the gfm plugin — actively maintained, and its table rule
// keeps cell content the original plugin drops (nested markup inside cells).
import { gfm } from "@joplin/turndown-plugin-gfm";

let service: TurndownService | null = null;

function turndown(): TurndownService {
  if (service) return service;
  service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  service.use(gfm);
  // Word documents arrive with images inlined as base64 data URLs. A data URL
  // in the middle of a line is dead weight for the editor, the RAG context and
  // the diff view alike — the imported markdown is source *text*, so images
  // are dropped rather than materialised as files.
  service.addRule("dropImages", {
    filter: "img",
    replacement: () => "",
  });
  return service;
}

/** Collapse runs of 3+ newlines (image removals leave holes) and trim. */
export function tidyMarkdown(md: string): string {
  return md.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlToMarkdown(html: string): string {
  return tidyMarkdown(turndown().turndown(html));
}
