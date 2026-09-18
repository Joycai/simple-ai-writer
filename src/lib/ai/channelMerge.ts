/**
 * Merging two channels that are one — 设计稿 05k 屏 07, docs/feature/channel-model-route-plan.md §5.3.
 *
 * Before routes, one key that spoke three protocols was three provider rows
 * (「MiniMax」「MiniMax (Claude 格式)」, 「OpenAI」「OpenAI (Responses)」), each
 * with its own copy of the key and of every model. The routes migration keeps
 * them apart on purpose (§5.2 step 4): deciding that two keys are the same key
 * and two same-named models are the same model is a guess, and a wrong guess
 * silently moves a model to another billing account. So the app only
 * **detects** (same platform, same host, same key, disjoint protocols) and the
 * author confirms the plan, which this module computes without touching
 * anything.
 *
 * The one place in the app that makes a model id disappear (invariant 1):
 * every reference to a merged-away id is rewritten in the same step — the
 * rows here in one transaction, the selections and subagent bindings through
 * the store, the open project's usage rows after (`remapUsageModelIds`).
 */

import type { SqlStatement } from "../sqlTx";
import { modelUpsert, providerUpsert, type Model, type Provider } from "./configDb";
import { resolvePlatform } from "./platforms";
import { activeFamily, channelEndpoints, channelHost, normalizeChannel, routeProfileOf } from "./routes";

/** Two channels the author may fold into one: `absorb`'s routes and models move to `keep`. */
export interface MergeCandidate {
  keep: Provider;
  absorb: Provider;
}

const hostKey = (p: Provider): string => channelHost(p).trim().toLowerCase().replace(/\/+$/, "");
const platformOf = (p: Provider) => resolvePlatform(p.platform, p.baseUrl, p.apiStandard);

/**
 * Pairs that are one channel in fact: same platform, same host, the **same
 * key** (compared in memory — `keys` never leaves the caller), and no protocol
 * in common (two routes of one family would be two channels, plan §9).
 *
 * An empty key matches only another empty key on a real host — two local
 * servers at one address are one server. The earlier channel in list order is
 * kept; each channel appears in at most one pair, so the list never offers two
 * merges that fight over the same row.
 */
export function mergeCandidates(
  providers: readonly Provider[],
  keys: ReadonlyMap<string, string>,
): MergeCandidate[] {
  const out: MergeCandidate[] = [];
  const used = new Set<string>();
  for (let i = 0; i < providers.length; i++) {
    const a = providers[i];
    if (used.has(a.id)) continue;
    for (let j = i + 1; j < providers.length; j++) {
      const b = providers[j];
      if (used.has(b.id)) continue;
      if (platformOf(a) !== platformOf(b) || hostKey(a) !== hostKey(b)) continue;
      const ka = keys.get(a.id) ?? "";
      const kb = keys.get(b.id) ?? "";
      if (ka !== kb || (!ka && !hostKey(a))) continue;
      const fa = new Set(channelEndpoints(a).map((e) => e.family));
      if (channelEndpoints(b).some((e) => fa.has(e.family))) continue;
      out.push({ keep: a, absorb: b });
      used.add(a.id);
      used.add(b.id);
      break;
    }
  }
  return out;
}

/** What a merge will do, for the preview and for the write. */
export interface MergePlan {
  /** `keep`, with `absorb`'s routes appended after its own. */
  channel: Provider;
  /** Model rows to write: `keep`'s models that gained a route, and `absorb`'s that moved over. */
  upserts: Model[];
  /** `absorb` models folded into a same-id `keep` model — their rows go. */
  deletes: string[];
  /** Every deleted id → the id that now stands for it. */
  remap: Record<string, string>;
  /** How many of `absorb`'s models moved as they are, and how many were folded in. */
  moved: number;
  merged: number;
}

/**
 * Fold `absorb` into `keep`.
 *
 * A model on `absorb` whose model id (and type) a `keep` model shares becomes
 * that model's second route: its current fields park under its family on the
 * `keep` row, whose id survives (§5.3). Any other model moves across with its
 * route pinned explicitly — the primary route changes under it, and it must
 * keep speaking the protocol its fields were set for.
 */
export function planMerge(keep: Provider, absorb: Provider, models: readonly Model[]): MergePlan {
  const channel = normalizeChannel({
    ...keep,
    endpoints: [...channelEndpoints(keep), ...channelEndpoints(absorb)],
  });
  const keepModels = models.filter((m) => m.providerId === keep.id);
  const updated = new Map<string, Model>();
  const moved: Model[] = [];
  const deletes: string[] = [];
  const remap: Record<string, string> = {};

  for (const m of models.filter((x) => x.providerId === absorb.id)) {
    const family = activeFamily(m, absorb);
    // One absorbed model per kept one: a second same-id row (a duplicate the
    // author made on purpose) moves across rather than overwriting the first.
    const taken = new Set(Object.values(remap));
    const target = keepModels.find((k) => k.modelId === m.modelId && k.type === m.type && !taken.has(k.id));
    const current = target ? updated.get(target.id) ?? target : undefined;
    if (current) {
      updated.set(current.id, {
        ...current,
        routes: { ...(m.routes ?? {}), ...(current.routes ?? {}), [family]: routeProfileOf(m) },
      });
      deletes.push(m.id);
      remap[m.id] = current.id;
    } else {
      moved.push({ ...m, providerId: keep.id, activeRoute: family });
    }
  }
  return {
    channel,
    upserts: [...updated.values(), ...moved],
    deletes,
    remap,
    moved: moved.length,
    merged: deletes.length,
  };
}

/**
 * The plan as one transaction's statements. Order matters: the channel first
 * (its routes must exist before a model points at them), the model writes
 * before the deletes (a moved row is re-parented before its old channel's
 * cascade could reach it), the absorbed channel last.
 */
export function mergeStatements(plan: MergePlan, absorbId: string): SqlStatement[] {
  return [
    providerUpsert(plan.channel),
    ...plan.upserts.map(modelUpsert),
    ...plan.deletes.map((id) => ({ sql: "DELETE FROM models WHERE id = ?", values: [id] })),
    { sql: "DELETE FROM models WHERE provider_id = ?", values: [absorbId] },
    { sql: "DELETE FROM providers WHERE id = ?", values: [absorbId] },
  ];
}
