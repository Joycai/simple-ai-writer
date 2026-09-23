/**
 * Relay upstreams — which backend a relay routes a model to.
 *
 * A relay (New API, or any server the author points `custom` at) fronts
 * several upstreams at once, and the same model id behaves differently behind
 * each: on one New API, `claude-opus-4-6` read PDFs and ran a real web search
 * behind one upstream and dropped both behind another (landscape.md §7
 * 第十六个样本). The upstream shows only in a prefix the relay's owner made up
 * — `[CC量]`, `[anti量]` — so it cannot be matched in code without hardcoding
 * one relay (docs/issues/relay-claude-channel-gating.md). Instead the author
 * maps prefixes to upstreams on the channel, and may override one model.
 *
 * Resolution, first answer wins: the model's own choice → the channel's
 * longest matching prefix → the upstream's product name in the id (`kiro`,
 * `bedrock`; nothing a relay owner invents) → none. Only on a relay platform.
 *
 * What each upstream was measured to do is `UPSTREAM_CAPABILITIES` in
 * `capabilities.ts`; this file decides which one a model has. Plan:
 * docs/api/capability-gating-plan.md §8.11.
 */

import { PLATFORM_CAPABILITIES } from "./capabilities";
import type { PlatformId } from "./platforms";

/** The built-in upstreams, in the order the drawers list them. */
export const RELAY_UPSTREAMS = ["kiro", "cc", "anti", "bedrock", "official"] as const;
export type RelayUpstreamId = (typeof RELAY_UPSTREAMS)[number];

/** A model's choice: an upstream, or `"none"` — resolved to no upstream on purpose. */
export type RelayUpstreamChoice = RelayUpstreamId | "none";

/** One row of a channel's table: model ids starting with `prefix` are behind `upstream`. */
export interface UpstreamPrefix {
  prefix: string;
  upstream: RelayUpstreamId;
}

/** The product names an id may carry, and the upstream each one names. */
const PRODUCT_NAMES: readonly { word: string; upstream: RelayUpstreamId }[] = [
  { word: "kiro", upstream: "kiro" },
  { word: "bedrock", upstream: "bedrock" },
];
type ProductName = "kiro" | "bedrock";

/** A model's upstream and where it came from — the drawer says the second as well. */
export interface ResolvedUpstream {
  upstream?: RelayUpstreamId;
  /**
   * `model`: the model's own choice (`"none"` leaves `upstream` absent).
   * `prefix`: the channel's table. `inferred`: a product name in the id.
   * `none`: nothing applies, or the platform is not a relay.
   */
  source: "model" | "prefix" | "inferred" | "none";
  /** The row's prefix, when `source` is `prefix`. */
  prefix?: string;
  /** The product name found, when `source` is `inferred`. */
  word?: ProductName;
}

function isRelayUpstream(v: unknown): v is RelayUpstreamId {
  return typeof v === "string" && (RELAY_UPSTREAMS as readonly string[]).includes(v);
}

/** A platform with no host of its own, which may front anything — the only kind an upstream means anything on. */
export function isRelayPlatform(platform: PlatformId | undefined): boolean {
  return !!platform && !!PLATFORM_CAPABILITIES[platform]?.relay;
}

/** The upstream a product name in the id names. Owners' abbreviations are never guessed at. */
export function inferRelayUpstream(modelId: string | undefined): { upstream: RelayUpstreamId; word: ProductName } | undefined {
  const mid = modelId?.trim().toLowerCase();
  if (!mid) return undefined;
  const hit = PRODUCT_NAMES.find((p) => mid.includes(p.word));
  return hit && { upstream: hit.upstream, word: hit.word as ProductName };
}

/** The longest row whose prefix starts the id, case-insensitively. An empty prefix matches nothing. */
export function matchUpstreamPrefix(
  modelId: string | undefined,
  prefixes: readonly UpstreamPrefix[] | undefined,
): UpstreamPrefix | undefined {
  const mid = modelId?.trim().toLowerCase();
  if (!mid || !prefixes) return undefined;
  let best: UpstreamPrefix | undefined;
  for (const row of prefixes) {
    const p = row.prefix.trim().toLowerCase();
    if (p && mid.startsWith(p) && (!best || p.length > best.prefix.trim().length)) best = row;
  }
  return best;
}

