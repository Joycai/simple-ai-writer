/**
 * Image-model parameter dialects.
 *
 * An image endpoint's framing controls are not one vocabulary: the Gemini
 * image models (Nano Banana) take an aspect *ratio* plus a resolution tier
 * (`imageConfig.aspectRatio` / `imageConfig.imageSize`), while the OpenAI
 * GPT-Image models take pixel dimensions plus a quality tier (`size` /
 * `quality`). Declaring which language a model speaks — the same move as a
 * database dialect — is what lets the UI offer exactly the choices the model
 * accepts and the request carry exactly the fields the endpoint understands,
 * instead of one lowest-common-denominator control set.
 *
 * A dialect is a *parameter* fact, deliberately separate from `ImageRoute`
 * (which endpoint shape to call): a relay can serve Nano Banana behind an
 * OpenAI-shaped URL, and each adapter already sends only the fields its wire
 * has a spelling for.
 *
 * Official parameter surfaces (calibrated 2026-08 against the vendors' docs):
 *
 * - Gemini image models: `aspectRatio` ∈ 1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16
 *   16:9 21:9; `imageSize` ∈ "1K"|"2K"|"4K" (uppercase K; tier support varies
 *   by model — omitted means the model default). No pixel-size parameter.
 * - GPT-Image models: `size` ∈ 1024x1024 | 1536x1024 | 1024x1536 | auto, and
 *   gpt-image-2 additionally accepts arbitrary WIDTHxHEIGHT with both sides
 *   divisible by 16, ratio within 1:3..3:1, at most 3840x2160 (above
 *   2560x1440 is documented as experimental). `quality` ∈ low|medium|high|auto.
 *   The *edits* endpoint documents only auto + the three presets, so an edit
 *   that requests a framing sends the closest preset, and one that doesn't
 *   sends no size — which the endpoint reads as "match the input image".
 * - Wan 2.7 (DashScope): `parameters.size` takes the square shorthands
 *   "1K"|"2K"|"4K" (1024²/2048²/4096²) or a custom `宽*高` with each side in
 *   768..4096 (wan2.7-image tops out at 2K; -pro reaches 4K; the endpoint
 *   default is 2K). Editing (0–9 input images) accepts only "1K"|"2K" or
 *   sizes within 768*768..2048*2048, and the output's aspect ratio follows
 *   the last input image — so an edit sends the tier shorthand, never a
 *   computed 宽*高 that would fight the input's framing. No negative_prompt
 *   on 2.7, and the endpoint's default n is 4 (!) — the dashscope route
 *   always sends n explicitly for exactly that reason.
 */

/** The declared dialect ids. Absent = generic (free-form size list). */
export type ImageDialect = "nanobanana" | "gpt-image-2" | "wan2.7";

/** The generic wire fields a dialect resolves the author's choices into. */
export interface ImageWireParams {
  /** OpenAI-shaped pixel size, e.g. "1536x1024". */
  size?: string;
  /** Gemini-shaped aspect ratio, e.g. "3:4". */
  aspect?: string;
  /** Gemini resolution tier ("1K" | "2K" | "4K"). */
  imageSize?: string;
  /** OpenAI quality tier ("low" | "medium" | "high"). */
  quality?: string;
}

/** What the author picked in the UI; the dialect turns it into wire fields. */
export interface ImageParamSelection {
  /**
   * Requested aspect ratio, or undefined when nobody asked for one. The
   * difference matters most on edits: an explicit aspect means "recompose to
   * this framing" and gets encoded, while absence means "follow the input
   * image" and must stay absent — a defaulted "1:1" here would silently
   * square-crop every edit of a portrait.
   */
  aspect?: string;
  /** Resolution tier from the dialect's own list. "" = the dialect default. */
  resolution?: string;
  /** Quality tier from the dialect's own list. "" = send nothing. */
  quality?: string;
}

export interface ImageDialectSpec {
  id: ImageDialect;
  /** Aspect ratios this dialect's models accept, in display order. */
  aspects: readonly string[];
  /** Resolution tiers offered. "" renders as "default" and sends nothing. */
  resolutions: readonly string[];
  /** Quality tiers offered, when the dialect has that axis at all. */
  qualities?: readonly string[];
  /**
   * Turn the author's choices into the fields the wire should carry.
   *
   * `opts.edit` marks an image-conditioned call — several dialects document a
   * narrower size vocabulary there (gpt-image-2's arbitrary sizes and Wan's
   * 宽*高 are generation-only facts), and an edit's framing follows its input
   * image anyway, so the edit variant sends less rather than gamble on a
   * value the endpoint may reject or fight over.
   */
  params(sel: ImageParamSelection, opts?: { edit?: boolean }): ImageWireParams;
}

/** The one aspect list both current dialects accept in full (Gemini's ten). */
const WIDE_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

/**
 * Short-side pixels per GPT-Image resolution tier. 1K reproduces the three
 * documented presets exactly; 2K tops out at the documented non-experimental
 * ceiling (2560x1440 at 16:9); 4K at the hard maximum (3840x2160 at 16:9).
 */
const GPT_SHORT_SIDE: Record<string, number> = { "1K": 1024, "2K": 1440, "4K": 2160 };
const GPT_MAX_LONG = 3840;

const round16 = (n: number): number => Math.max(16, Math.round(n / 16) * 16);

/**
 * Compute the gpt-image-2 pixel size for an aspect ratio and tier.
 *
 * Both sides divisible by 16 (the endpoint's own rule), long side capped at
 * 3840 — when the cap bites (21:9 at 4K), the short side shrinks to keep the
 * requested ratio rather than silently changing the framing.
 */
