/**
 * Export helpers for V1:
 *   - Markdown: copy raw source to clipboard
 *   - HTML: self-contained HTML file (inline CSS, no external assets)
 *   - PDF: open the system print dialog (macOS goes through Rust — see
 *     `exportPdf` and src-tauri/src/print.rs; elsewhere a hidden iframe)
 *
 * Typography follows the markdown theme the author is reading in the app — the
 * same generator feeds the preview pane, so what they exported is what they
 * saw. The palette is generated into the file because it has no tokens.css
 * around it: the author's light and dark appearance themes, the second under
 * `prefers-color-scheme: dark` (lib/theme/export).
 */

import { invoke } from "@tauri-apps/api/core";
import { renderMarkdown } from "./markdown";
import { saveTextFileDialog } from "./transfer";
import { imageToDataUrl } from "./images";
import { resolveLinkPath } from "../paths";
import { IS_MAC } from "../platform";
import { currentMarkdownThemeId, markdownThemeCss } from "../theme/markdownThemes";
import { exportPaletteCss } from "../theme/export";
import { TOKEN_CONTRACT } from "../theme/contractData";
import { inlinedMarkdownCss, resolvedMarkdownTheme, resolvedTheme } from "../theme/install";
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
  await inlineImagesIn(doc, baseDir);
  return doc.body.innerHTML;
}

/**
 * The same rewrite against a whole parsed document, for the files that *are*
 * one already — an `.html` deliverable carries its own `<head>` and styles, so
 * taking `body.innerHTML` out of it (what {@link inlineImages} returns) would
 * print the page stripped of everything that made it look like itself.
 */
async function inlineImagesIn(doc: Document, baseDir?: string): Promise<void> {
  if (!baseDir) return;
  const imgs = [...doc.querySelectorAll("img")]
    .filter((img) => needsInlining(img.getAttribute("src")));
  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute("src")!;
    try {
      const { dataUrl } = await imageToDataUrl(resolveLinkPath(baseDir, src));
      img.setAttribute("src", dataUrl);
    } catch (e) {
      // A missing file shouldn't sink the whole export; it exports as a
      // broken image, exactly as it renders in the app. Logged rather than
      // swallowed outright: a silent catch here is how an encode/decode
      // mismatch went unnoticed while every illustration vanished from the
      // exported file.
      console.warn(`[export] could not inline image ${src}:`, e);
    }
  }));
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


/**
 * The files these three exports are actually right for.
 *
 * All three paths start with `renderMarkdown(source)`, so the predicate is
 * "would rendering this file as markdown be the truth?" — which is narrower
 * than "the editor can open it":
 *   - `.html` / `.htm` is edited as text but previewed in a sandboxed iframe;
 *     running its source through the markdown renderer produced an escaped,
 *     double-rendered copy of the page, not the page.
 *   - an image (and anything the editor can't read) has no text at all here —
 *     the buffer still holds the *previous* document, and exporting it wrote
 *     that document out under the picture's name.
 * Deliberately not `isChapterFile`: that one decides what enters the outline
 * and the spine, and widening it for an outline reason must not silently
 * widen what claims to export correctly.
 */
const EXPORT_EXTS = new Set(["md", "markdown", "txt"]);

/** True when {@link exportMarkdown} / {@link exportHtml} / {@link exportPdf} apply. */
export function isExportableDocument(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXPORT_EXTS.has(ext);
}


// ─── Markdown ─────────────────────────────────────────────────────────────────

