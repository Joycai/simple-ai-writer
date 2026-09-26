/**
 * The `@` picker's matching, ranking and scoping — the pure half of
 * `components/common/MentionPicker`.
 *
 * Why it is not `filterMentions`'s `includes` any more: with a few hundred
 * entries and files, "not found" had three causes that no amount of typing
 * fixed. An empty query took the first ten candidates, and the candidates
 * were entries first — so a file never showed until the author typed. A typed
 * query was a plain substring test with no ranking, still cut at ten. And only
 * the *name* was looked at: an entry's aliases and a document's group path,
 * both of which ⌘K already searches, were invisible here.
 *
 * Three rules, each the same as ⌘K's (`globalSearch`) so an author learns one
 * search:
 *
 * - **Scoring is `matchText`** — substring > word start > subsequence, every
 *   space-separated token must hit. A name hit outranks an alias hit outranks
 *   a group-path hit (×1 / ×0.9 / ×0.5, `searchLore` / `searchFiles` weights).
 * - **An empty query interleaves by kind** — entry, document, image, entry …
 *   — instead of scoring. Ten rows are for recognising, and the author who
 *   just typed `@` should see that both kinds are there; the scope chips are
 *   how they ask for only one.
 * - **Scope filters before anything else.** `"all"` is every candidate; a
 *   named scope is one kind. Recordings and video are files that are not
 *   pictures, so they sit in the document scope — the scopes say *file or
 *   entry*; pictures stand apart only because they look different in the list
 *   and because whether they appear at all depends on the model.
 *
 * Structural item types rather than the picker's `MentionItem`: `lib` never
 * imports from `components` (layering.test.ts), and the two shapes here are
 * all this module reads.
 */
import { dirName, projectRelative } from "../paths";
import { matchText, type MatchRange } from "./globalSearch";

// The scope vocabulary and the result shapes become exports when the picker
// (the next slice) consumes them — exportReach.test.ts holds them local until then.
type MentionScope = "all" | "lore" | "text" | "image";

/** The scopes an author can pick, in chip order. `"all"` first, always. */
const MENTION_SCOPES: readonly MentionScope[] = ["all", "lore", "text", "image"];

interface LoreMentionLike {
  type: "lore";
  entity: { name: string; aliases: readonly string[] };
}
interface FileMentionLike {
  type: "file";
  file: { name: string; path: string; kind: "image" | "text" | "media" };
}
export type MentionLike = LoreMentionLike | FileMentionLike;

type ScopedKind = Exclude<MentionScope, "all">;

/** Which single scope a candidate belongs to. */
export function scopeOf(item: MentionLike): ScopedKind {
  if (item.type === "lore") return "lore";
  return item.file.kind === "image" ? "image" : "text";
}

/**
 * The scopes worth offering for these candidates: `"all"` plus every kind that
 * is actually present. A chip for a kind with nothing behind it is a switch
 * that does nothing — the subagent chips' rule (what cannot be used is not
 * drawn) applies here too. The one exception is `"text"`, kept whenever any
 * file is offered at all, so the chip row does not change shape between a
 * project with pictures and one without.
 */
export function availableScopes(items: readonly MentionLike[]): MentionScope[] {
  const present = new Set(items.map(scopeOf));
  return MENTION_SCOPES.filter((s) => s === "all" || present.has(s as ScopedKind));
}

/**
 * The picker row's second line: a document's group path relative to the
 * project, so two chapters with one name can be told apart. Nothing for an
 * entry (aliases are matched, not shown) and nothing for a file at the root.
 */
export function mentionSub(item: MentionLike, projectPath: string | null): string | null {
  if (item.type !== "file") return null;
  const rel = projectPath ? projectRelative(projectPath, item.file.path) : null;
  const dir = dirName(rel ?? "");
  return dir && dir !== "/" ? dir : null;
}

interface MentionHit {
  /** Highlight ranges over the label (name). */
  label: MatchRange[];
  /** Highlight ranges over the second line (group path), when the hit is there. */
  sub: MatchRange[];
  /** Highlight ranges over the alias that matched, when the hit is there. */
  alias: string | null;
}

