import type { ImageRoute } from "./types";
import { effectiveImageRoute } from "./imageRoute";
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
 * - Qwen-Image 3.0 (DashScope, live-probed 2026-09-04): `parameters.size` takes
 *   **only** `宽*高` — the tier shorthand answers `400 InvalidParameter` — with
 *   the total pixel count in 512²..2048² (a side may exceed 2048: 2720*1536
 *   was accepted). Billing is by *area* tier (1K ≈ 1024², 2K ≈ 2048², at
 *   double the price), and an omitted size renders — and bills — at 2K. So
 *   this dialect always sends a size, defaulting to the 1K area; an edit
 *   without a requested aspect takes its ratio from the input image, because
 *   the endpoint's own "follow the input" (no size) is also its 2K default.
 * - Seedream (火山方舟, docs checked 2026-09-18): `size` is a tier ("2K") *or*
 *   `WxH`, never both. With a tier alone the model picks the ratio from the
 *   prompt (5.0 pro at 1K answered 1248x832 unasked), so a requested aspect is
 *   sent as the documented pixels for that tier × ratio — looked up, not
 *   computed, because the tiers are not one formula (5.0 pro's 2K 16:9 is
 *   2816x1584, lite's is 2848x1600) and `WxH` is bounded by *total pixels*
 *   per version (lite's floor is 2560x1440, so a computed 1K size would 400).
 *   Tiers differ by version: 5.0 pro 1K/1.5K/2K, 5.0 lite 2K/3K/4K, 4.5 2K/4K,
 *   4.0 1K/2K/4K (its 1K row disagrees between two doc pages, so the 4.x
 *   dialect offers only the tiers both versions share). Billing is per
 *   picture, not per tier.
 */

/** The declared dialect ids. Absent = generic (free-form size list). */
export type ImageDialect =
  | "generic" | "nanobanana-2" | "nanobanana" | "gpt-image-2" | "gpt-image-2.5" | "grok-imagine" | "wan2.7" | "qwen-image"
  | "seedream-5-pro" | "seedream-5-lite" | "seedream-4";

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
  /** Native fields for an OpenAI-shaped images endpoint, e.g. xAI. */
  extraBody?: Record<string, unknown>;
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
  sizingMode?: ImageSizingMode;
  size?: string;
}

export type ImageSizingMode = "ratio" | "exact";

export interface ImagePixelConstraints {
  step?: number;
  minEdge?: number;
  maxEdge?: number;
  minPixels?: number;
  maxPixels?: number;
  maxRatio?: number;
}

/** Per-model menus replace preset menus; absent fields inherit the preset. */
export interface ImageCapabilityOverrides {
  modes?: ImageSizingMode[];
  aspects?: string[];
  resolutions?: string[];
  qualities?: string[];
  pixels?: ImagePixelConstraints;
}

interface ImageOutputCaps {
  dialect?: ImageDialect;
  overrides?: ImageCapabilityOverrides;
  defaults?: ImageParamSelection;
}

interface ImageOutputSpec {
  modes: readonly ImageSizingMode[];
  aspects: readonly string[];
  resolutions: readonly string[];
  qualities: readonly string[];
  pixels: ImagePixelConstraints;
}

/** Menus and validation are shared by configuration, the dialog and callers. */
export function imageOutputSpec(caps?: ImageOutputCaps): ImageOutputSpec {
  const preset = imageDialect(caps?.dialect);
  const overrides = caps?.overrides;
  return {
    modes: overrides?.modes ?? preset?.modes ?? (!preset ? ["ratio", "exact"] : ["ratio"]),
    aspects: overrides?.aspects ?? preset?.aspects ?? WIDE_ASPECTS,
    resolutions: overrides?.resolutions ?? preset?.resolutions ?? [""],
    qualities: overrides?.qualities ?? preset?.qualities ?? [],
    pixels: { ...preset?.pixels, ...overrides?.pixels },
  };
}

/** Explicit blanks mean endpoint default; only undefined inherits a model default. */
export function imageSelection(caps: ImageOutputCaps | undefined, selection: ImageParamSelection): ImageParamSelection {
  const spec = imageOutputSpec(caps);
  const result = { ...caps?.defaults };
  for (const key of ["aspect", "resolution", "quality", "size", "sizingMode"] as const) {
    if (selection[key] !== undefined) Object.assign(result, { [key]: selection[key] });
  }
  if (selection.sizingMode === undefined && (selection.aspect !== undefined || selection.resolution !== undefined)) result.sizingMode = "ratio";
  result.sizingMode ??= spec.modes[0];
  // Inactive fields must not influence requests or billing.
  if (result.sizingMode === "exact") {
    delete result.aspect;
    delete result.resolution;
  } else {
    delete result.size;
  }
  return result;
}

type ImageOutputError = "mode" | "aspect" | "resolution" | "quality" | "dimensions" | "step" | "edge" | "pixels" | "ratio";

export class ImageOutputValidationError extends Error {
  constructor(readonly code: ImageOutputError) {
    super(`Invalid image output parameter: ${code}`);
    this.name = "ImageOutputValidationError";
  }
}

export function validateImageSelection(caps: ImageOutputCaps | undefined, sel: ImageParamSelection, checkMode = true): ImageOutputError | undefined {
  const spec = imageOutputSpec(caps);
  if (checkMode && sel.sizingMode && !spec.modes.includes(sel.sizingMode)) return "mode";
  if (sel.sizingMode === "exact" && (caps?.dialect === "nanobanana" || caps?.dialect === "nanobanana-2" || caps?.dialect === "grok-imagine")) return "mode";
  if (sel.quality && !spec.qualities.includes(sel.quality)) return "quality";
  if (sel.sizingMode !== "exact") {
    // Legacy callers retain dialect fallback behaviour; overrides are strict.
    if (sel.aspect && caps?.overrides?.aspects && !spec.aspects.includes(sel.aspect)) return "aspect";
    if (sel.resolution && caps?.overrides?.resolutions && !spec.resolutions.includes(sel.resolution)) return "resolution";
    return undefined;
  }
  const match = /^(\d+)[x*](\d+)$/.exec(sel.size?.trim() ?? "");
  if (!match) return "dimensions";
  const [w, h] = match.slice(1).map(Number);
  if (![w, h].every((n) => Number.isSafeInteger(n) && n > 0)) return "dimensions";
  const p = spec.pixels;
  if (p.step && (w % p.step || h % p.step)) return "step";
  if ((p.minEdge && Math.min(w, h) < p.minEdge) || (p.maxEdge && Math.max(w, h) > p.maxEdge)) return "edge";
  if ((p.minPixels && w * h < p.minPixels) || (p.maxPixels && w * h > p.maxPixels)) return "pixels";
  if (p.maxRatio && Math.max(w, h) / Math.min(w, h) > p.maxRatio) return "ratio";
  return undefined;
}

/** Reject inconsistent editable configuration before saving, without paid probes. */
export function validateImageOutputConfig(caps: ImageOutputCaps): ImageOutputError | undefined {
  const spec = imageOutputSpec(caps);
  const p = spec.pixels;
  if (!spec.modes.length) return "mode";
  // Gemini has no pixel-size field. An override cannot invent an API spelling.
  if ((caps.dialect === "nanobanana" || caps.dialect === "nanobanana-2" || caps.dialect === "grok-imagine") && spec.modes.includes("exact")) return "mode";
  if (spec.aspects.some((a) => a !== "auto" && (!/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(a) || a.split(":").some((n) => Number(n) <= 0)))) return "aspect";
  const preset = imageDialect(caps.dialect);
  // Table-backed/computed dialects cannot gain tiers without a conversion rule.
  if (preset && caps.dialect !== "nanobanana" && caps.dialect !== "grok-imagine" && spec.resolutions.some((r) => r && !preset.resolutions.includes(r))) return "resolution";
  for (const [key, n] of Object.entries(p)) {
    if (!Number.isFinite(n) || n < 1 || (key !== "maxRatio" && !Number.isSafeInteger(n))) return "dimensions";
  }
  if (p.minEdge && p.maxEdge && p.minEdge > p.maxEdge) return "edge";
  if (p.minPixels && p.maxPixels && p.minPixels > p.maxPixels) return "pixels";
  const defaults = caps.defaults;
  if (!defaults) return undefined;
  if (defaults.aspect && !spec.aspects.includes(defaults.aspect)) return "aspect";
  if (defaults.resolution && !spec.resolutions.includes(defaults.resolution)) return "resolution";
  if (defaults.quality && !spec.qualities.includes(defaults.quality)) return "quality";
  if (defaults.size) {
    const error = validateImageSelection(caps, { sizingMode: "exact", size: defaults.size });
    if (error) return error;
  }
  return validateImageSelection(caps, imageSelection(caps, {}));
}

/** Untrusted config backups are narrowed field by field, including empty menus. */
export function parseImageOutputCaps(raw: Record<string, unknown>): Pick<ImageOutputCaps, "overrides" | "defaults"> {
  const result: Pick<ImageOutputCaps, "overrides" | "defaults"> = {};
  const object = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
  const o = object(raw.overrides);
  if (o) {
    const overrides: ImageCapabilityOverrides = {};
    for (const key of ["aspects", "resolutions", "qualities"] as const) {
      if (Array.isArray(o[key])) overrides[key] = [...new Set(o[key].filter((v): v is string => typeof v === "string"))];
    }
    if (Array.isArray(o.modes)) {
      const modes = o.modes.filter((v): v is ImageSizingMode => v === "ratio" || v === "exact");
      if (modes.length) overrides.modes = [...new Set(modes)];
    }
    const p = object(o.pixels);
    if (p) {
      const pixels: ImagePixelConstraints = {};
      for (const key of ["step", "minEdge", "maxEdge", "minPixels", "maxPixels", "maxRatio"] as const) {
        const n = p[key];
        if (typeof n === "number" && Number.isFinite(n) && n > 0 && (key === "maxRatio" ? n >= 1 : Number.isSafeInteger(n))) pixels[key] = n;
      }
      if (Object.keys(pixels).length) overrides.pixels = pixels;
    }
    if (Object.keys(overrides).length) result.overrides = overrides;
  }
  const d = object(raw.defaults);
  if (d) {
    const defaults: ImageParamSelection = {};
    for (const key of ["aspect", "resolution", "quality", "size"] as const) {
      if (typeof d[key] === "string") defaults[key] = d[key];
    }
    if (d.sizingMode === "ratio" || d.sizingMode === "exact") defaults.sizingMode = d.sizingMode;
    if (Object.keys(defaults).length) result.defaults = defaults;
  }
  return result;
}

export interface ImageDialectSpec {
  id: ImageDialect;
  modes?: readonly ImageSizingMode[];
  pixels?: ImagePixelConstraints;
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
  params(sel: ImageParamSelection, opts?: ImageParamOptions): ImageWireParams;
}

/** Facts about the call that are not the author's choices. */
export interface ImageParamOptions {
  /** An image-conditioned call (edit, or a generation with references). */
  edit?: boolean;
  /**
   * Pixel size of the image being edited, when the caller could read it off
   * the bytes. Lets a dialect whose endpoint has no "follow the input" spelling
   * (qwen-image: omitting size means 2K) keep the input's framing at the
   * requested tier. Absent ⇒ the dialect sends what it can without it.
   */
  inputSize?: { width: number; height: number };
}

/** The one aspect list both current dialects accept in full (Gemini's ten). */
const WIDE_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

/**
 * Short-side pixels per GPT-Image resolution tier. 1K reproduces the three
 * documented presets exactly; 2K tops out at the documented non-experimental
 * ceiling (2560x1440 at 16:9); 4K at the hard maximum (3840x2160 at 16:9).
 */
// 1.5K is an app convenience tier (1280 short-side), not an API enum.
const GPT_SHORT_SIDE: Record<string, number> = { "1K": 1024, "1.5K": 1280, "2K": 1440, "4K": 2160 };
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

// Gemini 3.1 Flash Image: the model-specific tier and ratios are not valid for all Gemini images.
const NANOBANANA_2: ImageDialectSpec = {
  ...NANOBANANA,
  id: "nanobanana-2",
  resolutions: ["1K", "2K", "4K", "512"],
  aspects: [...WIDE_ASPECTS, "1:4", "4:1", "1:8", "8:1"],
};

const GPT_IMAGE_2: ImageDialectSpec = {
  id: "gpt-image-2",
  modes: ["ratio", "exact"],
  pixels: { step: 16, maxEdge: 3840, maxPixels: 3840 * 2160, maxRatio: 3 },
  aspects: WIDE_ASPECTS,
  resolutions: ["1K", "1.5K", "2K", "4K"],
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
      : { size: gptImageSize(sel.aspect || "1:1", sel.resolution || "1K") }),
    ...(sel.quality ? { quality: sel.quality } : {}),
  }),
};

