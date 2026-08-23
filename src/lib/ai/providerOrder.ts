/**
 * Provider list ordering — the pure reorder step behind the 置顶/上移/下移/置底
 * buttons in Settings → 供应商与模型.
 *
 * Works on id lists rather than Provider objects so the store can apply the
 * result to whatever richer rows it holds, and so the step is testable without
 * fixtures. Persistence is the caller's job: the store writes the resulting
 * positions back as `sort_order` for every provider in one transaction.
 */

export type ProviderMove = "top" | "up" | "down" | "bottom";

/**
 * The id list after moving `id`, or null when the move changes nothing —
 * an unknown id, or one already sitting at the edge it is being sent to.
 * Null rather than the unchanged array, so callers can skip the persistence
 * write (and the re-render) entirely.
 */
export function moveId(ids: readonly string[], id: string, move: ProviderMove): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const to =
    move === "top" ? 0
    : move === "bottom" ? ids.length - 1
    : move === "up" ? from - 1
    : from + 1;
  if (to === from || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
