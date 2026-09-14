/**
 * Whether a picture may travel to a model unchanged, and if not, what to
 * re-encode it to.
 *
 * The whole decision lives here as arithmetic, because `normalize.ts` — which
 * owns the canvas — is exactly the kind of module vitest cannot run: there is
 * no DOM in the node environment. Same split as `pptx/deck.ts` against
 * `pptx/harvest.ts`, for the same reason.
 *
 * ## Why this is a step function rather than one calculation
 *
 * JPEG's output size is not predictable from its inputs. The only way to learn
 * what quality 0.8 costs is to encode at quality 0.8 and measure — so the
 * caller loops: plan a step, encode it, hand the new byte count back, plan
 * again. Everything this module needs arrives as numbers, so every branch is
 * reachable from a test.
 *
 * ## The ladder
 *
 * | attempt | JPEG output | PNG output |
 * | --- | --- | --- |
 * | 0 | fit the long edge, quality 0.90 | fit the long edge |
 * | 1 | same size, quality 0.80 | ×0.75 |
 * | 2 | same size, quality 0.70 | ×0.75 |
 * | 3 | ×0.75, quality 0.85 | ×0.75 |
 * | 4 | give up — see below | give up |
 *
 * Quality first, pixels last: the long edge is what the author set, and
 * spending it to save bytes is a worse trade than the compression artefacts
 * nobody has ever noticed a vision model care about. PNG has no quality knob,
 * so scaling is its only lever — and an output that is PNG at all is one whose
 * source carries transparency, where JPEG is not an option.
 *
 * One rung sits outside the table: a picture with a side under
 * `MIN_IMAGE_EDGE` is *enlarged* to it first, because an endpoint refuses it
 * outright rather than merely charging for it. The ladder never scales a
 * picture back under that floor afterwards.
 *
 * "Give up" is not an error. The caller hands back the best candidate it
 * produced and lets the *existing* size check at each call site refuse it —
 * the message that check already prints is the right one, and it is now the
 * fallback rather than the first thing an author meets.
 */

import { readPref } from "../prefs";
import { MAX_IMAGE_BYTES } from "../fs/images";

/** Where the author's long-edge ceiling is stored. */
export const IMAGE_LONG_EDGE_KEY = "app:imageMaxLongEdge";

/**
 * The default ceiling on a picture's long edge, in pixels.
 *
 * 4096 is deliberately high. Most vision endpoints resize harder than this on
 * their own side (Anthropic's guidance is ~1568), so a lower default would
 * only be doing work the server was going to do anyway — while the cost of
 * being wrong lands entirely on the author: reading a screenshot, a scanned
 * table, the detail on a character's costume. Those are the first things a
 * downscale destroys, and `lore/LoreDetail.tsx` already carries a comment
 * refusing a downscaled copy for exactly that reason.
 *
 * So the number is set to catch only what is genuinely anomalous — a 4096²
 * generation-model output, a full-page screenshot, a scan — and to leave an
 * ordinary phone photo (iPhone's main camera: 4032×3024) untouched to the
 * pixel. Authors who would rather spend detail for tokens lower it themselves;
 * that is what makes it a setting.
 */
export const DEFAULT_IMAGE_LONG_EDGE = 4096;

/** Bounds for the setting — a free number field, but not a nonsense one. */
export const IMAGE_LONG_EDGE_MIN = 256;
export const IMAGE_LONG_EDGE_MAX = 16384;

/** The ceilings one normalization run works against. */
export interface ImageLimits {
  /** Longest permitted edge in pixels; 0 means "no opinion, bytes only". */
  longEdge: number;
  maxBytes: number;
}

/** What the payload looks like right now — the original file on attempt 0. */
export interface ImageState {
  width: number;
  height: number;
  bytes: number;
  /** What a re-encode of *this* picture would produce. Fixed for the run. */
  mime: "image/jpeg" | "image/png";
  /** Animated pictures are never re-encoded; a canvas would flatten them. */
  animated: boolean;
}

type ImageStep =
  | { kind: "as-is" }
  | { kind: "encode"; width: number; height: number; mime: string; quality?: number }
  /** The ladder is spent and it still doesn't fit. */
  | { kind: "give-up" };

/** Quality per attempt. The last entry pairs with the first pixel reduction. */
const QUALITY_LADDER = [0.9, 0.8, 0.7, 0.85] as const;
/** How much of the long edge one pixel-reduction round keeps. */
const SCALE_STEP = 0.75;
/** Encodes attempted before giving up. */
export const MAX_ENCODE_ATTEMPTS = QUALITY_LADDER.length;

/**
 * The author's ceiling, read at call time.
 *
 * A preference rather than a threaded argument, for the same reason
 * `modelLimits.defaultMaxOutput()` is one: every path that sends a picture
 * would otherwise have to carry it, and the one that forgot would quietly
 * disagree with the others about how big an image may be.
 */
export function imageMaxLongEdge(): number {
  const raw = readPref(IMAGE_LONG_EDGE_KEY);
  if (raw === null) return DEFAULT_IMAGE_LONG_EDGE;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0; // explicit "don't resize"
  return Math.min(Math.max(n, IMAGE_LONG_EDGE_MIN), IMAGE_LONG_EDGE_MAX);
}

