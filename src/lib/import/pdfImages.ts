/**
 * The pure half of PDF image extraction: walking a page's operator list to
 * find where raster images land (and how big they render), converting pdfjs
 * pixel buffers to RGBA, and the three keep/drop rules — negligible size,
 * cross-page decoration, content dedupe.
 *
 * Everything here takes plain data (an op stream, byte arrays, hash lists) so
 * it tests without pdfjs or a canvas; the impure glue — `page.objs`, canvas
 * encoding, SHA-256 — stays in `pdf.ts`. Design: docs/feature/import-images-plan.md.
 */

import type { ConvertedAsset } from "./index";

/** The pdfjs `OPS` constants this walker consumes (structurally, so tests can fake it). */
export interface PdfOpsTable {
  save: number;
  restore: number;
  transform: number;
  paintImageXObject: number;
  paintImageXObjectRepeat: number;
  paintInlineImageXObject: number;
}

/** The shape `page.getOperatorList()` resolves to. */
export interface PdfOpStream {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown[] | null>;
}

/** 2D affine matrix in PDF order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** old ∘ m — apply `m` first, then `prev` (pdfjs `transform` pre-concatenates). */
function multiply(prev: Matrix, m: Matrix): Matrix {
  return {
    a: prev.a * m.a + prev.c * m.b,
    b: prev.b * m.a + prev.d * m.b,
    c: prev.a * m.c + prev.c * m.d,
    d: prev.b * m.c + prev.d * m.d,
    e: prev.a * m.e + prev.c * m.f + prev.e,
    f: prev.b * m.e + prev.d * m.f + prev.f,
  };
}

/** One image paint found in the op stream. */
export interface RawPlacement {
  /** XObject id for `page.objs`/`page.commonObjs`, or null when inlined. */
  id: string | null;
  /** The inline image object, for `paintInlineImageXObject` ops. */
  inlineImage?: unknown;
  /** Top edge in page user space (y-up) — the reading-order sort key. */
  y: number;
  /** Rendered size in pt (side lengths, rotation-safe). */
  w: number;
  h: number;
}

/**
 * An image paint maps the unit square through the CTM; the placement is that
 * square's top edge and side lengths. Top edge = max corner y rather than `f`
 * because a typical image matrix has d > 0 with f at the *bottom* edge.
 */
function placementAt(m: Matrix, id: string | null, inlineImage?: unknown): RawPlacement {
  const ys = [m.f, m.b + m.f, m.d + m.f, m.b + m.d + m.f];
  return {
    id,
    inlineImage,
    y: Math.max(...ys),
    w: Math.hypot(m.a, m.b),
    h: Math.hypot(m.c, m.d),
  };
}

/**
 * Walk one page's operator list and report every raster image paint with its
 * position. Only the CTM machinery is interpreted (`save`/`restore`/
 * `transform`); everything else is opaque. `paintImageMaskXObject` (stencil
 * masks — stamp/watermark cutouts) is deliberately not collected: a mask has
 * no colour data of its own.
 */
export function collectImagePlacements(
  ops: PdfOpStream,
  OPS: PdfOpsTable,
): RawPlacement[] {
  const out: RawPlacement[] = [];
  const stack: Matrix[] = [];
  let ctm = IDENTITY;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (fn === OPS.transform && args) {
      const [a, b, c, d, e, f] = args as number[];
      ctm = multiply(ctm, { a, b, c, d, e, f });
    } else if (fn === OPS.paintImageXObject && args) {
      out.push(placementAt(ctm, String(args[0])));
    } else if (fn === OPS.paintInlineImageXObject && args) {
      out.push(placementAt(ctm, null, args[0]));
    } else if (fn === OPS.paintImageXObjectRepeat && args) {
      // Repeated stamps of one XObject: [id, scaleX, scaleY, [x1,y1,x2,y2,…]].
      // Each position is its own placement; the dedupe/decoration rules are
      // what keep a border tile from flooding the document.
      const [id, sx, sy, positions] = args as [
        string,
        number,
        number,
        ArrayLike<number>,
      ];
      for (let p = 0; p + 1 < positions.length; p += 2) {
        const m = multiply(ctm, {
          a: sx,
          b: 0,
          c: 0,
          d: sy,
          e: positions[p],
          f: positions[p + 1],
        });
        out.push(placementAt(m, String(id)));
      }
    }
  }
  return out;
}

// ─── Pixel buffers ───────────────────────────────────────────────────────────

/** pdfjs `ImageKind` values (stable constants, mirrored to avoid the import). */
export const IMAGE_KIND = {
  GRAYSCALE_1BPP: 1,
  RGB_24BPP: 2,
  RGBA_32BPP: 3,
} as const;

/**
 * Expand a pdfjs decoded buffer to RGBA for `ImageData`. Returns null for a
 * kind this doesn't know — the caller skips the image rather than guessing at
 * a pixel layout.
 */
