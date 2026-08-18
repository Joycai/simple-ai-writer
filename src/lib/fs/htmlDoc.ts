/**
 * Preparing a project .html document for the sandboxed preview iframe.
 *
 * The preview loads the document from a `blob:` URL (see HtmlPreview for why
 * not `srcdoc`), and a blob document has no base URL — a relative
 * `<img src="assets/…">` resolves against nothing, exactly the problem the
 * exporter already solves for markdown. Same cure here: read each local image
 * relative to the document's own folder and inline it as a data URL.
 *
 * Unlike the exporter this works on a *complete* document (the author's
 * `<head>`, styles and scripts must survive), so it serializes the whole
 * parsed tree back out rather than returning `body.innerHTML`.
 */

import { needsInlining } from "./export";
import { imageToDataUrl } from "./images";
import { resolveLinkPath } from "../paths";

/** Injectable for tests — production always reads off disk. */
type ImageReader = (absPath: string) => Promise<{ dataUrl: string }>;

export async function inlineHtmlImages(
  html: string,
  /** Directory of the .html file, which its relative links resolve against. */
  baseDir: string | null,
  readImage: ImageReader = imageToDataUrl,
): Promise<string> {
  if (!baseDir) return html;

  const doc = new DOMParser().parseFromString(html, "text/html");
  const imgs = [...doc.querySelectorAll("img")]
    .filter((img) => needsInlining(img.getAttribute("src")));
  // Nothing local to embed — hand back the author's exact text rather than a
  // re-serialization of it (the parser normalizes markup it had no need to touch).
  if (imgs.length === 0) return html;

  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute("src")!;
    try {
      const { dataUrl } = await readImage(resolveLinkPath(baseDir, src));
      img.setAttribute("src", dataUrl);
    } catch (e) {
      // A missing file renders as a broken image inside the frame — the
      // author sees the hole where it is, which beats sinking the preview.
      console.warn(`[htmlDoc] could not inline image ${src}:`, e);
    }
  }));

  // DOMParser normalizes any fragment into a full html/head/body tree, so the
  // serialized form is always a complete document; only the doctype needs
  // re-attaching by hand.
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}
