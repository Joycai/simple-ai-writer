/**
 * The ladder that decides what happens to an oversized picture on its way to a
 * model. Everything here is arithmetic on purpose — `normalize.ts` owns the
 * canvas, and vitest's node environment has none — so these are the tests that
 * can exist at all for this feature.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let prefValue: string | null = null;
vi.mock("../../prefs", () => ({
  readPref: vi.fn(() => prefValue),
  writePref: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(async () => new Uint8Array()) }));
vi.mock("../../fs/fileio", () => ({ readFile: vi.fn(async () => ""), readDir: vi.fn(async () => []) }));

const {
  DEFAULT_IMAGE_LONG_EDGE, IMAGE_LONG_EDGE_MAX, IMAGE_LONG_EDGE_MIN, MAX_ENCODE_ATTEMPTS,
  MAX_IMAGE_EDGE, MIN_IMAGE_EDGE, fitsLimits, imageLimits, imageMaxLongEdge, planImageStep,
} = await import("../downscalePlan");
const { MAX_IMAGE_BYTES } = await import("../../fs/images");

const MB = 1024 * 1024;
const LIMITS = { longEdge: 4096, maxBytes: 12 * MB };

/** A JPEG-ish picture: no transparency, so a re-encode may use quality. */
const photo = (width: number, height: number, bytes: number) =>
  ({ width, height, bytes, mime: "image/jpeg", animated: false }) as const;
/** A picture whose source carries alpha — PNG out, so scaling is the only lever. */
const withAlpha = (width: number, height: number, bytes: number) =>
  ({ width, height, bytes, mime: "image/png", animated: false }) as const;

describe("imageMaxLongEdge", () => {
  beforeEach(() => { prefValue = null; });

  it("defaults to 4096 when the author has never touched it", () => {
    expect(imageMaxLongEdge()).toBe(DEFAULT_IMAGE_LONG_EDGE);
  });

  it("treats 0 and garbage as an explicit 'do not resize'", () => {
    // Distinct from "unset": an author who cleared the field wants the old
    // behaviour back, and must not silently get the default returned to them.
    for (const raw of ["0", "", "-5", "abc"]) {
      prefValue = raw;
      expect(imageMaxLongEdge()).toBe(0);
    }
  });

  it("clamps to the bounds rather than trusting the field", () => {
    prefValue = "99999";
    expect(imageMaxLongEdge()).toBe(IMAGE_LONG_EDGE_MAX);
    prefValue = "10";
    expect(imageMaxLongEdge()).toBe(IMAGE_LONG_EDGE_MIN);
  });

  it("never lets the setting go past the largest edge an endpoint accepts", () => {
    expect(IMAGE_LONG_EDGE_MAX).toBe(MAX_IMAGE_EDGE);
    expect(MAX_IMAGE_EDGE).toBe(8192);
    prefValue = "16384"; // a value stored before the ceiling came down
    expect(imageLimits().longEdge).toBe(MAX_IMAGE_EDGE);
  });

  it("still holds the endpoint ceiling when the author turned resizing off", () => {
    prefValue = "0";
    expect(imageLimits().longEdge).toBe(MAX_IMAGE_EDGE);
    expect(fitsLimits(photo(10000, 3000, 1 * MB), imageLimits())).toBe(false);
    expect(fitsLimits(photo(8000, 3000, 1 * MB), imageLimits())).toBe(true);
  });

  it("uses the app-wide byte cap, not a second opinion about it", () => {
    expect(LIMITS.maxBytes).toBe(MAX_IMAGE_BYTES);
  });
});

describe("fitsLimits", () => {
  it("needs both edge and bytes", () => {
    expect(fitsLimits(photo(4000, 3000, 2 * MB), LIMITS)).toBe(true);
    expect(fitsLimits(photo(8000, 3000, 2 * MB), LIMITS)).toBe(false);
    expect(fitsLimits(photo(4000, 3000, 20 * MB), LIMITS)).toBe(false);
  });

  it("ignores the edge entirely when the author turned it off", () => {
    const off = { longEdge: 0, maxBytes: 12 * MB };
    expect(fitsLimits(photo(20000, 20000, 1 * MB), off)).toBe(true);
    expect(fitsLimits(photo(100, 100, 20 * MB), off)).toBe(false);
  });
});