export function toRGBA(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  kind: number,
): Uint8ClampedArray<ArrayBuffer> | null {
  const out = new Uint8ClampedArray(width * height * 4);
  if (kind === IMAGE_KIND.RGBA_32BPP) {
    out.set(data.subarray(0, out.length));
    return out;
  }
  if (kind === IMAGE_KIND.RGB_24BPP) {
    for (let i = 0, o = 0; o < out.length; i += 3, o += 4) {
      out[o] = data[i];
      out[o + 1] = data[i + 1];
      out[o + 2] = data[i + 2];
      out[o + 3] = 255;
    }
    return out;
  }
  if (kind === IMAGE_KIND.GRAYSCALE_1BPP) {
    // Packed bits, rows padded to a byte boundary; 1 = white.
    const rowBytes = (width + 7) >> 3;
    for (let yPix = 0; yPix < height; yPix++) {
      for (let xPix = 0; xPix < width; xPix++) {
        const bit = (data[yPix * rowBytes + (xPix >> 3)] >> (7 - (xPix & 7))) & 1;
        const v = bit ? 255 : 0;
        const o = (yPix * width + xPix) * 4;
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
    return out;
  }
  return null;
}

/** Any pixel not fully opaque → the image needs PNG rather than JPEG. */
export function hasAlpha(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true;
  }
  return false;
}

// ─── Keep/drop rules ─────────────────────────────────────────────────────────

/** Rendered size below this (either axis, pt) is a bullet/border tile. */
export const MIN_RENDER_PT = 24;
/** Native size below this (either axis, px) is scan noise or a glyph. */
export const MIN_NATIVE_PX = 32;

/** True for decoration-sized images the import drops outright. */
export function isNegligible(
  renderW: number,
  renderH: number,
  nativeW: number,
  nativeH: number,
): boolean {
  return (
    Math.min(renderW, renderH) < MIN_RENDER_PT ||
    Math.min(nativeW, nativeH) < MIN_NATIVE_PX
  );
}

export const DECORATION_MIN_PAGES = 3;
export const DECORATION_PAGE_SHARE = 0.3;

/**
 * Content hashes that behave like page furniture — the same image on ≥3 pages
 * *and* ≥30% of all pages. A header logo or watermark meets both immediately;
 * an illustration legitimately reused twice meets neither. Both thresholds
 * must hold: on a 4-page document, 3 appearances could be a genuine figure,
 * and on a 200-page one, 30% alone would never trigger.
 */
export function decorationHashes(pageHashes: ReadonlyArray<readonly string[]>): Set<string> {
  const pagesWith = new Map<string, number>();
  for (const page of pageHashes) {
    for (const hash of new Set(page)) {
      pagesWith.set(hash, (pagesWith.get(hash) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  const total = pageHashes.length;
  for (const [hash, n] of pagesWith) {
    if (n >= DECORATION_MIN_PAGES && n / total >= DECORATION_PAGE_SHARE) out.add(hash);
  }
  return out;
}

// ─── Naming & dedupe ─────────────────────────────────────────────────────────

/** One extracted image, encoded, before naming. */
export interface PageImage {
  /** Top edge in page space — ordering within the page. */
  y: number;
  /** Content hash of the encoded bytes. */
  hash: string;
  ext: string;
  bytes: Uint8Array;
}

/** An image that made it into the document, ready for the placement layer. */
export interface PlacedImage {
  y: number;
  /** Document-relative link target ("assets/<group>/p3-1.jpg"). */
  relPath: string;
}

/**
 * Apply the decoration filter, dedupe by content hash, and hand out names.
 *
 * Names are `p<page>-<n>.<ext>` — the page number is in the filename so the
 * author can match a file in `assets/` to the `<!-- page N -->` markers
 * without opening it. A duplicate links the file its first occurrence landed;
 * a decoration hash disappears entirely (first occurrence included — one
 * header logo in the body is exactly as wrong as two hundred).
 */
export function assignAssets(
  pages: ReadonlyArray<readonly PageImage[]>,
  relDir: string,
): { placed: PlacedImage[][]; assets: ConvertedAsset[] } {
  const decoration = decorationHashes(pages.map((p) => p.map((img) => img.hash)));
  const named = new Map<string, string>();
  const assets: ConvertedAsset[] = [];
  const placed = pages.map((images, pageIdx) => {
    let counter = 0;
    const out: PlacedImage[] = [];
    // Top-to-bottom so the per-page numbering follows reading order.
    for (const img of [...images].sort((a, b) => b.y - a.y)) {
      if (decoration.has(img.hash)) continue;
      let name = named.get(img.hash);
      if (!name) {
        name = `p${pageIdx + 1}-${++counter}.${img.ext}`;
        named.set(img.hash, name);
        assets.push({ name, bytes: img.bytes });
      }
      out.push({ y: img.y, relPath: `${relDir}/${name}` });
    }
    return out;
  });
  return { placed, assets };
}
