/**
 * The pure half of PDF image extraction (`lib/import/pdfImages`): CTM tracking
 * over a faked operator stream, pixel-buffer expansion, and the keep/drop
 * rules (negligible size, cross-page decoration, content dedupe + naming).
 * The canvas encoder and `page.objs` glue stay untested here — thin adapters
 * over vendored code, verified on a real machine per the plan
 * (docs/feature/import-images-plan.md §5).
 */
import { describe, expect, it } from "vitest";
import {
  assignAssets,
  collectImagePlacements,
  decorationHashes,
  hasAlpha,
  IMAGE_KIND,
  isNegligible,
  toRGBA,
  type PageImage,
  type PdfOpsTable,
} from "../import/pdfImages";

// Arbitrary distinct values — the walker must key off the table, not pdfjs's
// real constants.
const OPS: PdfOpsTable = {
  save: 1,
  restore: 2,
  transform: 3,
  paintImageXObject: 4,
  paintImageXObjectRepeat: 5,
  paintInlineImageXObject: 6,
};

const stream = (ops: Array<[number, unknown[] | null]>) => ({
  fnArray: ops.map(([fn]) => fn),
  argsArray: ops.map(([, args]) => args),
});

describe("collectImagePlacements", () => {
  it("reads position and rendered size off the CTM", () => {
    const [p] = collectImagePlacements(
      stream([
        [OPS.transform, [100, 0, 0, 80, 50, 600]],
        [OPS.paintImageXObject, ["img1"]],
      ]),
      OPS,
    );
    expect(p.id).toBe("img1");
    // Unit square through the matrix: top edge is f + d, sides are |a| × |d|.
    expect(p.y).toBe(680);
    expect(p.w).toBe(100);
    expect(p.h).toBe(80);
  });

  it("restores the outer CTM after save/restore", () => {
    const [a, b] = collectImagePlacements(
      stream([
        [OPS.transform, [1, 0, 0, 1, 0, 500]],
        [OPS.save, null],
        [OPS.transform, [100, 0, 0, 100, 0, 0]],
        [OPS.paintImageXObject, ["a"]],
        [OPS.restore, null],
        [OPS.transform, [50, 0, 0, 50, 200, 0]],
        [OPS.paintImageXObject, ["b"]],
      ]),
      OPS,
    );
    expect(a.y).toBe(600);
    expect(a.w).toBe(100);
    // b's scale composed with the translation, not with a's discarded scale.
    expect(b.y).toBe(550);
    expect(b.w).toBe(50);
  });

  it("expands a repeat op into one placement per position", () => {
    const placements = collectImagePlacements(
      stream([[OPS.paintImageXObjectRepeat, ["logo", 40, 30, [0, 0, 100, 200]]]]),
      OPS,
    );
    expect(placements.map((p) => ({ id: p.id, y: p.y, w: p.w, h: p.h }))).toEqual([
      { id: "logo", y: 30, w: 40, h: 30 },
      { id: "logo", y: 230, w: 40, h: 30 },
    ]);
  });

  it("carries the inline image object with a null id", () => {
    const img = { width: 2, height: 2 };
    const [p] = collectImagePlacements(
      stream([[OPS.paintInlineImageXObject, [img]]]),
      OPS,
    );
    expect(p.id).toBeNull();
    expect(p.inlineImage).toBe(img);
  });

  it("ignores every op it does not interpret", () => {
    expect(collectImagePlacements(stream([[99, ["noise"]]]), OPS)).toEqual([]);
  });
});

