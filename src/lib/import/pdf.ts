/**
 * PDF → Markdown via pdfjs-dist: text extraction plus embedded raster images.
 *
 * pdfjs is the one extractor with dependable CJK support (it is Firefox's PDF
 * engine), which matters because the documents this exists for — tender
 * documents — are mostly Chinese. What it cannot give back is layout: table
 * cells come out as plain lines in reading order, so tables degrade to text.
 * That is a documented limit of the format, not something to fix here. So are
 * vector drawings — a chart drawn with paths is not a raster XObject, and only
 * raster images are extracted (docs/feature/import-images-plan.md §7 on why
 * render-and-crop was rejected).
 *
 * The line/paragraph reconstruction and image placement are pure and exported
 * for tests; only `pdfToMarkdown` touches pdfjs (lazily — the library + worker
 * are ~2 MB) and the canvas encoder. The op-list walking and the keep/drop
 * rules live in `pdfImages.ts`, also pure.
 */

import type { ConvertResult } from "./index";
import {
  assignAssets,
  collectImagePlacements,
  hasAlpha,
  isNegligible,
  toRGBA,
  type PageImage,
  type PdfOpsTable,
  type PdfOpStream,
  type PlacedImage,
  type RawPlacement,
} from "./pdfImages";

/**
 * The slice of a pdfjs text-content chunk this module consumes. Declared here
 * rather than imported: pdfjs does not re-export `TextContent` from its package
 * root, and the reconstruction only ever touches `items`.
 */
interface TextContentChunk {
  items: ReadonlyArray<
    { str: string; transform: number[]; hasEOL: boolean } | { type: string }
  >;
}

/** The slice of a pdfjs TextItem the reconstruction needs. */
export interface PdfTextItem {
  str: string;
  /** Baseline x/y from `transform[4]`/`transform[5]` (PDF user space, y-up). */
  x: number;
  y: number;
  hasEOL: boolean;
}

interface Line {
  y: number;
  text: string;
}

/**
 * Fold raw text items into visual lines. pdfjs emits items in content order
 * (reading order in practice) with `hasEOL` marking most line ends; the
 * y-jump check catches the rest (multi-column headers, items emitted out of
 * band), using a small tolerance so sub/superscripts don't split a line.
 *
 * Items on one line are concatenated without inserting spaces: pdfjs already
 * includes Latin spacing in `str`, and injected spaces would corrupt CJK text
 * — the main audience here.
 */
export function itemsToLines(items: PdfTextItem[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const item of items) {
    if (cur && Math.abs(item.y - cur.y) > 2) {
      if (cur.text.trim()) lines.push(cur);
      cur = null;
    }
    if (!cur) cur = { y: item.y, text: "" };
    cur.text += item.str;
    if (item.hasEOL) {
      if (cur.text.trim()) lines.push(cur);
      cur = null;
    }
  }
  if (cur && cur.text.trim()) lines.push(cur);
  return lines;
}

/** `![](assets/…)`, path segments percent-encoded like `imageMarkdown` does. */
function imageLink(relPath: string): string {
  return `![](${relPath.split("/").map(encodeURIComponent).join("/")})`;
}

/**
 * Weave one page's lines and images into markdown.
 *
 * Paragraph grouping is by vertical gap: a gap clearly larger than the page's
 * own typical line spacing starts a new paragraph. The threshold is relative
 * (1.6× the median gap) because absolute spacing varies per document and per
 * font size — and it is computed from the *text lines only*: an image's y is
 * its top edge, not a baseline, and letting it into the median would skew the
 * paragraph threshold.
 *
 * Within a paragraph, lines are joined with single newlines — markdown treats
 * those as soft breaks, which keeps numbered tender clauses on their own
 * editor lines without welding them into one visual paragraph. Images are
 * their own paragraph (an image link glued into prose renders inline
 * mid-sentence), inserted before the first line that sits below their top
 * edge; text keeps its content order, so a multi-column page cannot be
 * reshuffled by image insertion.
 */
export function pageToMarkdown(lines: Line[], images: readonly PlacedImage[]): string {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y; // y-up: next line is lower
    if (gap > 0) gaps.push(gap);
  }
  // Lower median: with few gaps (short pages) the upper median can *be* the
  // one paragraph gap, which would then never exceed its own threshold.
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;

  const pending = [...images].sort((a, b) => b.y - a.y);
  let next = 0;

  const segments: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) segments.push(cur.join("\n"));
    cur = [];
  };
  for (let i = 0; i < lines.length; i++) {
    while (next < pending.length && pending[next].y >= lines[i].y) {
      flush();
      segments.push(imageLink(pending[next++].relPath));
    }
    if (i > 0) {
      const gap = lines[i - 1].y - lines[i].y;
      if (median > 0 && gap > median * 1.6) flush();
    }
    cur.push(lines[i].text.trimEnd());
  }
  flush();
  while (next < pending.length) segments.push(imageLink(pending[next++].relPath));
  return segments.join("\n\n");
}

/** Text-only page assembly — `pageToMarkdown` with no images. */
export function linesToMarkdown(lines: Line[]): string {
  return pageToMarkdown(lines, []);
}

// ─── pdfjs glue ──────────────────────────────────────────────────────────────

