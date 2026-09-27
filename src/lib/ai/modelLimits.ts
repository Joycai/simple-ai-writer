/**
 * Best-known output caps for models the author hasn't configured by hand.
 *
 * `maxOutput` is the ceiling on ONE reply — not the context window — and it is
 * what a large deliverable actually runs into. Left unset it is not merely
 * cosmetic: the budget planner sizes its output reserve from it
 * (`lib/context/budget.outputReserveTokens`), and the Anthropic protocol
 * *requires* a `max_tokens` on every request, so an absent value there means
 * falling back to a fixed default rather than to the model's real capability.
 *
 * ## Why this table is deliberately timid
 *
 * These numbers come from vendor documentation and go stale the moment a vendor
 * ships a new tier, while this file ships with the app. Two rules keep a stale
 * entry from becoming a broken app:
 *
 * 1. **Nothing here is sent to an Anthropic endpoint.** Anthropic rejects a
 *    `max_tokens` above the model's own ceiling with a 400 — a wrong entry
 *    would break every request to that model rather than degrade politely. The
 *    adapter's own conservative default (`DEFAULT_MAX_TOKENS` below) keeps
 *    that job, and an author who wants more raises it explicitly. Since
 *    capability-resolution P6 this is data, not a promise: every cap travels
 *    with its source, and the Anthropic `max_tokens` trusts only the author's
 *    (`capability/intent.ts` `TRUST`). Before it, the app default and these
 *    numbers did reach the wire (HLD §1.3).
 * 2. **Everywhere else the value is planning-only.** The OpenAI and Gemini
 *    adapters send no cap at all, letting the endpoint apply the model's real
 *    one; the number here only sizes the context budget. Guessing low there
 *    costs a slightly conservative plan, and guessing high costs nothing the
 *    truncation recovery in `agent/runtime` doesn't already handle.
 *
 * The authority on any specific endpoint remains 「探测真实上限」
 * (`lib/ai/endpointProbe`), which *measures* the cap and writes it onto the
 * model. This table is what the author sees before they bother.
 *
 * The numbers themselves are the `maxOutput` rows of the global model catalog
 * (`capability/cells/catalog.ts`), beside the other facts a model id carries.
 * A row that leaves the cap unset takes, in order, the platform's value for
 * the id, the catalog's, then the app-wide default below
 * (`capability/values.ts` `modelValue`).
 */

import { readPref } from "../prefs";
import { catalogFact } from "./capability/cells/catalog";

/** The app-wide fallback cap, set in Settings → 通用. 0 / unset = no opinion. */
export const DEFAULT_MAX_OUTPUT_KEY = "app:defaultMaxOutput";

/** Bounds for the app-wide default — a free number field, but not a nonsense one. */
export const DEFAULT_MAX_OUTPUT_MAX = 200_000;

/**
 * The author's app-wide default, read at call time.
 *
 * A preference rather than an argument because every request path would
 * otherwise have to thread it, and the one that forgot would quietly disagree
 * with the others about how big a reply may be.
 */
export function defaultMaxOutput(): number {
  const raw = readPref(DEFAULT_MAX_OUTPUT_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? Math.min(n, DEFAULT_MAX_OUTPUT_MAX) : 0;
}

/**
 * The documented output cap for this model id, or null when nothing is known.
 *
 * Longest prefix wins, so `gpt-4-turbo` is not answered by the `gpt-4` entry.
 * Anthropic ids deliberately return null — see the file header.
 */
export function knownMaxOutput(modelId: string): number | null {
  return catalogFact("maxOutput", modelId) ?? null;
}

/**
 * `max_tokens` when the model has no `maxOutput` configured.
 *
 * Anthropic requires the field on every request, so there is no "let the server
 * decide" option to fall back on.
 *
 * 32k, not the 8k this used to be. Thinking tokens count against `max_tokens`
 * and it is a hard limit, so once thinking is on the old value left the model
 * splitting 8k between reasoning and prose — the documented symptom is a
 * response that stops with `stop_reason: "max_tokens"` and truncated or missing
 * text. Every model in this app's supported Claude range (4.6+) accepts at
 * least 64k output, so the old worry about overshooting a small model's ceiling
 * doesn't apply to them; 32k stays well inside that while leaving real room to
 * think. A value above the model's own cap is itself a 400, which is why this
 * is not simply set to the 128k the range allows.
 */
const DEFAULT_MAX_TOKENS = 32_768;

/**
 * The `max_tokens` a wire that requires one sends (the Messages API): the
 * request's cap when it has one, else {@link DEFAULT_MAX_TOKENS}. One function
 * so the adapter and the 将发送 summary cannot disagree (the request plan reads
 * it, `capability/plan.ts`).
 */
export function requiredMaxTokens(maxOutput: number | undefined): number {
  return maxOutput && maxOutput > 0 ? Math.floor(maxOutput) : DEFAULT_MAX_TOKENS;
}