export function resolveRelayUpstream(
  platform: PlatformId | undefined,
  modelId: string | undefined,
  choice: RelayUpstreamChoice | undefined,
  prefixes: readonly UpstreamPrefix[] | undefined,
): ResolvedUpstream {
  if (!isRelayPlatform(platform)) return { source: "none" };
  if (choice === "none") return { source: "model" };
  if (choice) return { upstream: choice, source: "model" };
  const row = matchUpstreamPrefix(modelId, prefixes);
  if (row) return { upstream: row.upstream, source: "prefix", prefix: row.prefix.trim() };
  const inferred = inferRelayUpstream(modelId);
  if (inferred) return { upstream: inferred.upstream, source: "inferred", word: inferred.word };
  return { source: "none" };
}

/**
 * What `connOptions()` and every other reader holding the channel carry
 * forward: the resolved upstream, or `"none"` — never absent, so nothing
 * downstream infers again over the author's table.
 */
export function relayUpstreamFor(
  platform: PlatformId | undefined,
  model: { modelId?: string; relayUpstream?: RelayUpstreamChoice },
  channel: { upstreamPrefixes?: readonly UpstreamPrefix[] } | undefined,
): RelayUpstreamChoice {
  return resolveRelayUpstream(platform, model.modelId, model.relayUpstream, channel?.upstreamPrefixes).upstream ?? "none";
}

/**
 * The model half of a capability question, from a request's options.
 * `relayUpstream` is what `connOptions()` resolved from the channel and the
 * model; when it is absent — options built by hand, as the live probes and
 * endpoint probing do — the id's product name still counts, so those callers
 * keep the verdicts they had before upstreams were configurable. `"none"` is
 * a resolution too, and is not second-guessed.
 */
export function capabilityModelOf(o: {
  modelId?: string;
  relayUpstream?: RelayUpstreamChoice;
}): { modelId?: string; upstream?: RelayUpstreamId } {
  if (o.relayUpstream === "none") return { modelId: o.modelId };
  const upstream = o.relayUpstream ?? inferRelayUpstream(o.modelId)?.upstream;
  return upstream ? { modelId: o.modelId, upstream } : { modelId: o.modelId };
}

/**
 * The bracketed prefixes (`[CC量]`) the channel's models start with that no
 * row covers yet, most frequent first — what the channel drawer offers to add.
 * It reads the shape New API catalogues use, not any one relay's names.
 * Grouped without regard to case, as a row matches: `[CC量]` and `[cc量]` are
 * one suggestion, spelled the way most of the ids spell it.
 */
export function bracketPrefixes(modelIds: readonly string[], rows: readonly { prefix: string }[] = []): string[] {
  const have = new Set(rows.map((r) => r.prefix.trim().toLowerCase()));
  const groups = new Map<string, { total: number; spellings: Map<string, number> }>();
  for (const id of modelIds) {
    const m = /^\[[^\]\s]+\]/.exec(id.trim());
    const key = m?.[0].toLowerCase();
    if (!m || !key || have.has(key)) continue;
    const g = groups.get(key) ?? { total: 0, spellings: new Map<string, number>() };
    g.total++;
    g.spellings.set(m[0], (g.spellings.get(m[0]) ?? 0) + 1);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.total - a.total)
    .map((g) => [...g.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0]);
}

const fromJson = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};

/**
 * A channel's table as read back (database column or backup file). A row
 * with a blank prefix or an unknown upstream is dropped, as is a repeat of a
 * prefix already read; nothing throws. Empty reads as absent.
 */
export function parseUpstreamPrefixes(raw: unknown): UpstreamPrefix[] | undefined {
  const value = fromJson(raw);
  if (!Array.isArray(value)) return undefined;
  const out: UpstreamPrefix[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const prefix = typeof r.prefix === "string" ? r.prefix.trim() : "";
    if (!prefix || !isRelayUpstream(r.upstream)) continue;
    if (out.some((e) => e.prefix.toLowerCase() === prefix.toLowerCase())) continue;
    out.push({ prefix, upstream: r.upstream });
  }
  return out.length ? out : undefined;
}

/** A model's choice as read back; anything unrecognised reads as absent (follow the channel). */
export function parseRelayUpstreamChoice(raw: unknown): RelayUpstreamChoice | undefined {
  return raw === "none" || isRelayUpstream(raw) ? raw : undefined;
}
