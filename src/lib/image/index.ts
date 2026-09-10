/**
 * Image generation domain: prompt building (./promptGen), size negotiation and
 * usage accounting. The wire client itself lives in lib/ai/image.ts alongside
 * the other provider adapters.
 */

import { imageCostFor, type ImageCaps, type Model } from "../ai/configDb";
import { imageDialect, type ImageParamOptions, type ImageWireParams } from "../ai/imageDialects";
import { readImageHeader } from "./imageSize";
import { getDb } from "../project";
import type { ImageAspect } from "./promptGen";

export * from "./promptGen";

/**
 * Resolve the author's framing choices into the wire fields one request should
 * carry, honouring the model's declared parameter dialect.
 *
 * With a dialect declared, the dialect table decides (Gemini's ratio +
 * imageSize, or GPT-Image's computed pixel size + quality). Without one, the
 * pre-dialect behaviour stands: an explicit size wins, else the closest of the
 * model's declared sizes, else no size at all — and the aspect rides along for
 * the routes that can express it.
 */
export function imageRequestParams(
  caps: ImageCaps | undefined,
  sel: { aspect?: string; resolution?: string; quality?: string; size?: string },
  /** `edit` marks an image-conditioned call — see ImageDialectSpec.params. */
  opts?: ImageParamOptions,
): ImageWireParams {
  const spec = imageDialect(caps?.dialect);
  if (spec) return spec.params(sel, opts);
  return {
    aspect: sel.aspect,
    size: sel.size?.trim() || sizeForAspect(sel.aspect ?? "1:1", caps?.sizes),
  };
}

/**
 * The pixel size of an input image, read off the head of its data URL — for
 * `ImageParamOptions.inputSize`. Header-only: PNG/GIF/WebP answer in the first
 * few dozen bytes and a JPEG within its leading segments, so only the first
 * 64 KB of base64 is decoded. Undefined when the format isn't one this app
 * accepts or the URL isn't a data URL.
 */
export function inputImageSize(dataUrl: string): { width: number; height: number } | undefined {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma === -1) return undefined;
  const head = dataUrl.slice(comma + 1, comma + 1 + 64 * 1024).replace(/[^A-Za-z0-9+/=]/g, "");
  try {
    const binary = atob(head.slice(0, head.length - (head.length % 4)));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const header = readImageHeader(bytes);
    return header ? { width: header.width, height: header.height } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pick the declared size closest to the requested aspect ratio.
 *
 * Returns undefined when the model declares no sizes — that is the signal to
 * omit the parameter entirely, which several endpoints (xAI, some relays)
 * require: they reject `size` outright rather than ignoring it.
 */
export function sizeForAspect(
  /** "3:4" and friends. Typed loosely because it also arrives from a proposal,
   *  where it survived a round-trip through JSON as a plain string. */
  aspect: ImageAspect | string,
  sizes: string[] | undefined,
): string | undefined {
  if (!sizes?.length) return undefined;
  const [aw, ah] = aspect.split(":").map(Number);
  const target = aw / ah;
  let best: string | undefined;
  let bestDelta = Infinity;
  for (const size of sizes) {
    // "x" is the app's convention, "*" is DashScope's, "×" is a human's.
    const [w, h] = size.toLowerCase().split(/[x*×]/).map(Number);
    if (!w || !h) continue;
    const delta = Math.abs(w / h - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = size;
    }
  }
  return best ?? sizes[0];
}

/**
 * Record one image run in `token_usage`.
 *
 * Reuses the token table rather than adding a second one: the cost column is
 * the only field the usage UI aggregates, and an image row simply reports zero
 * tokens when the provider bills per image. `task` distinguishes the rows.
 */
export async function recordImageUsage(
  /** Null before a project is open — nothing to record against, so it no-ops. */
  projectPath: string | null,
  model: Model,
  task: string,
  images: number,
  usage?: { inputTokens: number; outputTokens: number },
): Promise<void> {
  if (!projectPath) return;
  try {
    const db = await getDb(projectPath);
    await db.execute(
      `INSERT INTO token_usage (model_id, task, prompt_tokens, cached_tokens, completion_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        // `model.id`, not `model.modelId`: every other writer records the
        // configured model's internal id, and this site recording the
        // provider's model string instead put two different identifier spaces
        // in one column — so the usage rollup could not name the model an
        // image run was billed to. Rows written before this fix still carry
        // the old shape; the reader matches both.
        model.id,
        task,
        usage?.inputTokens ?? 0,
        0,
        usage?.outputTokens ?? 0,
        imageCostFor(model, images, usage),
        Math.floor(Date.now() / 1000),
      ],
    );
  } catch {
    // non-critical — usage accounting must never break a successful generation
  }
}
