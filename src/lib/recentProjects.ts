/**
 * The recent-projects list — parsing, the pin set, and the multi-instance
 * merge. Pure, so the store (`appStore`) keeps only the wiring and this logic
 * is testable without a DOM.
 *
 * The list is one preference row (`app:recentProjects`, a JSON array), which
 * makes it the row several app instances write concurrently: each opens its
 * own project and saves the *whole* list from its own snapshot, so plain
 * last-writer-wins drops the other instance's entry. `mergeRecentProjects` is
 * the resolution `lib/prefs.writePrefMerged` applies at persist time — a
 * union that keeps this instance's ordering.
 *
 * **Pins** (`app:pinnedProjects`, its own row) are a *set of markers over the
 * same paths*, not a second list of projects: a pinned entry is exempt from
 * the cap's eviction and from 清空, and sorts above the rest. Two consequences
 * the callers must not lose:
 *
 * - the cap counts **unpinned** entries only, so every function that trims
 *   takes the pin set (`capRecentProjects`, and through it sanitize/parse/
 *   merge — the merge included, or a concurrent write would evict a pin);
 * - `splitProjects` renders the pinned section from the **pin row**, not from
 *   the recents. A cross-instance race can drop a path from the recents while
 *   the pin survives (removals are overwrites — see below), and a pin the
 *   author can no longer see is a pin they cannot release.
 *
 * Both rows are machine-local (`MACHINE_LOCAL_PREF_KEYS`): they are absolute
 * paths, which mean nothing on the next computer.
 */
import { isSamePath, toPosixPath } from "./paths";

/**
 * How many **unpinned** entries the list keeps. Pinned ones ride along outside
 * this count — that is what "固定" buys.
 */
export const RECENT_PROJECTS_MAX = 10;

function containsPath(list: readonly string[], path: string): boolean {
  return list.some((p) => isSamePath(p, path));
}

/** Is this path pinned? Path identity, not string equality (spellings differ). */
export function isProjectPinned(pinned: readonly string[], path: string): boolean {
  return containsPath(pinned, path);
}

/**
 * A stored value (whatever build wrote it) as a clean list: strings only,
 * normalised to the app's POSIX spelling — entries written by an older build
 * carry the host's spelling, and one of them reopened from this list becomes
 * `projectPath` verbatim. Deduped by path identity for the same reason:
 * otherwise the same project appears twice, once per spelling, and the cap
 * quietly evicts an older one.
 */
function normalisePaths(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) return [];
  const seen: string[] = [];
  for (const p of parsed) {
    if (typeof p !== "string") continue;
    const norm = toPosixPath(p);
    if (!containsPath(seen, norm)) seen.push(norm);
  }
  return seen;
}

/**
 * Trim to at most `RECENT_PROJECTS_MAX` **unpinned** entries, oldest first —
 * pinned ones are kept wherever they sit. Order is otherwise untouched: this
 * list is recency-ordered, and the pinned-first arrangement is a view
 * (`splitProjects`), not a stored order.
 */
export function capRecentProjects(
  list: readonly string[],
  pinned: readonly string[] = [],
): string[] {
  const out: string[] = [];
  let unpinned = 0;
  for (const p of list) {
    if (isProjectPinned(pinned, p)) {
      out.push(p);
      continue;
    }
    if (unpinned >= RECENT_PROJECTS_MAX) continue;
    unpinned++;
    out.push(p);
  }
  return out;
}

/** `normalisePaths` + the pin-aware cap. */
export function sanitizeRecentProjects(parsed: unknown, pinned: readonly string[] = []): string[] {
  return capRecentProjects(normalisePaths(parsed), pinned);
}

/** `sanitizeRecentProjects` over a raw pref value; unreadable means empty. */
export function parseRecentProjects(raw: string | null, pinned: readonly string[] = []): string[] {
  if (!raw) return [];
  try {
    return sanitizeRecentProjects(JSON.parse(raw), pinned);
  } catch {
    return [];
  }
}

/**
 * The pin row, cleaned the same way — **uncapped**. Every entry here is one
 * the author put there by hand, and a cap could only express itself as a pin
 * that silently did not take.
 */
export function sanitizePinnedProjects(parsed: unknown): string[] {
  return normalisePaths(parsed);
}

