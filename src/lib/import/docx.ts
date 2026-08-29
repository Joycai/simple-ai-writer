/**
 * .docx → Markdown, via mammoth (docx → semantic HTML) and the shared
 * HTML → Markdown pass. Mammoth is ~700 kB and only needed the moment an
 * author actually imports a Word file, so it loads lazily.
 *
 * Embedded pictures ride the `ConvertResult` seam: the image callback names
 * each one, keeps its bytes, and points the `<img src>` at the caller's
 * `assets/<文档名>/` folder — no data URLs in the body, and the import loop
 * stays the only place that touches the disk. Only formats the app itself
 * opens are kept (see `EXT_FOR_CONTENT_TYPE`); the EMF/WMF vector drawings
 * Office likes to embed for charts and formulas are dropped, the same
 * raster-only limit the PDF side has (docs/feature/import-images-plan.md §2).
 *
 * Legacy binary .doc is deliberately unsupported — mammoth can't read it, and
 * a half-garbled import is worse than asking the author to save as .docx.
 */

import { htmlToMarkdown } from "./markdown";
import type { ConvertedAsset, ConvertResult } from "./index";

/**
 * Content types that become assets, mapped to the extension the file gets —
 * the app's own openable image kinds (`lib/fs/images`), spelled as the MIME
 * types a docx declares. Anything else returns an empty `src`, which the
 * markdown pass drops (`markdown.ts`).
 */
const EXT_FOR_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export interface DocxImageCollector {
  /** What `collect` kept, in document order. */
  assets: ConvertedAsset[];
  /** Name one image, keep its bytes, and return the `<img>` src for it. */
  collect(contentType: string, bytes: Uint8Array): { src: string };
}

/**
 * The pure body of the mammoth image callback, split out so naming, the
 * content-type gate and the link encoding test without a Word file.
 */
export function imageCollector(assetRelDir: string): DocxImageCollector {
  const encodedDir = assetRelDir.split("/").map(encodeURIComponent).join("/");
  const assets: ConvertedAsset[] = [];
  let counter = 0;
  return {
    assets,
    collect(contentType, bytes) {
      const ext = EXT_FOR_CONTENT_TYPE[contentType.toLowerCase()];
      if (!ext || bytes.byteLength === 0) return { src: "" };
      const name = `img-${++counter}.${ext}`;
      assets.push({ name, bytes });
      return { src: `${encodedDir}/${encodeURIComponent(name)}` };
    },
  };
}

export async function docxToMarkdown(
  data: Uint8Array,
  assetRelDir: string,
): Promise<ConvertResult> {
  const mammoth = await import("mammoth");
  const collector = imageCollector(assetRelDir);
  const convertImage = mammoth.images.imgElement(async (image) =>
    collector.collect(
      image.contentType ?? "",
      new Uint8Array(await image.readAsArrayBuffer()),
    ),
  );
  // Hand mammoth its own copy (`data` may be a view over a larger buffer, and
  // the unzip step consumes it) — under both keys, because mammoth has two
  // faces: the browser build (the app) reads `arrayBuffer`, the Node build
  // (vitest) reads `buffer`, and each ignores the other key. The declared
  // `Input` type admits only one at a time, hence the cast.
  const bytes = data.slice();
  const input = { arrayBuffer: bytes.buffer, buffer: bytes } as unknown as Parameters<
    typeof mammoth.convertToHtml
  >[0];
  const result = await mammoth.convertToHtml(input, { convertImage });
  return { markdown: htmlToMarkdown(result.value), assets: collector.assets };
}