export async function exportMarkdown(source: string): Promise<void> {
  await navigator.clipboard.writeText(source);
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

/**
 * Page frame + the active markdown theme over the author's two appearance
 * themes — light on `:root`, dark under `prefers-color-scheme`. Read off the
 * theme registry the way `currentMarkdownThemeId` reads the DOM: the export
 * is a lib-layer call with no React around it.
 *
 * A typography theme *file* rides along as its validated CSS after the
 * built-in base it extends, assets inlined — the exported `<body>` carries
 * the `md-body` class so the file's `.md-body …` rules land on it unchanged.
 */
async function documentCss(): Promise<string> {
  const md = markdownThemeCss(currentMarkdownThemeId(), "body");
  const user = await inlinedMarkdownCss(resolvedMarkdownTheme());
  // The font scheme is the `data-font` axis on <html>; the stacks the file
  // carries are the scheme's own, which name system faces first.
  const fontScheme = document.documentElement.getAttribute("data-font") ?? undefined;
  const palette = exportPaletteCss(
    resolvedTheme("light"), resolvedTheme("dark"), `${md}\n${user}`, TOKEN_CONTRACT, undefined, fontScheme,
  );
  return `${palette}
body {
  background: var(--color-bg-base);
  color: var(--color-text-primary);
  max-width: 760px;
  margin: 48px auto;
  padding: 0 24px 80px;
}
${md}
${user}`;
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
<html lang="${docLang()}" data-md-theme="${currentMarkdownThemeId()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${await documentCss()}</style>
</head>
<body class="md-body">
${body}
</body>
</html>`;
  return saveTextFileDialog(html, `${title || "document"}.html`, "HTML", ["html"]);
}

// ─── PDF (system print) ───────────────────────────────────────────────────────

export async function exportPdf(source: string, title: string, baseDir?: string): Promise<void> {
  const body = await inlineImages(renderMarkdown(source), baseDir);
  // macOS shows the preview window, and its print dialog has no virtual PDF
  // printer — the PDF exit is the easily-missed "PDF ▾" menu in the dialog's
  // corner. A banner at the bottom of the preview window points at it; the
  // print sheet drops from the title bar, so the bottom edge stays visible.
  const macHint = IS_MAC
    ? `<div class="pdf-export-hint">${escapeHtml(i18n.t("editor.exportPdfHint"))}</div>`
    : "";
  const html = `<!DOCTYPE html>
<html lang="${docLang()}" data-md-theme="${currentMarkdownThemeId()}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${await documentCss()}
/* Print sheet: white paper, no page margin of our own — the paper margins
   come from the print system (NSPrintInfo on macOS, the dialog elsewhere),
   so the body's screen padding is zeroed too rather than stacking on top. */
body { background: #fff; }
.pdf-export-hint {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  padding: 10px 16px;
  background: var(--color-bg-elevated);
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.4;
  text-align: center;
}
@media print {
  body { margin: 0; padding: 0; max-width: none; }
  .pdf-export-hint { display: none; }
  a { text-decoration: none; }
  pre, blockquote, table, img { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
}
</style>
</head>
<body>${body}${macHint}</body>
</html>`;

  await printPage(html, title);
}

/**
 * Print an `.html` deliverable — the author's own page, not a rendering of it.
 *
 * This is the only export an HTML file gets (设计稿 01e 表 B): the other two
 * run the source through `renderMarkdown`, which turns a page into an escaped
 * copy of its own markup. Here the document is parsed, its pictures inlined in
 * place (the print sheet has no base URL to resolve `assets/…` against) and
 * handed to the same print path as the PDF export.
 *
 * `<script>` elements are dropped first. A print rendering has nothing to run
 * them for, and the two print surfaces disagree about whether they *would*
 * run: the in-app iframe is same-origin and the app's CSP would refuse them,
 * while the macOS print window is a webview of its own. Removing them makes
 * the printed page the same on both, and keeps this away from the deliberate
 * rule that the standalone preview window is the one place a page's scripts
 * really run (docs/feature/html-artifact-plan.md).
 */
export async function printHtmlDocument(
  source: string,
  title: string,
  baseDir?: string,
): Promise<void> {
  const doc = new DOMParser().parseFromString(source, "text/html");
  doc.querySelectorAll("script").forEach((s) => s.remove());
  await inlineImagesIn(doc, baseDir);
  await printPage(`<!DOCTYPE html>\n${doc.documentElement.outerHTML}`, title);
}

/** Hand a complete HTML page to the system print dialog. */
async function printPage(html: string, title: string): Promise<void> {
  // macOS has no `window.print()`. WebKit forwards a JS print request to the
  // host app through the WKUIDelegate print callback, and wry doesn't implement
  // it — the call returns silently having done nothing, which is what made this
  // menu item look broken. Rust owns the only working path there
  // (`Webview::print()` on a window of its own); see src-tauri/src/print.rs.
  if (IS_MAC) {
    await invoke("print_document", { html, title: title || "document" });
    return;
  }

  // Elsewhere the webview is Chromium (WebView2) or WebKitGTK, where printing a
  // detached iframe works and needs no window of its own.
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
