/**
 * The recent-projects list's parsing and multi-instance merge — pure, so the
 * store (`appStore`) keeps only the wiring and this logic is testable without
 * a DOM.
 *
 * The list is one preference row (`app:recentProjects`, a JSON array), which
 * makes it the row several app instances write concurrently: each opens its
 * own project and saves the *whole* list from its own snapshot, so plain
 * last-writer-wins drops the other instance's entry. `mergeRecentProjects` is
 * the resolution `lib/prefs.writePrefMerged` applies at persist time — a
 * union that keeps this instance's ordering.
 */
import { isSamePath, toPosixPath } from "./paths";

export const RECENT_PROJECTS_MAX = 10;

/**
 * A stored value (whatever build wrote it) as a clean list: strings only,
 * normalised to the app's POSIX spelling — entries written by an older build
 * carry the host's spelling, and one of them reopened from this list becomes
 * `projectPath` verbatim. Deduped by path identity for the same reason:
 * otherwise the same project appears twice, once per spelling, and the cap
 * quietly evicts an older one.
 */
export function sanitizeRecentProjects(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) return [];
  const seen: string[] = [];
  for (const p of parsed) {
    if (typeof p !== "string") continue;
    const norm = toPosixPath(p);
    if (!seen.some((q) => isSamePath(q, norm))) seen.push(norm);
  }
  return seen.slice(0, RECENT_PROJECTS_MAX);
}

/** `sanitizeRecentProjects` over a raw pref value; unreadable means empty. */
export function parseRecentProjects(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return sanitizeRecentProjects(JSON.parse(raw));
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
 */
export function mergeRecentProjects(dbRaw: string | null, ours: string): string {
  const merged = parseRecentProjects(ours);
  for (const p of parseRecentProjects(dbRaw)) {
    if (!merged.some((q) => isSamePath(q, p))) merged.push(p);
  }
  return JSON.stringify(merged.slice(0, RECENT_PROJECTS_MAX));
}
