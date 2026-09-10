/**
 * 一致性检查的**范围**——拿知识库的哪一部分当尺子。
 *
 * 三档，和知识库那边的取材范围围栏（lib/lore/collections）的关系各不相同，见
 * docs/feature/consistency-review-plan.md §4：
 *
 *   all          跟随围栏。今天的行为。
 *   collections  覆盖围栏：只这些集合（可含「未归集」）。
 *   entries      只这些条目 / 特征。自动发现关掉（预算全给 pin），工具侧**不**围——
 *                限制发生在「记录」那一步（reviewTools 的 sink 拒收范围外的条目），
 *                不在「阅读」那一步。
 *
 * 纯数据 + 纯函数：序列化（按项目落偏好）、失效项剔除。不碰盘。
 */

import type { LoreIndex } from "../lore";
import { UNGROUPED, collectionViews, normalizeScope, type LoreScope } from "../lore/collections";
import type { LorePin } from "../context/loreSelect";

export type ReviewScope =
  | { kind: "all" }
  | { kind: "collections"; names: string[] }
  | { kind: "entries"; pins: LorePin[] };

export const ALL_SCOPE: ReviewScope = { kind: "all" };

/** Pref key prefix — one row per project, like `lore:scope:<project>`. */
export const REVIEW_SCOPE_PREFIX = "consistency:scope:";

export function serializeReviewScope(scope: ReviewScope): string | null {
  if (scope.kind === "all") return null;
  if (scope.kind === "collections") {
    return scope.names.length ? JSON.stringify({ kind: "collections", names: scope.names }) : null;
  }
  return scope.pins.length
    ? JSON.stringify({
        kind: "entries",
        pins: scope.pins.map((p) => ({ dirPath: p.dirPath, facetFile: p.facetFile })),
      })
    : null;
}

/** Tolerant parse — anything unreadable is `all`, never a throw. */
export function parseReviewScope(raw: string | null | undefined): ReviewScope {
  if (!raw) return ALL_SCOPE;
  try {
    const v = JSON.parse(raw) as { kind?: unknown; names?: unknown; pins?: unknown };
    if (v.kind === "collections") {
      const names = normalizeScope(v.names) ?? [];
      return names.length ? { kind: "collections", names } : ALL_SCOPE;
    }
    if (v.kind === "entries" && Array.isArray(v.pins)) {
      const pins: LorePin[] = [];
      for (const p of v.pins as unknown[]) {
        if (!p || typeof p !== "object") continue;
        const { dirPath, facetFile } = p as { dirPath?: unknown; facetFile?: unknown };
        if (typeof dirPath !== "string" || !dirPath) continue;
        pins.push({ dirPath, facetFile: typeof facetFile === "string" && facetFile ? facetFile : null });
      }
      return pins.length ? { kind: "entries", pins: dedupePins(pins) } : ALL_SCOPE;
    }
  } catch {
    /* fall through */
  }
  return ALL_SCOPE;
}

export function dedupePins(pins: readonly LorePin[]): LorePin[] {
  const seen = new Set<string>();
  const out: LorePin[] = [];
  for (const p of pins) {
    const key = pinKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** The `dirPath#facetFile` spelling `selectLore`'s pin list takes. */
export function pinKey(pin: LorePin): string {
  return pin.facetFile ? `${pin.dirPath}#${pin.facetFile}` : pin.dirPath;
}

export function samePin(a: LorePin, b: LorePin): boolean {
  return a.dirPath === b.dirPath && (a.facetFile ?? null) === (b.facetFile ?? null);
}

/** A pin that can no longer be honoured — its entry or facet is gone. */
export interface StalePin {
  pin: LorePin;
  /** Best-effort display name (the entity's, when only the facet is gone). */
  label: string;
}

export interface ResolvedReviewScope {
  /** The scope with every stale item removed. */
  effective: ReviewScope;
  staleCollections: string[];
  stalePins: StalePin[];
}

/**
 * Drop what the index no longer has.
 *
 * A collection "exists" when it is declared in profile.json *or* any entry
 * still carries it — same degradation rule as the wall's chips (an orphan
 * collection is visible and filterable, just unordered). A pin is stale when
 * its entry is gone, or its facet file is; a facet pin must NOT quietly widen
 * into a whole-entity pin (same rule `selectLore` applies).
 *
 * A scope that empties out falls back to `all` — the caller says so.
 */
export function resolveReviewScope(
  scope: ReviewScope,
  index: LoreIndex,
  declaredCollections: readonly string[],
): ResolvedReviewScope {
  if (scope.kind === "all") return { effective: scope, staleCollections: [], stalePins: [] };

  if (scope.kind === "collections") {
    const known = new Set(collectionViews(index, [...declaredCollections]).map((v) => v.name.toLowerCase()));
    const live: string[] = [];
    const stale: string[] = [];
    for (const name of scope.names) {
      if (name === UNGROUPED || known.has(name.toLowerCase())) live.push(name);
      else stale.push(name);
    }
    return {
      effective: live.length ? { kind: "collections", names: live } : ALL_SCOPE,
      staleCollections: stale,
      stalePins: [],
    };
  }

  const byDir = new Map<string, { name: string; facets: Set<string> }>();
  for (const entities of Object.values(index)) {
    for (const e of entities ?? []) {
      byDir.set(e.dirPath, { name: e.name, facets: new Set((e.facets ?? []).map((f) => f.file)) });
    }
  }
  const live: LorePin[] = [];
  const stale: StalePin[] = [];
  for (const pin of scope.pins) {
    const entity = byDir.get(pin.dirPath);
    if (!entity) {
      stale.push({ pin, label: pin.dirPath.split(/[\\/]/).pop() ?? pin.dirPath });
      continue;
    }
    if (pin.facetFile && !entity.facets.has(pin.facetFile)) {
      stale.push({ pin, label: `${entity.name} · ${pin.facetFile.replace(/\.md$/i, "")}` });
      continue;
    }
    live.push(pin);
  }
  return {
    effective: live.length ? { kind: "entries", pins: live } : ALL_SCOPE,
    staleCollections: [],
    stalePins: stale,
  };
}

/**
 * What the run hands the retrieval layer.
 *
 *   - `loreScope` — the fence `selectLore` and `list_lore_entities` see.
 *   - `pinPaths`  — always injected, fence or no fence.
 *   - `autoDiscovery` — false in entries mode: the pins are the whole yardstick.
 *   - `allowedDirs` — entries mode only: the sink refuses findings about anyone else.
 */
export function scopeForRun(
  scope: ReviewScope,
  fallbackFence: LoreScope,
): {
  loreScope: LoreScope;
  pinPaths: string[];
  autoDiscovery: boolean;
  allowedDirs: ReadonlySet<string> | null;
} {
  switch (scope.kind) {
    case "all":
      return { loreScope: fallbackFence, pinPaths: [], autoDiscovery: true, allowedDirs: null };
    case "collections":
      return { loreScope: scope.names, pinPaths: [], autoDiscovery: true, allowedDirs: null };
    case "entries":
      return {
        loreScope: null,
        pinPaths: scope.pins.map(pinKey),
        autoDiscovery: false,
        allowedDirs: new Set(scope.pins.map((p) => p.dirPath)),
      };
  }
}
