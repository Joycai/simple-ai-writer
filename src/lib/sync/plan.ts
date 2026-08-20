/**
 * The three-way comparison — the safety rail of the whole sync feature.
 *
 * Comparing local against remote can only say *that* they differ. It cannot say
 * **who moved**, and without that every overwrite is a coin flip: replacing a
 * colleague's newer entry with your untouched older copy looks exactly like
 * pushing your own edit. So the plan is computed from three inputs — the local
 * hashes, the remote hashes, and the snapshot taken at the end of the last
 * successful sync (`SyncBinding.snapshot`):
 *
 * ```text
 *                    local changed?   remote changed?
 *   push, safe             yes              no        your edit goes up
 *   pull, safe             no               yes       their edit comes down
 *   either, DANGER         yes              yes       one of them is lost
 *   push over newer        no               yes       your stale copy wins
 * ```
 *
 * The rule this file implements, in one line: **a step is dangerous exactly
 * when the side being overwritten changed since the last sync.** Everything
 * else here is bookkeeping around that sentence.
 *
 * Pure and store-free on purpose — it takes three plain hash maps and returns a
 * plan. That is what lets the interesting cases be tested as data instead of by
 * driving a server and two filesystems.
 */

import type {
  EntryPath,
  HashMap,
  SyncAction,
  SyncDirection,
  SyncPlan,
  SyncStep,
  SyncWarning,
} from "./model";

export interface PlanInput {
  local: HashMap;
  remote: HashMap;
  /** Hashes as of the last completed sync. Empty on the first one. */
  snapshot: HashMap;
  direction: SyncDirection;
}

/**
 * Compute what a sync in `direction` would do, entry by entry.
 *
 * Mirror semantics: the receiving side ends up as a copy of the sending side,
 * so entries the receiver has and the sender does not are **deleted**, not left
 * alone. Leaving them would make deletions un-syncable — remove an entry on one
 * machine, push, pull on the other, and it is still there; push back and it
 * returns to the first (docs §14.1).
 */
export function planSync({ local, remote, snapshot, direction }: PlanInput): SyncPlan {
  const paths = [...new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(snapshot)])].sort();
  const firstSync = Object.keys(snapshot).length === 0;

  const steps = paths.map((path) => step(path, local[path], remote[path], snapshot[path], direction));

  const summary = {
    create: steps.filter((s) => s.action === "create").length,
    overwrite: steps.filter((s) => s.action === "overwrite").length,
    delete: steps.filter((s) => s.action === "delete").length,
    unchanged: steps.filter((s) => s.action === "none").length,
    warnings: steps.filter((s) => s.warning !== null).length,
  };

  return { direction, steps, firstSync, summary };
}

function step(
  path: EntryPath,
  localHash: string | undefined,
  remoteHash: string | undefined,
  snapshotHash: string | undefined,
  direction: SyncDirection,
): SyncStep {
  // "Changed" is measured against the snapshot, and an entry that is absent on
  // one side is as much a state as one that is present: appearing and being
  // deleted are both changes, and both matter to whether an overwrite is safe.
  const localChanged = localHash !== snapshotHash;
  const remoteChanged = remoteHash !== snapshotHash;

  const [sourceHash, targetHash] =
    direction === "push" ? [localHash, remoteHash] : [remoteHash, localHash];

  const base = {
    path,
    sourceHash: sourceHash ?? null,
    targetHash: targetHash ?? null,
    localChanged,
    remoteChanged,
  };

  // Identical content is the end state a sync is trying to reach, so there is
  // nothing to do and nothing to warn about — even when both sides edited their
  // way here independently, and even when the snapshot disagrees with both.
  if (sourceHash === targetHash) {
    return { ...base, action: "none", warning: null };
  }

  const action: SyncAction =
    sourceHash === undefined ? "delete" : targetHash === undefined ? "create" : "overwrite";

  return { ...base, action, warning: warningFor(action, localChanged, remoteChanged, direction) };
}

/**
 * Whether this step discards something, and what kind of something.
 *
 * Only the **receiving** side's history matters: overwriting a target that has
 * not moved since the last sync loses nothing, however much the source has
 * changed. `both-changed` is reported ahead of the single-sided reasons because
 * it is the one case where no direction is safe.
 */
function warningFor(
  action: SyncAction,
  localChanged: boolean,
  remoteChanged: boolean,
  direction: SyncDirection,
): SyncWarning | null {
  const targetChanged = direction === "push" ? remoteChanged : localChanged;
  if (!targetChanged) return null;

  const sourceChanged = direction === "push" ? localChanged : remoteChanged;
  if (sourceChanged) return "both-changed";

  switch (action) {
    // The target gained or edited this entry while the source sat still, so the
    // source's copy is the older one — the classic "pushed stale work" mistake.
    case "overwrite":
      return "overwrites-newer";
    // The target deleted it and the source still has the pre-deletion copy.
    case "create":
      return "resurrects";
    // The target has it and the source never did. Reachable only when the
    // snapshot lacks the entry too — if it held it, the source's absence would
    // be a change as well and `both-changed` above would have claimed this.
    case "delete":
      return "deletes-unsynced";
    default:
      return null;
  }
}

/** The steps a sync would actually execute, in a deterministic order. */
export function actionableSteps(plan: SyncPlan): SyncStep[] {
  return plan.steps.filter((s) => s.action !== "none");
}

/** True when running this plan would discard something on the receiving side. */
export function hasWarnings(plan: SyncPlan): boolean {
  return plan.summary.warnings > 0;
}
