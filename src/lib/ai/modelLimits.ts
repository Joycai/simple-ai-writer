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
 *    adapter's own conservative default (`anthropic.DEFAULT_MAX_TOKENS`) keeps
 *    that job, and an author who wants more raises it explicitly.
 * 2. **Everywhere else the value is planning-only.** The OpenAI and Gemini
 *    adapters send no cap at all, letting the endpoint apply the model's real
 *    one; the number here only sizes the context budget. Guessing low there
 *    costs a slightly conservative plan, and guessing high costs nothing the
 *    truncation recovery in `agent/runtime` doesn't already handle.
 *
 * The authority on any specific endpoint remains 「探测真实上限」
 * (`lib/ai/endpointProbe`), which *measures* the cap and writes it onto the
 * model. This table is what the author sees before they bother.
 */

import { readPref } from "../prefs";

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

/** modelId prefix → documented single-reply output cap, in tokens. */
const KNOWN_OUTPUT_CAPS: ReadonlyArray<[prefix: string, tokens: number]> = [
  // ── OpenAI ──
  ["gpt-5", 128_000],
  ["gpt-4.1", 32_768],
  ["gpt-4o", 16_384],
  ["gpt-4-turbo", 4_096],
  ["gpt-4", 8_192],
  ["gpt-3.5", 4_096],
  ["o4-mini", 100_000],
  ["o3", 100_000],
  ["o1", 100_000],
  // ── Google ──
  ["gemini-2.5", 65_536],
  ["gemini-2.0", 8_192],
  ["gemini-1.5", 8_192],
  // ── DeepSeek ──
  ["deepseek-reasoner", 32_768],
  ["deepseek-chat", 8_192],
  // ── Qwen (DashScope) ──
  ["qwen-max", 8_192],
  ["qwen-plus", 8_192],
  ["qwen-turbo", 8_192],
  // ── 千问AI平台 catalogue, 2026-09 (docs/api/qianwen-compat-plan.md P6) ──
  // Numbers are the platform's model pages; the third-party models are listed
  // under the bare ids the platform uses (`kimi-k3`, `glm-5.2`), which is also
  // what the vendors' own endpoints call them. Planning-only, per the header.
  ["qwen3.8-flash", 131_072],
  ["qwen3.7-flash", 131_072],
  ["qwen3-vl-plus", 32_768],
  ["deepseek-v4-pro", 393_216],
  ["glm-5.2", 131_072],
  ["kimi-k3", 1_000_000],
  ["minimax-m2.5", 32_768],
];

/**
 * Strip what a relay or a deployment adds around the model's own name:
 * `openai/gpt-4o`, `gpt-4o-2024-11-20`, `azure-gpt-4o`. The date suffix is left
 * alone — prefix matching steps over it — but the vendor prefix has to go or
 * nothing matches for OpenRouter-style ids.
 *
 * Exported for the other prefix table keyed by model id (`jsonMode.ts`'s
 * strict-schema list), so the two agree on what a model is called.
 */
export function normalizeModelId(modelId: string): string {
  const id = modelId.trim().toLowerCase();
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * The documented output cap for this model id, or null when nothing is known.
 *
 * Longest prefix wins, so `gpt-4-turbo` is not answered by the `gpt-4` entry.
 * Anthropic ids deliberately return null — see the file header.
 */
export function knownMaxOutput(modelId: string): number | null {
  const id = normalizeModelId(modelId);
  let best: [string, number] | null = null;
  for (const entry of KNOWN_OUTPUT_CAPS) {
    if (!id.startsWith(entry[0])) continue;
    if (!best || entry[0].length > best[0].length) best = entry as [string, number];
  }
  return best ? best[1] : null;
}

/**
 * What a model's per-reply cap should be taken as, in priority order:
 * the author's own value → this table → the app-wide default they set in
 * Settings → nothing (each protocol's own fallback).
 *
 * One function so every consumer — the request adapters, the budget planner,
 * the model editor's placeholder — agrees on the answer. A planner that
 * assumed one number while the request sent another is exactly how an author
 * ends up with a "context budget" that doesn't match what the endpoint did.
 */
export function effectiveMaxOutput(
  model: { modelId: string; maxOutput?: number },
  appDefault?: number,
): number | undefined {
  if (model.maxOutput && model.maxOutput > 0) return model.maxOutput;
  const known = knownMaxOutput(model.modelId);
  if (known) return known;
  return appDefault && appDefault > 0 ? appDefault : undefined;
}