// Official API reference checked 2026-10-14: 2.5 additionally accepts xhigh/max.
const GPT_IMAGE_2_5: ImageDialectSpec = {
  ...GPT_IMAGE_2, id: "gpt-image-2.5", qualities: ["low", "medium", "high", "xhigh", "max"],
};

// xAI's native fields live in extraBody, never in Gemini's imageConfig.
const GROK_IMAGINE: ImageDialectSpec = {
  id: "grok-imagine",
  aspects: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "21:9", "5:2"],
  resolutions: ["", "1K", "2K"],
  qualities: ["low", "medium", "auto"],
  params: (sel) => ({
    ...(sel.aspect ? { aspect: sel.aspect } : {}),
    extraBody: {
      ...(sel.aspect ? { aspect_ratio: sel.aspect } : {}),
      ...(sel.resolution ? { resolution: sel.resolution.toLowerCase() } : {}),
    },
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
  modes: ["ratio", "exact"],
  pixels: { minEdge: 768, maxEdge: 4096 },
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

/** Side of the square each Qwen-Image tier names; the tier is an *area*. */
const QWEN_TIER_SIDE: Record<string, number> = { "1K": 1024, "2K": 2048 };
/** The endpoint's hard ceiling on total pixels (2048²) — the 2K tier sits exactly on it. */
const QWEN_MAX_PIXELS = 2048 * 2048;

const floor16 = (n: number): number => Math.max(16, Math.floor(n / 16) * 16);

/**
 * Compute the Qwen-Image `宽*高` for an aspect ratio and tier: the tier's area
 * at the requested ratio. Sides are floored to 16 rather than rounded, because
 * the 2K tier *is* the endpoint's pixel ceiling and rounding up on both sides
 * lands 21:9 a few thousand pixels over it — a paid-for 400.
 */
export function qwenImageSize(aspect: string, tier: string): string {
  const side = QWEN_TIER_SIDE[tier] ?? QWEN_TIER_SIDE["1K"];
  const [aw, ah] = aspect.split(":").map(Number);
  if (!aw || !ah) return `${side}*${side}`;
  const ratio = Math.max(aw, ah) / Math.min(aw, ah);
  let long = floor16(side * Math.sqrt(ratio));
  let short = floor16(side / Math.sqrt(ratio));
  while (long * short > QWEN_MAX_PIXELS) {
    long -= 16;
    short = floor16(long / ratio);
  }
  return aw >= ah ? `${long}*${short}` : `${short}*${long}`;
}

const QWEN_IMAGE: ImageDialectSpec = {
  id: "qwen-image",
  modes: ["ratio", "exact"],
  pixels: { minPixels: 512 * 512, maxPixels: 2048 * 2048 },
  aspects: WIDE_ASPECTS,
  // 1K first and no "default" entry: the endpoint's default is the 2K tier at
  // twice the price, so "send nothing" is the one choice this dialect never
  // offers.
  resolutions: ["1K", "2K"],
  params: (sel, opts) => {
    const tier = sel.resolution || "1K";
    const aspect = sel.aspect ? { aspect: sel.aspect } : {};
    if (sel.aspect) return { ...aspect, size: qwenImageSize(sel.aspect, tier) };
    if (opts?.edit) {
      // No aspect asked for on an edit means "keep the input's framing". The
      // endpoint spells that as "omit size" — which also means 2K, at twice
      // the price — so the input's own ratio is re-spelled at the requested
      // tier instead. With no dimensions to hand, a square at the requested
      // tier: a framing the author may not have wanted costs less than a
      // silent doubling of the bill (size is never omitted on this dialect).
      const input = opts.inputSize;
      if (!input?.width || !input?.height) return { size: qwenImageSize("1:1", tier) };
      return { size: qwenImageSize(`${input.width}:${input.height}`, tier) };
    }
    return { size: qwenImageSize("1:1", tier) };
  },
};

/** The ratios every Seedream version documents pixels for, in display order. */
const SEEDREAM_ASPECTS = ["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9"] as const;

type SeedreamTable = Record<string, Record<(typeof SEEDREAM_ASPECTS)[number], string>>;

/** One tier's documented pixels, listed in SEEDREAM_ASPECTS order. */
const row = (...sizes: string[]): Record<(typeof SEEDREAM_ASPECTS)[number], string> =>
  Object.fromEntries(SEEDREAM_ASPECTS.map((a, i) => [a, sizes[i]])) as Record<(typeof SEEDREAM_ASPECTS)[number], string>;

// 「图片生成 API」参考页 + 5.0 pro 教程的「档位 × 比例」常见值 (2026-09-18).
const SEEDREAM_2K = row("2048x2048", "1728x2304", "2304x1728", "1664x2496", "2496x1664", "1600x2848", "2848x1600", "3136x1344");
const SEEDREAM_4K = row("4096x4096", "3520x4704", "4704x3520", "3328x4992", "4992x3328", "3040x5504", "5504x3040", "6240x2656");
const SEEDREAM_PRO: SeedreamTable = {
  "1K": row("1024x1024", "864x1152", "1152x864", "832x1248", "1248x832", "800x1424", "1424x800", "1568x672"),
  "1.5K": row("1536x1536", "1344x1792", "1792x1344", "1248x1872", "1872x1248", "1152x2048", "2048x1152", "2352x1008"),
  "2K": row("2048x2048", "1776x2368", "2368x1776", "1664x2496", "2496x1664", "1584x2816", "2816x1584", "3136x1344"),
};
const SEEDREAM_LITE: SeedreamTable = {
  "2K": SEEDREAM_2K,
  "3K": row("3072x3072", "2592x3456", "3456x2592", "2496x3744", "3744x2496", "2304x4096", "4096x2304", "4704x2016"),
  "4K": SEEDREAM_4K,
};
const SEEDREAM_4X: SeedreamTable = { "2K": SEEDREAM_2K, "4K": SEEDREAM_4K };

/** "1.5K" → 1.5. The half tier is why this is not a `\d+K` match. */
const tierValue = (tier: string): number => Number.parseFloat(tier);

/**
 * The tier to send for a requested one: itself when this version has it, else
 * the nearest (the lower on a tie). The agent's tools only know 1K/2K/4K, and a
 * tier a version lacks is a 400 — nearer beats refusing. "" = 2K, the one tier
 * every version has and the endpoint's own default.
 */
function seedreamTier(requested: string | undefined, tiers: readonly string[]): string {
  const want = requested || "2K";
  if (tiers.includes(want)) return want;
  const v = tierValue(want);
  if (!Number.isFinite(v)) return tiers.includes("2K") ? "2K" : tiers[0];
  let best = tiers[0];
  for (const t of tiers) if (Math.abs(tierValue(t) - v) < Math.abs(tierValue(best) - v)) best = t;
  return best;
}

function seedreamDialect(id: ImageDialect, table: SeedreamTable): ImageDialectSpec {
  const tiers = Object.keys(table);
  return {
    id,
    modes: ["ratio", "exact"],
    pixels: id === "seedream-5-pro"
      ? { minPixels: 921600, maxPixels: 4624220 }
      : { minPixels: 3686400, maxPixels: 16777216 },
    aspects: SEEDREAM_ASPECTS,
    resolutions: tiers,
    params: (sel) => {
      const tier = seedreamTier(sel.resolution, tiers);
      const pixels = sel.aspect ? table[tier][sel.aspect as (typeof SEEDREAM_ASPECTS)[number]] : undefined;
      // A requested ratio is the documented pixels for it; no ratio (an edit
      // following its input, or an agent call that named none) is the bare
      // tier. A ratio outside the table (the agent's 4:5) is the tier too —
      // never a computed size that could fall outside the version's pixel range.
      return { ...(sel.aspect ? { aspect: sel.aspect } : {}), size: pixels ?? tier };
    },
  };
}

const SEEDREAM_5_PRO = seedreamDialect("seedream-5-pro", SEEDREAM_PRO);
const SEEDREAM_5_LITE = seedreamDialect("seedream-5-lite", SEEDREAM_LITE);
const SEEDREAM_4 = seedreamDialect("seedream-4", SEEDREAM_4X);

/** Declared dialects that only exist behind the ark route (火山方舟). */

export const IMAGE_DIALECTS: readonly ImageDialectSpec[] = [
  NANOBANANA, NANOBANANA_2, GPT_IMAGE_2, GPT_IMAGE_2_5, GROK_IMAGINE, WAN_2_7, QWEN_IMAGE, SEEDREAM_5_PRO, SEEDREAM_5_LITE, SEEDREAM_4,
];

/** The spec for a declared dialect, or null for generic / unknown values. */
export function imageDialect(id: string | undefined): ImageDialectSpec | null {
  return IMAGE_DIALECTS.find((d) => d.id === id) ?? null;
}

/**
 * Whether the model can keep an edit's background transparent — Seedream's
 * `background: "transparent"` on the ark route. Read off the dialect rather
 * than declared: `seedream-5-pro` is exactly 5.0 pro and flash, the two
 * versions that take the field (5.0 lite and 4.x have dialects of their own),
 * so the answer follows every row that speaks it — starter rows added before
 * this existed, hand-added rows, and rows re-saved from the model drawer,
 * which rebuilds caps from its form and would drop a declaration it has no
 * control for (docs/feature/image-generation-plan.md PR7, 09-23 增补).
 */
export function keepsTransparentBackground(caps: { route?: ImageRoute; dialect?: ImageDialect } | undefined): boolean {
  return effectiveImageRoute("openai", caps) === "ark" && caps?.dialect === "seedream-5-pro";
}
