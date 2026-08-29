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
  // Images whose src is a data URL — or nothing at all — are dropped. The
  // docx path materialises pictures as files and links them relatively
  // (`docx.ts`), so a data URL reaching this pass means something upstream
  // didn't, and inlining megabytes of base64 into the editor, the RAG context
  // and the diff view is never the right fallback. An empty src is the docx
  // collector's "unsupported format" signal (EMF/WMF and friends).
  service.addRule("dropDataUrlImages", {
    filter: (node) => {
      if (node.nodeName !== "IMG") return false;
      const src = node.getAttribute("src") ?? "";
      return src === "" || src.startsWith("data:");
    },
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