/** The forms an image object takes in `page.objs` across pdfjs versions. */
interface PdfImageLike {
  width?: number;
  height?: number;
  data?: Uint8Array | Uint8ClampedArray;
  kind?: number;
  bitmap?: ImageBitmap;
}

/** The slice of a pdfjs page proxy this module touches. */
interface PdfPageLike {
  streamTextContent(): unknown;
  getOperatorList(): Promise<PdfOpStream>;
  objs: { get(id: string): unknown };
  commonObjs: { get(id: string): unknown };
}

function getPageObject(page: PdfPageLike, id: string): PdfImageLike | null {
  // Global resources (shared across pages) live in commonObjs under g_ ids.
  const store = id.startsWith("g_") ? page.commonObjs : page.objs;
  try {
    return (store.get(id) as PdfImageLike) ?? null;
  } catch {
    // objs.get throws for an unresolved id; skip the image, keep the text.
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Draw one pdfjs image object to a canvas and encode it. Opaque images go out
 * as JPEG 0.9 — tender/scan PDFs embed DCT photos, and a PNG re-encode of
 * those balloons 5–10× — while anything with alpha (cut-out logos, small by
 * nature) keeps PNG's losslessness. Returns null for negligible sizes,
 * unknown pixel layouts, or a canvas that refuses to encode.
 */
async function encodePdfImage(
  obj: PdfImageLike,
  placement: RawPlacement,
): Promise<Omit<PageImage, "y"> | null> {
  const bitmap = obj.bitmap ?? (obj instanceof ImageBitmap ? obj : null);
  const width = obj.width ?? bitmap?.width ?? 0;
  const height = obj.height ?? bitmap?.height ?? 0;
  if (!width || !height) return null;
  if (isNegligible(placement.w, placement.h, width, height)) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (bitmap) {
    ctx.drawImage(bitmap, 0, 0);
  } else if (obj.data) {
    const rgba = toRGBA(obj.data, width, height, obj.kind ?? -1);
    if (!rgba) return null;
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  } else {
    return null;
  }

  const alpha = hasAlpha(ctx.getImageData(0, 0, width, height).data);
  const type = alpha ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, 0.9),
  );
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { hash: await sha256Hex(bytes), ext: alpha ? "png" : "jpg", bytes };
}

/**
 * All extractable images of one page, encoded. Failures — an op list that
 * won't build, an object that won't resolve — cost that page's images, never
 * its text: image extraction is a bonus on top of an import that used to be
 * text-only, so it must not be able to fail the import.
 */
async function extractPageImages(
  page: PdfPageLike,
  OPS: PdfOpsTable,
): Promise<PageImage[]> {
  try {
    const placements = collectImagePlacements(await page.getOperatorList(), OPS);
    const out: PageImage[] = [];
    for (const placement of placements) {
      const obj = placement.id
        ? getPageObject(page, placement.id)
        : (placement.inlineImage as PdfImageLike | null);
      if (!obj) continue;
      const encoded = await encodePdfImage(obj, placement);
      if (encoded) out.push({ y: placement.y, ...encoded });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Convert a PDF to markdown plus its extracted images. `assetRelDir` is the
 * document-relative folder the links point at ("assets/<group>"); the caller
 * writes the returned bytes there — this module never touches the disk.
 */
export async function pdfToMarkdown(
  data: Uint8Array,
  assetRelDir: string,
): Promise<ConvertResult> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  // pdfjs transfers the buffer to its worker, so it gets its own copy.
  const task = pdfjs.getDocument({ data: data.slice() });
  const doc = await task.promise;
  try {
    const pageLines: Line[][] = [];
    const pageImages: PageImage[][] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const items: PdfTextItem[] = [];
      // Drained through an explicit reader, not pdfjs's own `getTextContent()`.
      // That convenience wrapper is written as `for await (… of stream)`, and
      // WKWebView — the engine behind every macOS/iOS Tauri build — still ships
      // no `ReadableStream[Symbol.asyncIterator]`, so it throws "undefined is
      // not a function" before a single page is read. `streamTextContent` is
      // the same public API one layer down, and a reader loop works everywhere.
      const reader = (
        page.streamTextContent() as ReadableStream<TextContentChunk>
      ).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const raw of value.items) {
          if (!("str" in raw)) continue; // TextMarkedContent — no text payload
          items.push({
            str: raw.str,
            x: raw.transform[4],
            y: raw.transform[5],
            hasEOL: raw.hasEOL,
          });
        }
      }
      pageLines.push(itemsToLines(items));
      pageImages.push(await extractPageImages(page as unknown as PdfPageLike, pdfjs.OPS));
    }
    // Naming and the decoration filter are cross-page (a header logo is only
    // recognisable by appearing on many pages), so assembly waits for all of
    // them.
    const { placed, assets } = assignAssets(pageImages, assetRelDir);
    const pages = pageLines.map(
      // Page markers as HTML comments: invisible in the preview, but they give
      // 应答依据 a page number to cite and survive into the RAG context.
      (lines, idx) => `<!-- page ${idx + 1} -->\n\n${pageToMarkdown(lines, placed[idx])}`,
    );
    return { markdown: pages.join("\n\n").trim(), assets };
  } finally {
    await task.destroy();
  }
}
