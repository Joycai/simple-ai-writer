/**
 * When a file last changed, in the words of a card (设计稿 02h 1c).
 *
 * Two sentences use it, each about one file: the delete card's 「最后改于 8 月 3
 * 日」 — whether this is the draft abandoned in spring or the one written this
 * morning — and the undo refusal that says a file changed after the write, which
 * until now could say *that* but not *when*.
 *
 * Asked per path (`fs_stat`), never read off the file tree: the tree is loaded
 * whole on every project open, and a metadata call per entry is a price paid by
 * every project for two sentences.
 */

import type { TFunction } from "i18next";
import { openedAtKind } from "../recentProjects";
import { statPath } from "./fileio";

/**
 * A file's last modification, in ms since the epoch — `undefined` when it is
 * missing, unreadable, or kept on a filesystem with no such time. A card that
 * cannot say when simply leaves the clause out; it is never worth failing over.
 */
export async function modifiedAt(path: string): Promise<number | undefined> {
  try {
    const stat = await statPath(path);
    return stat?.modifiedMs ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 「今天 14:03」「昨天 09:12」「8 月 3 日」「2025 年 12 月 30 日」.
 *
 * Today and yesterday say the clock, because on those days the date is the part
 * the author already knows; older says the date, with the year only when it is
 * not this one. `withTime` adds the clock to an older date too — for the undo
 * refusal, where "8 月 12 日" alone does not tell a hand edit from the write.
 *
 * The day buckets are `openedAtKind`'s (calendar days, local time), so this and
 * the recent-projects list cannot disagree about what "yesterday" is. The words
 * are the locale files'; this only picks the key and fills it.
 */
export function modifiedLabel(
  t: TFunction,
  ms: number,
  opts: { locale: string; now?: number; withTime?: boolean },
): string {
  const now = opts.now ?? Date.now();
  const at = new Date(ms);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

  const kind = openedAtKind(ms, now);
  if (kind === "today") return t("ai.when.today", { time });
  if (kind === "yesterday") return t("ai.when.yesterday", { time });

  const params = {
    year: at.getFullYear(),
    month: at.getMonth() + 1,
    day: at.getDate(),
    monthName: new Intl.DateTimeFormat(opts.locale, { month: "short" }).format(at),
  };
  const date =
    at.getFullYear() === new Date(now).getFullYear()
      ? t("ai.when.date", params)
      : t("ai.when.dateYear", params);
  return opts.withTime ? t("ai.when.dateTime", { date, time }) : date;
}
