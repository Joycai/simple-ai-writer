/**
 * Export helpers for V1:
 *   - Markdown: copy raw source to clipboard
 *   - HTML: self-contained HTML file (inline CSS, no external assets)
 *   - PDF: open system print dialog via window.print() on a hidden iframe
 *
 * Typography follows the markdown theme the author is reading in the app — the
 * same generator feeds the preview pane, so what they exported is what they
 * saw. The palette is re-declared here because the exported file has no
 * tokens.css around it.
 */

import { renderMarkdown } from "./markdown";
import { writeFile } from "./fileio";
import {
  EXPORT_TOKEN_CSS,
  currentMarkdownThemeId,
  markdownThemeCss,
} from "../theme/markdownThemes";
import i18n from "../../i18n";

/** BCP-47 lang attribute for exported documents, following the active UI language. */
function docLang(): string {
  return i18n.language?.startsWith("zh") ? "zh" : "en";
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

export async function exportMarkdown(source: string): Promise<void> {
  await navigator.clipboard.writeText(source);
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

/** Page frame + the active markdown theme, resolved against the light palette. */
function documentCss(): string {
  return `${EXPORT_TOKEN_CSS}
body {
  background: var(--color-bg-base);
  max-width: 760px;
  margin: 48px auto;
  padding: 0 24px 80px;
}
${markdownThemeCss(currentMarkdownThemeId(), "body")}`;
}

export async function exportHtml(source: string, title: string, savePath: string): Promise<void> {
  const body = renderMarkdown(source);
  const html = `<!DOCTYPE html>
<html lang="${docLang()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${documentCss()}</style>
</head>
<body>
${body}
</body>
</html>`;
  await writeFile(savePath, html);
}

// ─── PDF (system print) ───────────────────────────────────────────────────────

export function exportPdf(source: string, title: string): void {
  const body = renderMarkdown(source);
  const html = `<!DOCTYPE html>
<html lang="${docLang()}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${documentCss()}
/* Print sheet: white paper, no page margin of our own. */
body { background: #fff; }
@media print {
  body { margin: 0; max-width: none; }
  a { text-decoration: none; }
  pre, blockquote, table, img { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
}
</style>
</head>
<body>${body}</body>
</html>`;

  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;width:0;height:0;opacity:0;border:none;";
  document.body.appendChild(iframe);
  iframe.contentDocument!.open();
  iframe.contentDocument!.write(html);
  iframe.contentDocument!.close();
  iframe.contentWindow!.focus();
  setTimeout(() => {
    iframe.contentWindow!.print();
    setTimeout(() => document.body.removeChild(iframe), 2000);
  }, 300);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
