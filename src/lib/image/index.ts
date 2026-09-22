/**
 * Image generation domain: prompt building (./promptGen), size negotiation and
 * usage accounting. The wire client itself lives in lib/ai/image.ts alongside
 * the other provider adapters.
 */

import { type ImageCaps, type Model } from "../ai/configDb";
import { imageDialect, type ImageParamOptions, type ImageWireParams } from "../ai/imageDialects";
import { readImageHeader } from "./imageSize";
import { recordUsage } from "../ai/usageRow";
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
 * 记一次出图运行。
 *
 * 走的是全应用唯一的写入口（`lib/ai/usageRow.recordUsage`），所以出图和
 * 对话的账进同一张表、用同一份算式，并且同样一式两份（项目 + 总体）。
 *
 * 出图端点常按**规格**计价（同一个模型 1K 一个价、2K 另一个价），所以这里
 * 把请求的尺寸 / 质量一并交上去——计费组按张计价时拿它去档位表里匹配，
 * 按 token 计价时（gpt-image 那一类）它只是行上的一条记录。
 * `inputImages` 是发出去的参考图张数：编辑 / 垫图在多数端点上另收。
 */
export async function recordImageUsage(
  /** Null before a project is open — 总体那份照记，项目那份跳过。 */
  projectPath: string | null,
  model: Model,
  task: string,
  images: number,
  usage?: { inputTokens: number; outputTokens: number },
  spec: { size?: unknown; quality?: unknown; seconds?: unknown } = {},
  inputImages = 0,
): Promise<void> {
  // `model.id`，不是 `model.modelId`：别的写入方记的都是配置里的内部 id，
  // 这里曾经记供应商的模型串，于是同一列里混了两套标识空间，用量卷不出
  // 这笔账算在哪个模型头上。老行还是老样子，读那一侧两种都认。
  await recordUsage(projectPath, {
    model,
    task,
    promptTokens: usage?.inputTokens ?? 0,
    completionTokens: usage?.outputTokens ?? 0,
    outputUnits: images,
    spec,
    inputImages,
  });
}
