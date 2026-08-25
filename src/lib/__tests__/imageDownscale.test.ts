/**
 * The ladder that decides what happens to an oversized picture on its way to a
 * model. Everything here is arithmetic on purpose — `normalize.ts` owns the
 * canvas, and vitest's node environment has none — so these are the tests that
 * can exist at all for this feature.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let prefValue: string | null = null;
vi.mock("../prefs", () => ({
  readPref: vi.fn(() => prefValue),
  writePref: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(async () => new Uint8Array()) }));
vi.mock("../fs/fileio", () => ({ readFile: vi.fn(async () => ""), readDir: vi.fn(async () => []) }));

const {
  DEFAULT_IMAGE_LONG_EDGE, IMAGE_LONG_EDGE_MAX, IMAGE_LONG_EDGE_MIN, MAX_ENCODE_ATTEMPTS,
  fitsLimits, imageMaxLongEdge, planImageStep,
} = await import("../image/downscalePlan");
const { MAX_IMAGE_BYTES } = await import("../fs/images");

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

  it("never rounds an edge down to nothing", () => {
    const sliver = withAlpha(3, 1, 30 * MB);
    expect(planImageStep(sliver, LIMITS, 0)).toMatchObject({ width: 2, height: 1 });
  });
});
