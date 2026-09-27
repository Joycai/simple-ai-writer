/**
 * The one-time migration of the legacy `thinkingDialect` into a thinking
 * category (docs/api/capability-resolution-lld.md §9.10).
 *
 * Before categories, a model row said how it thinks with a coarse dialect
 * (`adaptive` · `extended` · `switch` · `none`), on the row and on each parked
 * route. The request resolved it on the fly — the author's category if it fits
 * the route's family, else the dialect migrated for that family, else the
 * tables — and the drawer, the value view and the matrix each had to repeat
 * that step. Rows are now rewritten once, the same way the request resolved
 * them, so nothing downstream knows dialects exist:
 *
 *   - a declared category that fits the family stays;
 *   - otherwise the dialect's category for that family (`migrateDialect`);
 *   - otherwise nothing — 自动, which is what the request already sent: the
 *     tables' category for the id.
 *
 * Only a row or profile that carries a dialect is touched, so a run is a no-op
 * the second time. It works on raw values — a database row's columns, a
 * backup's JSON — because the parsed `Model` no longer has the field.
 */
import {
  fitsFamily, migrateDialect, parseThinkingCategory, parseThinkingDialect, THINKING_CATEGORIES,
  type ThinkingCategoryId,
} from "./reasoning";
import type { ProtocolFamily } from "./types";

const FAMILIES: readonly ProtocolFamily[] = ["openai", "responses", "gemini", "anthropic"];

/**
 * The category a row with this declaration resolves to on `family`; undefined
 * = 自动. `family` undefined (the row's channel is not known) keeps a declared
 * category and drops the dialect.
 */
function migrated(category: unknown, dialect: unknown, family: ProtocolFamily | undefined): ThinkingCategoryId | undefined {
  const declared = parseThinkingCategory(category);
  if (!family) return declared;
  if (declared && fitsFamily(THINKING_CATEGORIES[declared], family)) return declared;
  return migrateDialect(parseThinkingDialect(dialect), family)?.id;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

interface LegacyThinking {
  thinkingCategory: unknown;
  thinkingDialect: unknown;
  /** The parked route profiles as stored, keyed by family. */
  routes: unknown;
}

/**
 * The row with its dialects migrated, or undefined when it carries none.
 * `family` is the family of the route the row's own fields belong to
 * (`activeFamily`).
 */
export function migrateLegacyThinking(
  row: LegacyThinking,
  family: ProtocolFamily | undefined,
): { thinkingCategory: ThinkingCategoryId | undefined; routes: unknown } | undefined {
  let changed = row.thinkingDialect != null;
  const thinkingCategory = changed ? migrated(row.thinkingCategory, row.thinkingDialect, family) : parseThinkingCategory(row.thinkingCategory);
  let routes = row.routes;
  if (isRecord(row.routes)) {
    const next: Record<string, unknown> = {};
    for (const [key, prof] of Object.entries(row.routes)) {
      if (!isRecord(prof) || !("thinkingDialect" in prof)) { next[key] = prof; continue; }
      changed = true;
      const { thinkingDialect, ...rest } = prof;
      const f = FAMILIES.includes(key as ProtocolFamily) ? (key as ProtocolFamily) : undefined;
      const cat = migrated(rest.thinkingCategory, thinkingDialect, f);
      next[key] = cat ? { ...rest, thinkingCategory: cat } : (({ thinkingCategory: _drop, ...keep }) => keep)(rest);
    }
    routes = next;
  }
  return changed ? { thinkingCategory, routes } : undefined;
}