export function gptImageSize(aspect: string, tier: string): string {
  const [aw, ah] = aspect.split(":").map(Number);
  if (!aw || !ah) return "1024x1024";
  const ratio = Math.max(aw, ah) / Math.min(aw, ah);
  let short = GPT_SHORT_SIDE[tier] ?? GPT_SHORT_SIDE["1K"];
  let long = round16(short * ratio);
  if (long > GPT_MAX_LONG) {
    long = GPT_MAX_LONG;
    short = round16(GPT_MAX_LONG / ratio);
  }
  return aw >= ah ? `${long}x${short}` : `${short}x${long}`;
}

const NANOBANANA: ImageDialectSpec = {
  id: "nanobanana",
  aspects: WIDE_ASPECTS,
  // "" first: the model default (1K-class) is right for most runs, and older
  // revisions (gemini-2.5-flash-image) have no imageSize parameter at all —
  // sending nothing is the one request every revision accepts.
  resolutions: ["", "1K", "2K", "4K"],
  params: (sel) => ({
    // No aspect requested ⇒ no aspectRatio: a generation falls to the model
    // default, and an edit follows its input image's framing.
    ...(sel.aspect ? { aspect: sel.aspect } : {}),
    ...(sel.resolution ? { imageSize: sel.resolution } : {}),
  }),
};

const GPT_IMAGE_2: ImageDialectSpec = {
  id: "gpt-image-2",
  aspects: WIDE_ASPECTS,
  resolutions: ["1K", "2K", "4K"],
  qualities: ["low", "medium", "high"],
  params: (sel, opts) => ({
    // The aspect rides along untouched: the images route ignores it, but the
    // chat route (relay-hosted models) folds it into the prompt.
    ...(sel.aspect ? { aspect: sel.aspect } : {}),
    // A requested framing gets the exact computed size on edits too — the
    // official doc lists only presets for /images/edits, but live endpoints
    // commonly take the arbitrary sizes generations do, and the adapter
    // retries with the closest documented preset if this one is rejected
    // (see openaiEdit). An edit with NO requested aspect sends no size at
    // all, which the endpoint reads as "follow the input image" — learned
    // from a live run where an explicit "recompose to 2:3" came back in the
    // input's framing because size was dropped wholesale.
    ...(opts?.edit && !sel.aspect
      ? {}
      : { size: gptImageSize(sel.aspect ?? "1:1", sel.resolution || "1K") }),
    ...(sel.quality ? { quality: sel.quality } : {}),
  }),
};

/**
 * Side length of the square each Wan tier names (1K = 1024², …). Non-square
 * aspects keep the tier's *area*: that is what the shorthand means, and a
 * short-side rule would push 4K landscape past the 4096-per-side hard limit.
 */
const WAN_TIER_SIDE: Record<string, number> = { "1K": 1024, "2K": 2048, "4K": 4096 };
const WAN_MIN_SIDE = 768;
const WAN_MAX_SIDE = 4096;

/**
 * Compute the Wan `宽*高` for an aspect ratio and tier: the tier's pixel area
 * at the requested ratio, both sides clamped into the documented 768..4096
 * range — clamping recomputes the other side so the framing survives.
 */
export function wanImageSize(aspect: string, tier: string): string {
  const [aw, ah] = aspect.split(":").map(Number);
  if (!aw || !ah) return `${WAN_TIER_SIDE[tier] ?? 1024}*${WAN_TIER_SIDE[tier] ?? 1024}`;
  const side = WAN_TIER_SIDE[tier] ?? WAN_TIER_SIDE["1K"];
  const ratio = Math.max(aw, ah) / Math.min(aw, ah);
  let long = round16(side * Math.sqrt(ratio));
  let short = round16(side / Math.sqrt(ratio));
  if (long > WAN_MAX_SIDE) {
    long = WAN_MAX_SIDE;
    short = round16(WAN_MAX_SIDE / ratio);
  }
  if (short < WAN_MIN_SIDE) {
    short = WAN_MIN_SIDE;
    long = Math.min(WAN_MAX_SIDE, round16(WAN_MIN_SIDE * ratio));
  }
  return aw >= ah ? `${long}*${short}` : `${short}*${long}`;
}

const WAN_2_7: ImageDialectSpec = {
  id: "wan2.7",
  aspects: WIDE_ASPECTS,
  // 1K first as the cost-safe default; the endpoint's own default is 2K, and
  // 4K only exists on wan2.7-image-pro — a plain wan2.7-image answers a 4K
  // request with its own explicit error, per the caps philosophy.
  resolutions: ["1K", "2K", "4K"],
  params: (sel, opts) => {
    const tier = sel.resolution || "1K";
    const aspect = sel.aspect ? { aspect: sel.aspect } : {};
    if (opts?.edit) {
      // Editing accepts only 1K/2K, and the output's aspect ratio follows the
      // last input image — the tier shorthand is the whole vocabulary here.
      return { ...aspect, size: tier === "4K" ? "2K" : tier };
    }
    return { ...aspect, size: wanImageSize(sel.aspect ?? "1:1", tier) };
  },
};

export const IMAGE_DIALECTS: readonly ImageDialectSpec[] = [NANOBANANA, GPT_IMAGE_2, WAN_2_7];

/** The spec for a declared dialect, or null for generic / unknown values. */
export function imageDialect(id: string | undefined): ImageDialectSpec | null {
  return IMAGE_DIALECTS.find((d) => d.id === id) ?? null;
}
