/**
 * A markdown theme's assets — the fonts and textures its `url()`s name.
 *
 * Typora's convention: `宋楷.css` keeps its files in `宋楷/` beside it, and
 * the CSS refers to them relatively. The validator has already refused every
 * other kind of `url()`, so what reaches here is a relative path or `data:`.
 *
 * They are **inlined as `data:` URLs**, for the installed sheet and for the
 * export alike — the plan (§5, §11) had them rewritten to the
 * `ai-writer-asset:` protocol on install, but the app already retired that
 * protocol for its own pictures: WebView2's URL parsing makes it unreliable
 * on Windows drive-letter paths (`components/lore/useImageDataUrl.ts`,
 * `src-tauri/src/protocol.rs`), so every image consumer renders data URLs.
 * One transform for both destinations also means the settings sample, the
 * app and the exported file cannot disagree about a font. The cost is a
 * `<style>` as large as the fonts it carries, which is the author's choice
 * of font to make; a file that cannot be read stays a relative `url()` and
 * simply fails to load, the way it would in Typora.
 */
import { readBinaryFile, toBase64 } from "../fs/fileio";
import { joinPath } from "../paths";

const MIME: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

function assetMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/**
 * Replace every relative `url()` in `css` with `resolve(target)`'s answer,
 * leaving `data:` (and anything else) alone. Pure; the reader is injected.
 */
export function rewriteUrls(css: string, resolve: (target: string) => string): string {
  return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')]*))\s*\)/g, (whole, a, b, c) => {
    const target = ((a ?? b ?? c) as string).trim();
    if (!target || /^data:/i.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) return whole;
    return `url("${resolve(target)}")`;
  });
}

/** Read every asset `css` names, relative to `baseDir`, and inline it. */
export async function inlineAssets(css: string, baseDir: string, targets: readonly string[]): Promise<string> {
  const data = new Map<string, string>();
  for (const rel of new Set(targets)) {
    const path = joinPath(baseDir, rel.replace(/\\/g, "/"));
    try {
      const bytes = await readBinaryFile(path);
      data.set(rel, `data:${assetMime(path)};base64,${toBase64(bytes)}`);
    } catch (e) {
      console.warn(`[theme] could not inline ${path}:`, e);
    }
  }
  return rewriteUrls(css, (t) => data.get(t) ?? t);
}