describe("planImageStep", () => {
  it("leaves an ordinary phone photo completely alone", () => {
    // iPhone main camera. The default ceiling exists to miss this.
    expect(planImageStep(photo(4032, 3024, 3 * MB), LIMITS, 0)).toEqual({ kind: "as-is" });
  });

  it("never re-encodes an animated picture, however large", () => {
    // A canvas round-trip would flatten it to its first frame — a silent,
    // unrecoverable loss that no size saving justifies.
    const gif = { width: 9000, height: 9000, bytes: 40 * MB, mime: "image/png", animated: true } as const;
    expect(planImageStep(gif, LIMITS, 0)).toEqual({ kind: "as-is" });
  });

  it("meets the long edge exactly, at top quality, before spending anything else", () => {
    const step = planImageStep(photo(8000, 4000, 30 * MB), LIMITS, 0);
    expect(step).toEqual({
      kind: "encode", width: 4096, height: 2048, mime: "image/jpeg", quality: 0.9,
    });
  });

  it("keeps the aspect ratio when the long edge is the short axis", () => {
    // A tall screenshot: height leads, and width must follow it down.
    expect(planImageStep(photo(2000, 10000, 30 * MB), LIMITS, 0)).toMatchObject({
      width: 819, height: 4096,
    });
  });

  it("spends quality before pixels for a JPEG that only overruns on bytes", () => {
    const big = photo(3000, 2000, 30 * MB);
    expect(planImageStep(big, LIMITS, 0)).toMatchObject({ width: 3000, height: 2000, quality: 0.9 });
    expect(planImageStep(big, LIMITS, 1)).toMatchObject({ width: 3000, height: 2000, quality: 0.8 });
    expect(planImageStep(big, LIMITS, 2)).toMatchObject({ width: 3000, height: 2000, quality: 0.7 });
    // Ladder spent: now, and only now, does it start giving up pixels.
    expect(planImageStep(big, LIMITS, 3)).toMatchObject({ width: 2250, height: 1500, quality: 0.85 });
  });

  it("scales every round for a PNG, which has no quality knob", () => {
    const big = withAlpha(3000, 2000, 30 * MB);
    for (const attempt of [0, 1, 2, 3]) {
      const step = planImageStep(big, LIMITS, attempt);
      expect(step).toMatchObject({ width: 2250, height: 1500, mime: "image/png" });
      expect(step).not.toHaveProperty("quality", expect.anything());
    }
  });

  it("gives up rather than looping, and says so", () => {
    // Not an error: the caller hands back its best effort and the call site's
    // own size check refuses it with the message it always printed.
    expect(planImageStep(photo(3000, 2000, 30 * MB), LIMITS, MAX_ENCODE_ATTEMPTS))
      .toEqual({ kind: "give-up" });
  });

  it("still shrinks on bytes when the edge ceiling is switched off", () => {
    const off = { longEdge: 0, maxBytes: 12 * MB };
    expect(planImageStep(photo(20000, 100, 30 * MB), off, 0)).toMatchObject({
      width: 20000, height: 100, quality: 0.9,
    });
  });

  it("never scales a side back under the floor to save bytes", () => {
    // ×0.75 would take 12px to 9 — straight into the 400 the floor exists for.
    expect(planImageStep(withAlpha(12, 3000, 30 * MB), LIMITS, 0)).toMatchObject({
      width: 10, height: 2500,
    });
    // Already on the floor, over on bytes, no quality knob: nothing is left.
    expect(planImageStep(withAlpha(10, 3000, 30 * MB), LIMITS, 0)).toEqual({ kind: "give-up" });
  });
});

describe("planImageStep — the size floor", () => {
  // Measured on DashScope qwen3-vl-plus (docs/api/landscape.md, 第六个样本):
  // 9×9 → 400 "must be larger than 10"; 10×10 and 200×10 pass.
  it("enlarges the picture the endpoint refused, and leaves the ones it took", () => {
    expect(MIN_IMAGE_EDGE).toBe(10);
    expect(planImageStep(withAlpha(9, 9, 100), LIMITS, 0)).toEqual({
      kind: "encode", width: 10, height: 10, mime: "image/png", quality: undefined,
    });
    expect(planImageStep(withAlpha(10, 10, 100), LIMITS, 0)).toEqual({ kind: "as-is" });
    expect(planImageStep(withAlpha(200, 10, 100), LIMITS, 0)).toEqual({ kind: "as-is" });
  });

  it("keeps the aspect ratio, rounding the long side up", () => {
    expect(planImageStep(photo(4, 100, 100), LIMITS, 0)).toMatchObject({
      width: 10, height: 250, quality: 0.9,
    });
    // 1000 × 10/3 = 3333.3 — up, so the short side is never the one that loses.
    expect(planImageStep(withAlpha(1000, 3, 100), LIMITS, 0)).toMatchObject({
      width: 3334, height: 10,
    });
  });

  it("lets the floor win over the long-edge ceiling, and then counts that as fitting", () => {
    // 2×1000 against a 256 ceiling can't keep both without distorting it.
    const tight = { longEdge: 256, maxBytes: 12 * MB };
    const step = planImageStep(withAlpha(2, 1000, 100), tight, 0);
    expect(step).toMatchObject({ width: 10, height: 5000 });
    // Otherwise the ladder would shrink it straight back under the floor.
    expect(fitsLimits({ width: 10, height: 5000, bytes: 100 }, tight)).toBe(true);
  });

  it("stops a downscale on the floor instead of passing through it", () => {
    // Meeting a 256 ceiling exactly would make this 3×256.
    const tight = { longEdge: 256, maxBytes: 12 * MB };
    expect(planImageStep(withAlpha(20, 2000, 100), tight, 0)).toMatchObject({
      width: 10, height: 1000,
    });
  });

  it("applies even with the long-edge ceiling switched off", () => {
    const off = { longEdge: 0, maxBytes: 12 * MB };
    expect(fitsLimits(photo(9, 9, 100), off)).toBe(false);
    expect(planImageStep(photo(3, 1, 100), off, 0)).toMatchObject({ width: 30, height: 10 });
  });

  it("still never touches an animated picture", () => {
    const tinyGif = { width: 1, height: 1, bytes: 40, mime: "image/png", animated: true } as const;
    expect(planImageStep(tinyGif, LIMITS, 0)).toEqual({ kind: "as-is" });
  });
});
