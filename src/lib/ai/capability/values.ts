/**
 * Value facts — the thinking category, the output cap, the context window —
 * resolved along the same chain as the capability flags, each answer with its
 * source (docs/api/capability-resolution-lld.md §3.3, §3.9, P6).
 *
 *   author (the model row) → the platform's row for the id (the family's own
 *   block, then `all`) → the model catalog (intrinsic facts only) → the
 *   protocol family's default → the app-wide default.
 *
 * The author's value always wins (D1): the tables answer only for a field the
 * row leaves unset, and only a field that *has* an unset state — `thinkingCategory`
 * at 自动, `contextSize` and `maxOutput` empty. A model's type has no unset
 * state and `pdf_input` stores `false` as absent (`configDb.ts`), so the
 * platform's view of those two stays a drawer prefill.
 *
 * Before P6 the platform's rows were a prefill only, and the catalog's caps
 * were a runtime default: two regimes for the same kind of fact. Now a row
 * saved before a platform's rows existed gets them the same as a new one, and
 * a new measurement reaches every row without a migration.
 *
 * Relay upstreams carry no value facts: what an upstream serves under an id is
 * the relay's business, and nothing has been measured there.
 */

import { defaultMaxOutput } from "../modelLimits";
import type { PlatformId } from "../platforms";
import {
  fitsFamily, migrateDialect, THINKING_CATEGORIES, type ThinkingCategory, type ThinkingCategoryId, type ThinkingDialect,
} from "../reasoning";
import { familyOf, type ApiStandard, type ProtocolFamily } from "../types";
import { catalogFact } from "./cells/catalog";
import { platformValue } from "./cells/platform";
import { VALUE_FACTS, type ValueFactId, type ValueFactMap } from "./facts";
import type { Sourced } from "./intent";

type IntrinsicValueFact = "maxOutput" | "contextSize";

/** Where a value is asked about: the wire, and the model id on it. */
interface ValueSubject {
  standard: ApiStandard;
  /** Absent = no platform's rows are consulted (a hand-built bag, a caller with no channel). */
  platform?: PlatformId;
  modelId?: string;
  /** What the catalog is asked about (`ConnOptions.canonicalModelId`); absent = `modelId`. */
  canonicalModelId?: string;
}

/**
 * The tables' answer for a value fact, before the author's: the platform's
 * row → the catalog (for an intrinsic fact) → the family's default.
 * `accepts` passes over a value the family cannot use.
 */
function tableValue<F extends ValueFactId>(
  fact: F,
  at: ValueSubject,
  accepts: (v: ValueFactMap[F]) => boolean = () => true,
): Sourced<ValueFactMap[F]> | undefined {
  const family = familyOf(at.standard);
  const spec = VALUE_FACTS[fact];
  if (at.platform) {
    const v = platformValue<F>(at.platform, family, fact, at.modelId, accepts);
    if (v !== undefined) return { value: v, source: "platform" };
  }
  const catalogId = at.canonicalModelId ?? at.modelId;
  if (spec.scope === "intrinsic" && catalogId) {
    // Only an intrinsic fact reaches here, and the catalog holds every one of them.
    const v = catalogFact(fact as IntrinsicValueFact, catalogId) as ValueFactMap[F] | undefined;
    if (v !== undefined && accepts(v)) return { value: v, source: "catalog" };
  }
  const v = spec.familyDefault?.[family];
  return v !== undefined ? { value: v, source: "protocol" } : undefined;
}

/**
 * Read at call time, never at module scope: the author changes it in
 * Settings → 通用 while the app runs.
 */
const APP_DEFAULT: Record<IntrinsicValueFact, () => number | undefined> = {
  maxOutput: () => defaultMaxOutput() || undefined,
  // No app-wide window: a planner that has none assumes its own
  // (`context/budget.ts` ASSUMED_INPUT_CEILING_TOKENS), a request gate sends.
  contextSize: () => undefined,
};

/**
 * A model's window or per-reply cap, with its source — undefined when nothing
 * knows one. What a consumer may do with it depends on the source
 * (`intent.ts` `TRUST`).
 */
export function modelValue(
  fact: IntrinsicValueFact,
  model: { modelId: string; maxOutput?: number; contextSize?: number },
  at: Omit<ValueSubject, "modelId">,
): Sourced<number> | undefined {
  const own = model[fact];
  if (own && own > 0) return { value: own, source: "author" };
  const table = tableValue(fact, { ...at, modelId: model.modelId });
  if (table) return table;
  const app = APP_DEFAULT[fact]();
  return app ? { value: app, source: "default" } : undefined;
}

/** What a model row says about its thinking. */
interface ThinkingDeclaration {
  thinkingCategory?: ThinkingCategoryId;
  thinkingDialect?: ThinkingDialect;
  modelId?: string;
}

/**
 * The category in force for a model, and where it came from: the author's
 * declared one (if it fits the family, `fitsFamily`) → a migration of the
 * legacy `thinkingDialect` (the author's too, spelled the old way) → the
 * platform's row for the id → the family's default.
 */
export function thinkingCategoryOf(m: ThinkingDeclaration, at: Omit<ValueSubject, "modelId">): Sourced<ThinkingCategory> {
  const family: ProtocolFamily = familyOf(at.standard);
  const declared = m.thinkingCategory ? THINKING_CATEGORIES[m.thinkingCategory] : undefined;
  if (declared && fitsFamily(declared, family)) return { value: declared, source: "author" };
  const migrated = migrateDialect(m.thinkingDialect, family);
  if (migrated) return { value: migrated, source: "author" };
  // Every family has a default, so the table always answers.
  const table = tableValue("thinkingCategory", { ...at, modelId: m.modelId }, (id) => fitsFamily(THINKING_CATEGORIES[id], family))!;
  return { value: THINKING_CATEGORIES[table.value], source: table.source };
}

/**
 * {@link thinkingCategoryOf} without the source — the category every
 * consumer spells, shows or plans with. `platform` absent = no platform's
 * rows (a hand-built bag).
 */
export function resolveThinkingCategory(
  m: ThinkingDeclaration,
  standard: ApiStandard,
  platform?: PlatformId,
): ThinkingCategory {
  return thinkingCategoryOf(m, { standard, platform }).value;
}