/** `sanitizePinnedProjects` over a raw pref value; unreadable means empty. */
export function parsePinnedProjects(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return sanitizePinnedProjects(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Combine the database's current row with ours: our order first (the project
 * just opened here belongs on top *here*), then whatever the other instance
 * knows that we don't, capped as usual. Additions from both sides survive;
 * what this deliberately does not preserve is a *removal* raced against
 * another instance's write — the removed path can resurface from the other
 * side's copy, which is why `removeRecentProject`/`clearRecentProjects` stay
 * plain overwrites (a merge there would resurrect the entry immediately) and
 * accept the smaller wart.
 *
 * `pinned` is this instance's pin set: without it the union's cap would evict
 * a pinned project the moment another instance opened something.
 */
export function mergeRecentProjects(
  dbRaw: string | null,
  ours: string,
  pinned: readonly string[] = [],
): string {
  const merged = parseRecentProjects(ours, pinned);
  for (const p of parseRecentProjects(dbRaw, pinned)) {
    if (!containsPath(merged, p)) merged.push(p);
  }
  return JSON.stringify(capRecentProjects(merged, pinned));
}

/**
 * Same union for the pin row — a pin made in another instance must survive
 * this one saving its own snapshot. Unpinning is an overwrite for the reason
 * removal is (a merge would put the pin straight back).
 */
export function mergePinnedProjects(dbRaw: string | null, ours: string): string {
  const merged = parsePinnedProjects(ours);
  for (const p of parsePinnedProjects(dbRaw)) {
    if (!containsPath(merged, p)) merged.push(p);
  }
  return JSON.stringify(merged);
}

/**
 * The two groups the panel draws: pinned entries in **pin order** (the order
 * the row is stored in — a new pin is appended, so the ones already there do
 * not move), then the recents that aren't pinned.
 *
 * The pinned group comes from the pin row rather than from `recents` on
 * purpose — see the module header. The cost is that a pinned path which is no
 * longer in the recents still shows, which is the behaviour we want anyway:
 * that is exactly the project the author asked to keep.
 */
export function splitProjects(
  recents: readonly string[],
  pinned: readonly string[],
): { pinned: string[]; recent: string[] } {
  return {
    pinned: [...pinned],
    recent: recents.filter((p) => !isProjectPinned(pinned, p)),
  };
}

// ─── When each project was last opened ───────────────────────────────────────
// Its own row (`app:projectOpenedAt`, a path → epoch-ms map) rather than a
// field on the list, because the list is a plain array of paths in three
// places (two preference rows and the multi-instance merge) and widening it
// would break every one of them for a column only the widest layout shows.
// A path with no stamp is normal — every entry written before this existed —
// and the row simply shows no time.

/** Strings → POSIX keys, finite positive stamps; anything else dropped. */
export function sanitizeOpenedAt(parsed: unknown): Record<string, number> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    const key = toPosixPath(k);
    // Two spellings of one project: keep the later stamp, like the merge does.
    if (!(key in out) || out[key] < v) out[key] = v;
  }
  return out;
}

/** `sanitizeOpenedAt` over a raw pref value; unreadable means empty. */
export function parseOpenedAt(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    return sanitizeOpenedAt(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Union of both instances' stamps, **later wins** — unlike the two lists,
 * where ours wins: a stamp is a fact about when a folder was opened, and the
 * other instance may hold the more recent one.
 */
export function mergeOpenedAt(dbRaw: string | null, ours: string): string {
  const merged = parseOpenedAt(ours);
  for (const [k, v] of Object.entries(parseOpenedAt(dbRaw))) {
    if (!(k in merged) || merged[k] < v) merged[k] = v;
  }
  return JSON.stringify(merged);
}

/** Drop stamps for projects that are no longer listed anywhere. */
export function pruneOpenedAt(
  map: Readonly<Record<string, number>>,
  keep: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) {
    if (containsPath(keep, k)) out[k] = v;
  }
  return out;
}

/**
 * Which shape the row should print: a clock for today and yesterday, a date
 * for anything older. Calendar days in local time, not 24-hour windows —
 * "yesterday 23:50" read at 00:10 is yesterday, not today.
 *
 * Returns the bucket only; the words come from i18n and the date from
 * `Intl.DateTimeFormat`, so this stays pure and locale-free.
 */
export function openedAtKind(ts: number, now: number): "today" | "yesterday" | "older" {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(new Date(now));
  if (ts >= today) return "today";
  if (ts >= today - 86_400_000) return "yesterday";
  return "older";
}
