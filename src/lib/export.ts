/**
 * Export helpers for V1:
 *   - Markdown: copy raw source to clipboard
 *   - HTML: self-contained HTML file (inline CSS, no external assets)
 *   - PDF: open system print dialog via window.print() on a hidden iframe
 */

import { renderMarkdown } from "./markdown";
import { writeFile } from "./fileio";
import i18n from "../i18n";

/** BCP-47 lang attribute for exported documents, following the active UI language. */
function docLang(): string {
  return i18n.language?.startsWith("zh") ? "zh" : "en";
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

export async function exportMarkdown(source: string): Promise<void> {
  await navigator.clipboard.writeText(source);
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

const HTML_CSS = `
  body {
    font-family: -apple-system, "Segoe UI", sans-serif;
    font-size: 16px;
    line-height: 1.8;
    color: #1f2937;
    background: #faf9f6;
    max-width: 800px;
    margin: 40px auto;
    padding: 0 24px 80px;
  }
  h1,h2,h3,h4,h5,h6 { line-height: 1.3; margin-top: 1.6em; }
  h1 { font-size: 2em; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.2em; }
  p { margin: 0.8em 0; }
  blockquote { border-left: 4px solid #3b82f6; margin: 0; padding: 0.5em 1em; background: #eff6ff; border-radius: 4px; }
  code { background: #f3f4f6; border-radius: 4px; padding: 2px 5px; font-family: "SF Mono", Consolas, monospace; font-size: 0.9em; }
  pre { background: #1e1e2e; color: #cdd6f4; border-radius: 8px; padding: 1em 1.2em; overflow-x: auto; }
  pre code { background: none; padding: 0; font-size: 0.875em; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
  th { background: #f9fafb; font-weight: 600; }
  img { max-width: 100%; height: auto; border-radius: 4px; }
  a { color: #3b82f6; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
`.trim();

export async function exportHtml(source: string, title: string, savePath: string): Promise<void> {
  const body = renderMarkdown(source);
  const html = `<!DOCTYPE html>
<html lang="${docLang()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${HTML_CSS}</style>
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
  @media print { body { margin: 0; } }
  ${HTML_CSS}
  body { background: #fff; }
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