describe("toRGBA", () => {
  it("passes RGBA through and expands RGB with opaque alpha", () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(toRGBA(rgba, 2, 1, IMAGE_KIND.RGBA_32BPP)).toEqual(rgba);
    expect(
      toRGBA(new Uint8Array([255, 0, 0, 0, 255, 0]), 2, 1, IMAGE_KIND.RGB_24BPP),
    ).toEqual(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]));
  });

  it("unpacks 1bpp grayscale with byte-padded rows, 1 = white", () => {
    // 2×2, one byte per row: [1,0] / [0,1].
    const out = toRGBA(
      new Uint8Array([0b10000000, 0b01000000]),
      2,
      2,
      IMAGE_KIND.GRAYSCALE_1BPP,
    );
    expect(out).toEqual(
      new Uint8ClampedArray([
        255, 255, 255, 255, 0, 0, 0, 255,
        0, 0, 0, 255, 255, 255, 255, 255,
      ]),
    );
  });

  it("refuses an unknown kind instead of guessing a layout", () => {
    expect(toRGBA(new Uint8Array(4), 1, 1, 99)).toBeNull();
  });
});

describe("hasAlpha", () => {
  it("spots a single translucent pixel", () => {
    expect(hasAlpha(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 254]))).toBe(true);
    expect(hasAlpha(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]))).toBe(false);
  });
});

describe("isNegligible", () => {
  it("drops below either the rendered or the native floor", () => {
    expect(isNegligible(100, 100, 500, 500)).toBe(false);
    expect(isNegligible(500, 10, 500, 500)).toBe(true); // thin divider strip
    expect(isNegligible(100, 100, 500, 20)).toBe(true); // scan noise / glyph
  });
});

describe("decorationHashes", () => {
  const pages = (spec: string[][]) => decorationHashes(spec);

  it("flags a hash on ≥3 pages and ≥30% of pages, requiring both", () => {
    const tenPages = [
      ["logo"], ["logo"], ["logo"], ["logo", "fig"], ["fig"],
      [], [], [], [], [],
    ];
    expect(pages(tenPages)).toEqual(new Set(["logo"])); // 4/10 pages
    // 3 pages but only 15% of 20 → a genuine recurring figure, kept.
    const twenty = [["a"], ["a"], ["a"], ...Array.from({ length: 17 }, () => [] as string[])];
    expect(pages(twenty)).toEqual(new Set());
    // 2 pages of 2 → 100% share but under the page floor, kept.
    expect(pages([["b"], ["b"]])).toEqual(new Set());
  });

  it("counts pages, not paints — twice on one page is one page", () => {
    expect(pages([["a", "a"], ["a"], [], [], [], [], [], [], [], []])).toEqual(
      new Set(),
    );
  });
});

describe("assignAssets", () => {
  const img = (y: number, hash: string, ext = "jpg"): PageImage => ({
    y,
    hash,
    ext,
    bytes: new Uint8Array([hash.charCodeAt(0)]),
  });

  it("names top-to-bottom per page and links duplicates to the first file", () => {
    const { placed, assets } = assignAssets(
      [
        [img(400, "B", "png"), img(700, "A")], // deliberately unsorted
        [img(600, "A")],
      ],
      "assets/bid",
    );
    expect(assets.map((a) => a.name)).toEqual(["p1-1.jpg", "p1-2.png"]);
    expect(placed[0].map((p) => p.relPath)).toEqual([
      "assets/bid/p1-1.jpg",
      "assets/bid/p1-2.png",
    ]);
    // Page 2 reuses page 1's file — no new asset, same link.
    expect(placed[1]).toEqual([{ y: 600, relPath: "assets/bid/p1-1.jpg" }]);
  });

  it("drops a decoration hash everywhere, first occurrence included", () => {
    const { placed, assets } = assignAssets(
      [
        [img(700, "logo"), img(400, "fig")],
        [img(700, "logo")],
        [img(700, "logo")],
      ],
      "assets/bid",
    );
    expect(assets.map((a) => a.name)).toEqual(["p1-1.jpg"]);
    expect(placed[0]).toEqual([{ y: 400, relPath: "assets/bid/p1-1.jpg" }]);
    expect(placed[1]).toEqual([]);
    expect(placed[2]).toEqual([]);
  });
});
