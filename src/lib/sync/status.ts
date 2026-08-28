/**
 * 本地和服务器,谁比较新 — answered from the same three hash maps the plan
 * reads (`local` × `remote` × the last-sync `snapshot`), never from
 * timestamps. A timestamp can only say *when* a side was written; the
 * snapshot says *which side moved since the author last agreed*, which is the
 * question "should I push or pull" actually asks. It also survives everything
 * that resets mtimes — restoring a backup, copying the project folder — which
 * is exactly when the author most wants a trustworthy answer.
 *
 * Pure on purpose, like `./plan`: three maps in, one verdict out, testable as
 * data. Display-only — nothing here feeds the plan or the executor.
 */

import type { HashMap } from "./model";

export type FreshnessVerdict =
  /** Every entry identical on both sides. */
  | "in-sync"
  /** Only the local side moved since the last sync — push carries it up. */
  | "local-ahead"
  /** Only the remote side moved — some other machine pushed; pull catches up. */
  | "remote-ahead"
  /** Both sides have changes (on the same entries or different ones). */
  | "diverged"
  /** The sides differ but there is no snapshot yet — never synced, so "who
   *  moved" is unanswerable and pretending otherwise would be a guess. */
  | "first-sync";

export interface Freshness {
  verdict: FreshnessVerdict;
  /** Entries only the local side changed since the last sync. */
  localAhead: number;
  /** Entries only the remote side changed since the last sync. */
  remoteAhead: number;
  /** Entries both sides changed — the ones no direction is safe for. */
  diverged: number;
}

export function compareFreshness(local: HashMap, remote: HashMap, snapshot: HashMap): Freshness {
  let localAhead = 0;
  let remoteAhead = 0;
  let diverged = 0;

  const paths = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(snapshot)]);
  for (const path of paths) {
    const l = local[path];
    const r = remote[path];
    // Identical — including "absent on both", which an entry deleted on both
    // sides reaches. Nothing to attribute, even when the snapshot disagrees
    // with both: the sides edited their way to agreement independently.
    if (l === r) continue;
    // Absence is a state like any other (an entry that appeared, or one that
    // was deleted, is a change) — the same rule `plan.ts` applies.
    const localChanged = l !== snapshot[path];
    const remoteChanged = r !== snapshot[path];
    if (localChanged && remoteChanged) diverged += 1;
    else if (localChanged) localAhead += 1;
    else remoteAhead += 1;
  }

  const verdict: FreshnessVerdict =
    localAhead + remoteAhead + diverged === 0
      ? "in-sync"
      : Object.keys(snapshot).length === 0
        ? "first-sync"
        : diverged > 0 || (localAhead > 0 && remoteAhead > 0)
          ? "diverged"
          : localAhead > 0
            ? "local-ahead"
            : "remote-ahead";

  return { verdict, localAhead, remoteAhead, diverged };
}