/** Both ceilings, resolved. */
export function imageLimits(): ImageLimits {
  return { longEdge: imageMaxLongEdge(), maxBytes: MAX_IMAGE_BYTES };
}

/**
 * The shortest edge any endpoint has been seen to accept, in pixels.
 *
 * Measured, not guessed: DashScope's qwen3-vl-plus answers a 9×9 PNG with a
 * 400 (`height:9 or width:9 must be larger than 10`) and takes 10×10 and
 * 200×10 (docs/api/landscape.md, 第六个样本). A tiny picture is a real thing an
 * author sends — an icon, a colour swatch, a cropped glyph — and "the endpoint
 * refused it" is not an answer they can act on, so the reader enlarges it
 * instead. Enlarging destroys nothing: every pixel the source had survives.
 *
 * Not per-provider for the reason the long edge isn't (see
 * image-normalize-plan.md §2.2): a relay hides who is behind it, and ten
 * pixels costs every other endpoint nothing.
 */
export const MIN_IMAGE_EDGE = 10;

/**
 * The long edge a picture of this shape may end up with.
 *
 * Normally the author's ceiling. But a picture so elongated that meeting the
 * ceiling would push its short side under `MIN_IMAGE_EDGE` gets the long edge
 * its aspect ratio demands at the floor instead: the floor is an endpoint's
 * hard refusal, the ceiling is a preference about tokens, and squashing the
 * aspect to honour both would hand the model a distorted picture. So the
 * floor wins, and the long edge overshoots the ceiling by exactly as much as
 * the shape requires — which, for anything that elongated, is still a small
 * number of pixels in total.
 */
function longEdgeCeiling(width: number, height: number, limits: ImageLimits): number {
  if (limits.longEdge <= 0) return Infinity;
  const long = Math.max(width, height);
  const short = Math.max(1, Math.min(width, height));
  return Math.max(limits.longEdge, Math.ceil((long * MIN_IMAGE_EDGE) / short));
}

/** True when the payload may travel exactly as it is. */
export function fitsLimits(
  state: Pick<ImageState, "width" | "height" | "bytes">,
  limits: ImageLimits,
): boolean {
  const aboveFloor = Math.min(state.width, state.height) >= MIN_IMAGE_EDGE;
  const withinEdge =
    Math.max(state.width, state.height) <= longEdgeCeiling(state.width, state.height, limits);
  return aboveFloor && withinEdge && state.bytes <= limits.maxBytes;
}

/** Round a scaled edge, never to zero. */
function scaled(px: number, factor: number): number {
  return Math.max(1, Math.round(px * factor));
}

/**
 * The next thing to do about this picture. `attempt` counts encodes already
 * performed, so the first call passes 0.
 */
export function planImageStep(
  state: ImageState,
  limits: ImageLimits,
  attempt: number,
): ImageStep {
  if (state.animated) return { kind: "as-is" };
  if (fitsLimits(state, limits)) return { kind: "as-is" };
  if (attempt >= MAX_ENCODE_ATTEMPTS) return { kind: "give-up" };

  const jpeg = state.mime === "image/jpeg";
  const quality = jpeg ? QUALITY_LADDER[Math.min(attempt, QUALITY_LADDER.length - 1)] : undefined;
  const long = Math.max(state.width, state.height);
  const short = Math.min(state.width, state.height);

  if (short < MIN_IMAGE_EDGE) {
    // Under the floor: enlarge until the short side sits exactly on it. Set
    // directly rather than through a factor, because 10/3×3 is not reliably 10
    // in floating point, and rounding the long side *up* is what keeps the
    // aspect from narrowing past what the source had. Nothing else is over —
    // a picture this small is never the one over on bytes or on the ceiling.
    const grown = Math.ceil((long * MIN_IMAGE_EDGE) / short);
    const wide = state.width >= state.height;
    return {
      kind: "encode",
      width: wide ? grown : MIN_IMAGE_EDGE,
      height: wide ? MIN_IMAGE_EDGE : grown,
      mime: state.mime,
      quality,
    };
  }

  const ceiling = longEdgeCeiling(state.width, state.height, limits);
  const overEdge = long > ceiling;

  let factor: number;
  if (overEdge) {
    // The long edge is the stated ceiling — meet it exactly, at top quality,
    // before spending anything else. (`ceiling` already lifts itself for a
    // shape the floor would otherwise be cut by.)
    factor = ceiling / long;
  } else if (!jpeg || attempt >= QUALITY_LADDER.length - 1) {
    // Only bytes are over, and there is no quality left to give: PNG never had
    // any, and JPEG has reached the end of the ladder. Pixels are the lever
    // left — but only down to the floor, and a picture already on it has
    // nothing left to give at all.
    factor = Math.max(SCALE_STEP, MIN_IMAGE_EDGE / short);
    if (factor >= 1) return { kind: "give-up" };
  } else {
    // JPEG, within the edge, over on bytes: this round is a quality step.
    factor = 1;
  }

  return {
    kind: "encode",
    width: scaled(state.width, factor),
    height: scaled(state.height, factor),
    mime: state.mime,
    quality,
  };
}
