/**
 * Video as model input: who may receive a clip, how its part is spelled, and
 * roughly what it costs. Pure — the reader that turns a file into a data URL
 * lives in `lib/fs/video.ts`.
 *
 * Every number here was measured on DashScope compatible-mode Chat
 * Completions, 2026-09-14 (docs/feature/video-input.md,
 * docs/api/landscape.md §7 第六个样本「视觉理解」). None of it is a vendor
 * promise; the token figure in particular is an *estimate* and is labelled ≈
 * wherever it is shown.
 */

import type { Model } from "./configDb";
import { familyOf, type ApiStandard, type ContentPart } from "./types";
import { providerWire, wireTakesQwenVisionParams } from "./platforms";

/** Lowest `fps` the settings field accepts. Only 0.5–4 were measured. */
export const MIN_VIDEO_FPS = 0.1;
/** Highest `fps` the settings field accepts. Only 0.5–4 were measured. */
export const MAX_VIDEO_FPS = 10;
/** What the endpoint samples at when no `fps` is sent (inferred from token counts). */
export const DEFAULT_VIDEO_FPS = 2;

/**
 * A stored or typed fps, made safe to send — or `undefined` for "send nothing".
 *
 * Out-of-range values are clamped rather than dropped: an author who typed 20
 * meant "a lot", and 10 is the closest thing the field allows. Two decimals is
 * more precision than any endpoint documents.
 */
export function clampVideoFps(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(Math.min(MAX_VIDEO_FPS, Math.max(MIN_VIDEO_FPS, n)) * 100) / 100;
}

/**
 * Whether a chat request to this model may carry a `video_url` part.
 *
 * Three conditions, all required: the author declared it (no probe can ask
 * without spending a real clip), the model reads pictures at all, and the
 * provider speaks Chat Completions. The last is not a formality — on
 * DashScope's Responses surface qwen3-vl-plus is `Unsupported model`, and a
 * `video_url` part there once came back as an empty answer with no error; the
 * Gemini and Anthropic adapters have no spelling for the part. Gating here is
 * what keeps a clip off those wires; their named throw is only the backstop.
 */
export function canReadVideo(
  model: Pick<Model, "type" | "videoInput"> | null | undefined,
  standard: ApiStandard | null | undefined,
): boolean {
  if (!model || !standard || !model.videoInput) return false;
  if (model.type !== "multimodal" && model.type !== "vision") return false;
  return familyOf(standard) === "openai";
}

/**
 * The `fps` a clip to this model actually carries: its declared value where the
 * wire reads DashScope's knob, else none — 智谱 reads the clip but ignores the
 * field (same tokens at 0.5 and 2, landscape.md §7 第十四个样本), so sending it
 * or estimating by it would only misstate the bill.
 */
export function sentVideoFps(
  model: Pick<Model, "videoFps"> | null | undefined,
  provider: Parameters<typeof providerWire>[0] | null | undefined,
): number | undefined {
  if (!model || !provider) return undefined;
  return wireTakesQwenVisionParams(providerWire(provider)) ? model.videoFps : undefined;
}

/** The one builder for a clip's content part. `fps` absent = endpoint default. */
export function videoPart(url: string, fps?: number): ContentPart {
  const f = clampVideoFps(fps);
  return f === undefined
    ? { type: "video_url", video_url: { url } }
    : { type: "video_url", video_url: { url }, fps: f };
}

/**
 * Per-frame-pair token ceiling, measured on a 1280×720 clip (594 per pair at
 * every fps tried). The endpoint shrinks larger frames to a pixel budget, so
 * other aspect ratios land near — not exactly on — this number.
 */
const VIDEO_UNIT_TOKEN_CAP = 594;
/** The endpoint samples at least this many frames, however short or sparse the clip. */
const MIN_VIDEO_FRAMES = 4;
/** Fixed overhead per clip (start/end markers) seen in every measurement. */
const VIDEO_TOKEN_OVERHEAD = 2;

/**
 * Roughly how many input tokens one clip costs — **an estimate**.
 *
 * The model that reproduces every 2026-09-14 measurement on qwen3-vl-plus:
 * frames = round(duration × fps), at least 4, rounded up to even (frames are
 * merged in pairs); each pair costs one token per 32×32 block of the frame
 * (each side rounded to a multiple of 32), capped at 594; plus 2.
 *
 *   640×480 25fps source: 2 s → 602, 3 s → 902
 *   320×240: 3 s → 242, 6 s → 482; 6 s at fps 1 → 242, at fps 0.5 → 162
 *   1280×720 60 s: default → 35,642, fps 4 → 71,282, fps 0.5 → 8,912
 *
 * Other models (qwen3-vl-flash, qwen3.8-flash) were not measured for tokens.
 * Returns null when the duration or frame size is unknown — a WebM, or an MP4
 * whose header could not be parsed — because a guess shown as ≈ would be read
 * as a measurement.
 */
export function estimateVideoTokens(input: {
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
}): number | null {
  const { durationSec, width, height } = input;
  if (!durationSec || !width || !height || durationSec <= 0 || width <= 0 || height <= 0) return null;
  const fps = clampVideoFps(input.fps) ?? DEFAULT_VIDEO_FPS;
  let frames = Math.max(MIN_VIDEO_FRAMES, Math.round(durationSec * fps));
  if (frames % 2 === 1) frames += 1;
  const blocks = Math.max(1, Math.round(width / 32)) * Math.max(1, Math.round(height / 32));
  const perPair = Math.min(blocks, VIDEO_UNIT_TOKEN_CAP);
  return (frames / 2) * perPair + VIDEO_TOKEN_OVERHEAD;
}
