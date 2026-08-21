/**
 * Executing a plan.
 *
 * The plan (`./plan`) decides *what*; this decides *how*, under three rules the
 * rest of the feature depends on:
 *
 * **1. Nothing local is ever unlinked.** An entry a pull replaces or removes is
 * *moved* into `.ai-writer/backups/`, the same flat directory
 * `applyLoreImport`'s `displaceEntity` and the agent's `delete_lore_entity`
 * already use. A knowledge base is tens of hours of the author's work and the
 * app has no undo for it; one place to look is the whole recovery story.
 *
 * **2. A pull snapshots the entire tree first, outside the project.** Per-entry
 * backups cover a per-entry mistake; they do not cover "I pulled the wrong
 * direction". The whole-tree zip does, and it costs a second (docs §14.3). It
 * lands in the app's data directory rather than in `.ai-writer/backups/`
 * because the project folder is the thing being overwritten: a safety net
 * stored inside it shares the fate of a folder restored, moved or synced by
 * some other tool.
 *
 * **3. Every write carries a precondition, even when the author accepted the
 * warnings.** Those are different guarantees: the author accepted what the plan
 * *showed them*, while `If-Match` catches what changed on the server between
 * the plan being drawn and this write landing. Dropping the header because the
 * author clicked through a warning would remove the second one silently.
 *
 * A step that fails does not abort the run: the remaining entries are still
 * worth syncing, and the snapshot advances only for the ones that landed, so a
 * retry re-plans the rest correctly instead of treating them all as conflicts.
 * A step the author *skipped* is the same case seen from the other end — it
 * never reaches here at all (`actionableSteps`), so the two sides stay
 * genuinely out of sync and the next plan says so again.
 */

import {
  fileExists,
  makeDir,
  readBinaryFile,
  removeDir,
  removeFile,
  renamePath,
  writeBinaryFile,
} from "../fs/fileio";
import type { SyncBinding, SyncPlan, SyncStep } from "./model";
import { actionableSteps } from "./plan";
import type { Expect, SyncClient } from "./client";
import { SyncConflictError } from "./client";
import { entryDir, hashEntryDir, loreRoot, unzipEntry, zipEntry } from "./local";
import { advanceSnapshot, syncStagingPath } from "./store";

export interface StepFailure {
  path: string;
  /** True when the server moved since the plan was drawn — re-plan and retry. */
  conflict: boolean;
  message: string;
}

export interface SyncRunResult {
  /** Paths that reached the intended state on both sides. */
  succeeded: string[];
  failures: StepFailure[];
  /** Where the pre-pull whole-tree backup went; null for a push. */
  backupPath: string | null;
  /** The binding to persist: snapshot advanced for what actually landed. */
  binding: SyncBinding;
}

/**
 * `.ai-writer/backups/` is where anything displaced goes. Flat and timestamped,
 * matching what the rest of the app writes there so one listing shows
 * everything recoverable regardless of which feature displaced it.
 */
function backupsDir(projectPath: string): string {
  return `${projectPath.replace(/\\/g, "/")}/.ai-writer/backups`;
}

/** A filesystem-safe stem for an entry path (`characters/爱丽丝`). */
function flatten(path: string): string {
  return path.replace(/[/\\]/g, "-");
}

export interface RunOptions {
  projectPath: string;
  binding: SyncBinding;
  client: SyncClient;
  plan: SyncPlan;
  /** Progress callback, called before each step is attempted. */
  onProgress?: (done: number, total: number, path: string) => void;
}

