/**
 * Image generation domain: prompt building (./promptGen), size negotiation and
 * usage accounting. The wire client itself lives in lib/ai/image.ts alongside
 * the other provider adapters.
 */

import { imageCostFor, type Model } from "../ai/configDb";
import { getDb } from "../project";
import type { ImageAspect } from "./promptGen";

export * from "./promptGen";

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
    const [w, h] = size.toLowerCase().split("x").map(Number);
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
        model.modelId,
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