interface MentionSearchResult<T> {
  items: T[];
  /** Per shown item, keyed by index into `items`. Empty for an empty query. */
  hits: Map<number, MentionHit>;
}

const ALIAS_WEIGHT = 0.9;
const DIR_WEIGHT = 0.5;

interface Scored<T> {
  item: T;
  order: number;
  score: number;
  hit: MentionHit;
}

function scoreOne<T extends MentionLike>(item: T, term: string, projectPath: string | null): Omit<Scored<T>, "order"> | null {
  const label = item.type === "lore" ? item.entity.name : item.file.name;
  const byName = matchText(label, term);
  if (byName) return { item, score: byName.score, hit: { label: byName.ranges, sub: [], alias: null } };
  if (item.type === "lore") {
    let best: Omit<Scored<T>, "order"> | null = null;
    for (const a of item.entity.aliases) {
      const m = matchText(a, term);
      if (m && (!best || m.score * ALIAS_WEIGHT > best.score)) {
        best = { item, score: m.score * ALIAS_WEIGHT, hit: { label: [], sub: [], alias: a } };
      }
    }
    return best;
  }
  const sub = mentionSub(item, projectPath);
  if (!sub) return null;
  const byDir = matchText(sub, term);
  if (!byDir) return null;
  return { item, score: byDir.score * DIR_WEIGHT, hit: { label: [], sub: byDir.ranges, alias: null } };
}

/**
 * Round-robin over the kinds in `MENTION_SCOPES` order until `limit` is
 * reached: entry, document, image, entry, … A kind that runs out is skipped
 * and the others keep going, so the total is still `limit` when there are
 * that many candidates.
 */
function interleave<T extends MentionLike>(items: readonly T[], limit: number): T[] {
  const lanes = new Map<ScopedKind, T[]>();
  for (const item of items) {
    const k = scopeOf(item);
    const lane = lanes.get(k);
    if (lane) lane.push(item);
    else lanes.set(k, [item]);
  }
  const order = MENTION_SCOPES.filter((s): s is ScopedKind => s !== "all" && lanes.has(s));
  const out: T[] = [];
  const cursor = new Map<ScopedKind, number>(order.map((k) => [k, 0]));
  while (out.length < limit) {
    let took = false;
    for (const k of order) {
      const lane = lanes.get(k)!;
      const i = cursor.get(k)!;
      if (i >= lane.length) continue;
      out.push(lane[i]);
      cursor.set(k, i + 1);
      took = true;
      if (out.length >= limit) break;
    }
    if (!took) break;
  }
  return out;
}

/**
 * The picker's list for one keystroke: scope, then query, then the cut.
 *
 * `projectPath` is what makes a document's group path searchable and
 * showable; pass null where there is no project (the list then matches names
 * only, as before).
 */
export function searchMentions<T extends MentionLike>(
  items: readonly T[],
  query: string,
  scope: MentionScope,
  projectPath: string | null,
  limit = 10,
): MentionSearchResult<T> {
  const scoped = scope === "all" ? items : items.filter((i) => scopeOf(i) === scope);
  const term = query.trim();
  if (!term) return { items: interleave(scoped, limit), hits: new Map() };
  const scored: Scored<T>[] = [];
  scoped.forEach((item, order) => {
    const s = scoreOne(item, term, projectPath);
    if (s) scored.push({ ...s, order });
  });
  // Stable on the candidates' own order: two equal scores keep the order the
  // host offered them in, which is the order the author already knows.
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const top = scored.slice(0, limit);
  return {
    items: top.map((s) => s.item),
    hits: new Map(top.map((s, i) => [i, s.hit])),
  };
}

/**
 * How many candidates of each kind match `query` — for the empty-scope line
 * («文档里有 3 篇 · Tab 切过去»). Counts, never cuts, and never scopes: the
 * point is to say what the *other* chips would show.
 */
export function countByScope(
  items: readonly MentionLike[],
  query: string,
  projectPath: string | null,
): Record<ScopedKind, number> {
  const counts: Record<ScopedKind, number> = { lore: 0, text: 0, image: 0 };
  const term = query.trim();
  for (const item of items) {
    if (term && !scoreOne(item, term, projectPath)) continue;
    counts[scopeOf(item)]++;
  }
  return counts;
}