export async function runSync(options: RunOptions): Promise<SyncRunResult> {
  const { projectPath, binding, plan, onProgress } = options;
  const steps = actionableSteps(plan);

  const staging = syncStagingPath(projectPath);
  // A previous run that was killed mid-flight leaves its scratch behind; the
  // directory is disposable by definition, so clearing it is the cheapest way
  // to keep names from colliding with a half-finished unpack.
  await removeDir(staging).catch(() => {});
  await makeDir(staging);

  const backupPath = plan.direction === "pull" ? await backupLoreTree(projectPath, staging) : null;

  const succeeded: string[] = [];
  const failures: StepFailure[] = [];
  const reached: Record<string, string> = {};
  // Entries whose snapshot value this run is entitled to move. Steps that ran
  // are added as they land; the ones seeded here are those the plan found
  // *already identical* on both sides — they are in sync whether or not
  // anything executed, and leaving them out is how a snapshot ends up missing
  // the very entries a later edit will be judged against. (Absent from the
  // snapshot, an edit on one side reads as "both sides moved", so a push of
  // your own work would be reported as a two-sided conflict.)
  const settled: string[] = [];
  for (const step of plan.steps) {
    if (step.action !== "none") continue;
    settled.push(step.path);
    // Both sides agree there is nothing here: `advanceSnapshot` drops it.
    if (step.sourceHash) reached[step.path] = step.sourceHash;
  }

  for (const [index, step] of steps.entries()) {
    onProgress?.(index, steps.length, step.path);
    try {
      if (plan.direction === "push") await pushStep(options, step, staging);
      else await pullStep(options, step, staging);
      succeeded.push(step.path);
      settled.push(step.path);
      // The state both sides now hold. A delete leaves nothing, and
      // `advanceSnapshot` reads the missing key as "drop it".
      if (step.sourceHash) reached[step.path] = step.sourceHash;
    } catch (err) {
      failures.push({
        path: step.path,
        conflict: err instanceof SyncConflictError,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  onProgress?.(steps.length, steps.length, "");

  await removeDir(staging).catch(() => {});

  return {
    succeeded,
    failures,
    backupPath,
    binding: {
      ...binding,
      snapshot: advanceSnapshot(binding.snapshot, reached, settled),
      // Stamped only when everything landed. A partial run leaves the previous
      // timestamp, so "last synced" never claims a completeness it lacks.
      lastSyncAt: failures.length === 0 ? new Date().toISOString() : binding.lastSyncAt,
    },
  };
}

/**
 * Zip the whole lore tree into the app's data directory before a pull.
 *
 * Throws rather than degrading: a pull whose safety net is missing is exactly
 * the run that should not start.
 *
 * Named for the project and the minute so a listing reads as a history rather
 * than a pile of hashes. Seconds are left out — two pulls of the same project
 * inside one minute would collide, and the second one overwriting the first is
 * the right outcome: they describe the same pre-pull state.
 */
async function backupLoreTree(projectPath: string, staging: string): Promise<string> {
  const { appDataDir } = await import("@tauri-apps/api/path");
  const root = `${(await appDataDir()).replace(/\\/g, "/").replace(/\/+$/, "")}/backups`;
  await makeDir(root);

  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const project = projectPath.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "project";
  const dest = `${root}/${stamp}-${project}.zip`;

  // Written via the staging directory first so a failure part-way leaves no
  // truncated archive sitting among the backups looking like a usable one.
  const tmp = `${staging}/lore-backup.zip`;
  await zipEntry(loreRoot(projectPath), tmp);
  await renamePath(tmp, dest);
  return dest;
}

/** The precondition a step implies — see rule 3 in the module docs. */
function expectationFor(step: SyncStep): Expect {
  return step.targetHash === null ? { kind: "absent" } : { kind: "hash", hash: step.targetHash };
}

async function pushStep(options: RunOptions, step: SyncStep, staging: string): Promise<void> {
  const { projectPath, binding, client } = options;
  const expect = expectationFor(step);

  if (step.action === "delete") {
    await client.deleteEntry(binding.kbId, step.path, expect);
    return;
  }

  const zipPath = `${staging}/push-${flatten(step.path)}.zip`;
  const files = await zipEntry(entryDir(projectPath, step.path), zipPath);
  if (files === 0) {
    // An entry directory holding nothing the archive would carry. Uploading it
    // would replace a real remote entry with an empty one under a hash that
    // describes emptiness — a silent deletion wearing an overwrite's clothes.
    throw new Error(`"${step.path}" has no files to upload — it looks empty on disk`);
  }
  const bytes = await readBinaryFile(zipPath);
  // `step.sourceHash` is what the plan was drawn against; sending it (rather
  // than re-hashing here) keeps the value the author approved and the value the
  // server records identical.
  await client.uploadEntry(binding.kbId, step.path, step.sourceHash!, bytes, expect);
  await removeFile(zipPath).catch(() => {});
}

async function pullStep(options: RunOptions, step: SyncStep, staging: string): Promise<void> {
  const { projectPath, binding, client } = options;
  const target = entryDir(projectPath, step.path);

  if (step.action === "delete") {
    await displace(projectPath, step.path, target);
    return;
  }

  const stem = flatten(step.path);
  const zipPath = `${staging}/pull-${stem}.zip`;
  const unpacked = `${staging}/unpack-${stem}`;

  const { bytes, hash } = await client.downloadEntry(binding.kbId, step.path);
  await writeBinaryFile(zipPath, bytes);
  await removeDir(unpacked).catch(() => {});
  await unzipEntry(zipPath, unpacked);

  // Verify before anything is displaced. The server's header, the plan's
  // expectation and what actually unpacked all have to agree — a mismatch means
  // the archive is not what either side thought, and the one thing that must
  // not happen is the author's copy being moved aside to make room for it.
  const landed = await hashEntryDir(unpacked);
  const expected = step.sourceHash;
  if (landed !== expected || (hash && hash !== expected)) {
    throw new Error(
      `"${step.path}" did not arrive intact (expected ${short(expected)}, ` +
        `server said ${short(hash)}, unpacked as ${short(landed)}) — nothing was changed`,
    );
  }

  const displaced = (await fileExists(target)) ? await displace(projectPath, step.path, target) : null;
  await makeDir(target.slice(0, target.lastIndexOf("/")));
  try {
    await renamePath(unpacked, target);
  } catch (err) {
    // The move in failed with the author's entry already out of the way. Put it
    // back before reporting, or a failed pull would read as a deletion — the
    // same recovery `applyLoreImport` performs, for the same reason.
    if (displaced) {
      try {
        await renamePath(displaced, target);
      } catch (restoreErr) {
        throw new Error(
          `Could not write "${step.path}", and the entry it was replacing could not be restored ` +
            `either. It is at ${displaced} — move it back to ${target} by hand. ` +
            `(${String(err)}; ${String(restoreErr)})`,
        );
      }
    }
    throw err;
  }
  await removeFile(zipPath).catch(() => {});
}

/** Move an entry directory into `backups/` and return where it went. */
async function displace(projectPath: string, path: string, dir: string): Promise<string> {
  await makeDir(backupsDir(projectPath));
  const dest = `${backupsDir(projectPath)}/replaced-${Date.now()}-${flatten(path)}`;
  await renamePath(dir, dest);
  return dest;
}

function short(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 8)}…` : "nothing";
}
