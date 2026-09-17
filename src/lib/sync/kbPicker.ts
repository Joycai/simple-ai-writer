/**
 * 绑定时挑一个服务器库 —— the pure half of Settings → 同步与备份's picker
 * (filter, sort, the one recommendation, the relative age on each row).
 *
 * A server that serves several authors, or one author's many projects, holds
 * dozens of knowledge bases; listed flat they pushed the bind button off the
 * bottom of the page. The picker answers that with three things, all decided
 * here so they are testable as data: a **recommendation** that is right most of
 * the time, a **search** over names, and a **sort**. None of it reads anything
 * the server does not already send in `RemoteKb` — the recommendation is a
 * guess from names and `lastDevice`, never a claim about content, which is why
 * it only ever offers and never binds on its own.
 *
 * Design and reasons: `docs/feature/knowledge-base/sync-lore-ui-brief.md` §绑定选择器.
 */

import type { RemoteKb } from "./client";

export type KbSort = "recent" | "name" | "entries";
export const KB_SORTS: readonly KbSort[] = ["recent", "name", "entries"];

/** Case-insensitive substring match on the name; a blank query keeps everything. */
export function filterKbs(kbs: readonly RemoteKb[], query: string): RemoteKb[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...kbs];
  return kbs.filter((kb) => kb.name.toLocaleLowerCase().includes(q));
}

/**
 * Newest first by default — the base an author wrote into last is the likeliest
 * target. Ties (and the other two orders' ties) fall back to the name, so the
 * list never reshuffles between two renders of the same data.
 */
export function sortKbs(kbs: readonly RemoteKb[], sort: KbSort, locale?: string): RemoteKb[] {
  const byName = (a: RemoteKb, b: RemoteKb) => a.name.localeCompare(b.name, locale);
  const out = [...kbs];
  switch (sort) {
    case "name":
      return out.sort(byName);
    case "entries":
      return out.sort((a, b) => b.entryCount - a.entryCount || byName(a, b));
    default:
      return out.sort((a, b) => b.updatedAtMs - a.updatedAtMs || byName(a, b));
  }
}

type KbRecommendReason = "same-name" | "this-device";

interface KbRecommendation {
  kb: RemoteKb;
  reason: KbRecommendReason;
}

/**
 * The one base worth offering before the list.
 *
 * 1. A base named like the project (trimmed, case-insensitive) — the name the
 *    new-base form suggests, so a project pushed from another machine comes
 *    back under it. Several such bases: the newest.
 * 2. Otherwise the newest base this machine wrote last (`lastDevice`) — what
 *    the author was working on here before the project was moved or re-cloned.
 *
 * Nothing else. A weaker guess (newest overall) would be wrong about as often
 * as right, and a recommendation that is often wrong teaches the author to
 * skip it.
 */
export function recommendKb(
  kbs: readonly RemoteKb[],
  projectName: string,
  device: string,
): KbRecommendation | null {
  const newest = (list: RemoteKb[]) => sortKbs(list, "recent")[0] ?? null;
  const name = projectName.trim().toLocaleLowerCase();
  if (name) {
    const same = newest(kbs.filter((kb) => kb.name.trim().toLocaleLowerCase() === name));
    if (same) return { kb: same, reason: "same-name" };
  }
  if (device) {
    const mine = newest(kbs.filter((kb) => kb.lastDevice === device));
    if (mine) return { kb: mine, reason: "this-device" };
  }
  return null;
}

type RelativeAge =
  | { unit: "never" }
  | { unit: "today" }
  | { unit: "yesterday" }
  | { unit: "days" | "months" | "years"; n: number };

const DAY_MS = 86_400_000;

/**
 * "3 天前" for a row that has no room for a timestamp (the full one stays in
 * the row's tooltip). Counted in **local calendar days**, not 24-hour spans, so
 * something written last night at 23:50 reads 昨天 this morning. A timestamp in
 * the future (another machine's clock is ahead) reads 今天 rather than a
 * negative number.
 */
export function relativeAge(ms: number, now: number = Date.now()): RelativeAge {
  if (!ms || ms <= 0) return { unit: "never" };
  const startOf = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((startOf(now) - startOf(ms)) / DAY_MS);
  if (days <= 0) return { unit: "today" };
  if (days === 1) return { unit: "yesterday" };
  if (days < 30) return { unit: "days", n: days };
  if (days < 365) return { unit: "months", n: Math.floor(days / 30) };
  return { unit: "years", n: Math.floor(days / 365) };
}
