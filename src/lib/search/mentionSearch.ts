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
 * - **Scoring is ⌘K's** — substring > word start > subsequence per token,
 *   every space-separated token must hit, and each token may hit a different
 *   field (`潮汐门篇 归途` finds `正文/潮汐门篇/第五章 归途.md`, one word in
 *   the group, one in the name — exactly as `searchFiles` does). A name hit
 *   outranks an alias hit outranks a group-path hit: ×1 / ×0.9 / ×0.6, the
 *   alias weight from `searchLore` and the *directory* weight from
 *   `searchFiles` (its 0.5 is for a word that straddles the `/`, a tier this
 *   list has no use for).
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
import { matchText, mergeRanges, tokenize, type MatchRange } from "./globalSearch";

export type MentionScope = "all" | "lore" | "text" | "image";

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

export type ScopedKind = Exclude<MentionScope, "all">;

/** Which single scope a candidate belongs to. */
export function scopeOf(item: MentionLike): ScopedKind {
  if (item.type === "lore") return "lore";
  return item.file.kind === "image" ? "image" : "text";
}

/**
 * The scopes worth offering for these candidates — the one source for every
 * host's chip row: `"all"`, then every kind that is actually present. A chip
 * for a kind with nothing behind it is a switch that does nothing — the
 * subagent chips' rule (what cannot be used is not drawn) applies here too.
 * The one exception is `"text"`, kept whenever any file is offered at all, so
 * the chip row does not change shape between a project with pictures and one
 * without.
 */
export function availableScopes(items: readonly MentionLike[]): MentionScope[] {
  const present = new Set(items.map(scopeOf));
  if (items.some((i) => i.type === "file")) present.add("text");
  return MENTION_SCOPES.filter((s) => s === "all" || present.has(s as ScopedKind));
}

/**
 * The chip Tab lands on next: one step through `scopes` in either direction,
 * wrapping at both ends. A scope that is not offered (the current one after
 * candidates changed) starts over from `"all"`.
 */
export function cycleScope(scopes: readonly MentionScope[], current: MentionScope, dir: 1 | -1): MentionScope {
  if (scopes.length === 0) return "all";
  const i = scopes.indexOf(current);
  if (i < 0) return scopes[0];
  return scopes[(i + dir + scopes.length) % scopes.length];
}

/**
 * The picker row's second line: a document's group path relative to the
 * project, so two chapters with one name can be told apart. Nothing for an
 * entry (an alias hit shows that alias instead — the picker reads it off
 * `MentionHit`) and nothing for a file at the root.
 */
export function mentionSub(item: MentionLike, projectPath: string | null): string | null {
  if (item.type !== "file") return null;
  const rel = projectPath ? projectRelative(projectPath, item.file.path) : null;
  const dir = dirName(rel ?? "");
  return dir && dir !== "/" ? dir : null;
}

export interface MentionHit {
  /** Highlight ranges over the label (name). */
  label: MatchRange[];
  /** Highlight ranges over the second line (group path), when the hit is there. */
  sub: MatchRange[];
  /** The alias that matched, when the hit is there — shown as the row's second line. */
  alias: string | null;
  /** Highlight ranges over that alias. */
  aliasRanges: MatchRange[];
}

interface MentionSearchResult<T> {
  items: T[];
  /** Per shown item, keyed by index into `items`. Empty for an empty query. */
  hits: Map<number, MentionHit>;
}

const ALIAS_WEIGHT = 0.9;
const DIR_WEIGHT = 0.6;

interface Scored<T> {
  item: T;
  order: number;
  score: number;
  hit: MentionHit;
}

/**
 * Score one candidate against the tokenized query. Each token takes the best
 * of the fields it hits — name, alias (entries) or group path (files) — and
 * the candidate scores only when every token hits somewhere. Taking the best
 * rather than the first is the one place this departs from `searchLore`,
 * whose name-first short-circuit lets a weak subsequence on the name beat a
 * whole-word alias; here an alias is as good as the name it stands for.
 */
function scoreOne<T extends MentionLike>(item: T, tokens: readonly string[], projectPath: string | null): Omit<Scored<T>, "order"> | null {
  const label = item.type === "lore" ? item.entity.name : item.file.name;
  const sub = item.type === "file" ? mentionSub(item, projectPath) : null;
  let score = 0;
  const labelRanges: MatchRange[] = [];
  const subRanges: MatchRange[] = [];
  let alias: string | null = null;
  const aliasRanges: MatchRange[] = [];
  for (const tok of tokens) {
    let best = 0;
    let where: { field: "label" | "alias" | "sub"; ranges: MatchRange[]; alias?: string } | null = null;
    const byName = matchText(label, tok);
    if (byName) { best = byName.score; where = { field: "label", ranges: byName.ranges }; }
    if (item.type === "lore") {
      for (const a of item.entity.aliases) {
        const m = matchText(a, tok);
        if (m && m.score * ALIAS_WEIGHT > best) { best = m.score * ALIAS_WEIGHT; where = { field: "alias", ranges: m.ranges, alias: a }; }
      }
    } else if (sub) {
      const m = matchText(sub, tok);
      if (m && m.score * DIR_WEIGHT > best) { best = m.score * DIR_WEIGHT; where = { field: "sub", ranges: m.ranges }; }
    }
    if (!where) return null;
    score += best;
    if (where.field === "label") labelRanges.push(...where.ranges);
    else if (where.field === "sub") subRanges.push(...where.ranges);
    else if (alias === null || alias === where.alias) {
      // One alias is shown; a second token that matched a different alias
      // still counts for the score but has nowhere to be highlighted.
      alias = where.alias ?? null;
      aliasRanges.push(...where.ranges);
    }
  }
  return { item, score, hit: { label: mergeRanges(labelRanges), sub: mergeRanges(subRanges), alias, aliasRanges: mergeRanges(aliasRanges) } };
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
  const tokens = tokenize(query);
  if (tokens.length === 0) return { items: interleave(scoped, limit), hits: new Map() };
  const scored: Scored<T>[] = [];
  scoped.forEach((item, order) => {
    const s = scoreOne(item, tokens, projectPath);
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

/** Whether any scope has a hit at all — an empty list with nothing anywhere lets Enter through to the host. */
export function hasHits(counts: Record<ScopedKind, number>): boolean {
  return counts.lore + counts.text + counts.image > 0;
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
  const tokens = tokenize(query);
  for (const item of items) {
    if (tokens.length && !scoreOne(item, tokens, projectPath)) continue;
    counts[scopeOf(item)]++;
  }
  return counts;
}
