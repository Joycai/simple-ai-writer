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
import { saveTextFileDialog } from "./transfer";
import { imageToDataUrl } from "./images";
import { resolveRelativePath } from "../paths";
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

/**
 * Replace relative `<img src>` with inline data URLs.
 *
 * An exported file has no relation to the project folder: the HTML lands
 * wherever the author saved it, and the PDF is printed from an in-memory
 * iframe with no base URL at all. A relative `assets/…` link therefore
 * resolves against nothing and the picture is simply missing — the document
 * looks fine on screen and arrives at its reader with holes in it.
 *
 * `baseDir` is the exported document's own folder, since that is what the
 * links in it are relative to. Absent (or unreadable images) leaves the tags
 * untouched rather than failing the export.
 */
async function inlineImages(html: string, baseDir?: string): Promise<string> {
  if (!baseDir) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const imgs = [...doc.querySelectorAll("img")]
    .filter((img) => needsInlining(img.getAttribute("src")));
  await Promise.all(imgs.map(async (img) => {
    try {
      const { dataUrl } = await imageToDataUrl(assetPathFor(baseDir, img.getAttribute("src")!));
      img.setAttribute("src", dataUrl);
    } catch {
      // A missing file shouldn't sink the whole export; it exports as a
      // broken image, exactly as it renders in the app.
    }
  }));
  return doc.body.innerHTML;
}

/**
 * Whether an `<img src>` points at a local file this export has to embed.
 *
 * Everything already self-contained or remote is left alone: a `data:` URL is
 * embedded by definition, and rewriting an `http(s):` image would turn a link
 * that works anywhere into bytes in the file.
 */
export function needsInlining(src: string | null): boolean {
  return !!src && !/^(https?:|data:|blob:|ai-writer-asset:)/i.test(src);
}

/** Resolve one relative `src` against the document's folder. */
export function assetPathFor(baseDir: string, src: string): string {
  let rel = src;
  // Markdown links are percent-encoded (see lib/image/assets.ts); the
  // filesystem wants the real characters back.
  try { rel = decodeURI(src); } catch { /* keep raw on a malformed escape */ }
  return resolveRelativePath(baseDir, rel);
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

/**
 * Export to a self-contained HTML file through the native save dialog.
 * Returns the saved path, or null when the author cancelled.
 *
 * The dialog both picks the path and writes the file (see fs/transfer), so
 * this builds the document and hands it over rather than taking a path.
 */
export async function exportHtml(
  source: string,
  title: string,
  /** Folder the document's relative image links resolve against. */
  baseDir?: string,
): Promise<string | null> {
  const body = await inlineImages(renderMarkdown(source), baseDir);
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
  return saveTextFileDialog(html, `${title || "document"}.html`, "HTML", ["html"]);
}

// ─── PDF (system print) ───────────────────────────────────────────────────────

export async function exportPdf(source: string, title: string, baseDir?: string): Promise<void> {
  const body = await inlineImages(renderMarkdown(source), baseDir);
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
