/**
 * Undo a lore write from the plan ledger (设计稿 02h 1h / 1i).
 *
 * Every L1 write already leaves a backup, so "undo" is not the hard part. The
 * hard part is the case the design did not draw: **the file moved on after the
 * write.** The author edited it by hand, or a later step in the same turn wrote
 * it again, or an entry that was deleted has since been re-created under the
 * same name. Restoring the backup over any of those silently throws away work
 * — which is the one thing this whole family of cards exists to prevent.
 *
 * So the rule, agreed 2026-09-10, is strict: undo only a file that is still
 * exactly what the write left, and refuse everything else with a sentence that
 * says why — naming the later write when it was one in this turn, and otherwise
 * saying when the file last changed (`fs_stat`). *Who* made that change is not
 * knowable, and the sentence says "可能是你手动改的" rather than guessing.
 *
 * Undo is itself an overwrite, so it keeps the bargain the writes keep: the
 * state it replaces goes into the backups first.
 */

import type { AgentEvent, ChangeRecord, UndoEvent, UndoRefusal } from "./events";
import { backupFileByMove, hashText, snapshotFile } from "./backup";
import { turnWrites, undoneIds, type TurnWrite } from "./planLedger";
import { fileExists, makeDir, readFile, renamePath, writeFile } from "../fs/fileio";
import { dirName, joinPath } from "../paths";
import { modifiedAt } from "../fs/modified";

/** What undoing one write would do, or why it will not. */
export type UndoPlan =
  | { ok: true; op: "restore" | "remove" | "restoreDir" }
  | { ok: false; reason: UndoRefusal; byTool?: string };

/** The file as it stands now. `text` only for a file that exists and was read. */
export interface FileState {
  exists: boolean;
  text?: string;
}

/**
 * Decide, without touching disk, whether a write can be undone.
 *
 * `later` is every write that came after this one in the turn and has not
 * itself been undone. One of them touching the same file is checked first,
 * because it is the refusal that can name its cause.
 */
export function planUndo(target: ChangeRecord, current: FileState, later: readonly TurnWrite[]): UndoPlan {
  const clash = later.find(
    (w) => w.change.path === target.path || (target.dir && w.change.path.startsWith(`${target.path}/`)),
  );
  if (clash) return { ok: false, reason: "changedByLaterWrite", byTool: clash.toolName };

  if (target.action === "delete") {
    if (!target.backupPath) return { ok: false, reason: "noBackup" };
    // Something is back at the old path: restoring would land on top of it.
    if (current.exists) return { ok: false, reason: "recreated" };
    return { ok: true, op: target.dir ? "restoreDir" : "restore" };
  }

  // A create or an update: the file has to be exactly what this write left.
  if (!current.exists) return { ok: false, reason: "changedAfter" };
  const expected = target.afterHash ?? (target.after !== undefined ? hashText(target.after) : undefined);
  // A record from before fingerprints existed, with its text dropped past the
  // cap, cannot prove the file is untouched — and "probably fine" is not a
  // standard for overwriting someone's entry.
  if (expected === undefined) return { ok: false, reason: "cannotVerify" };
  if (hashText(current.text ?? "") !== expected) return { ok: false, reason: "changedAfter" };

  if (target.action === "create") return { ok: true, op: "remove" };
  if (!target.backupPath) return { ok: false, reason: "noBackup" };
  return { ok: true, op: "restore" };
}

/**
 * Undo the given writes of a turn, newest first, and report each attempt.
 *
 * Newest first so that 撤回全部 works on a file written twice: the later write
 * is undone before the earlier one is checked, and by then it no longer counts
 * as "a later write touched this file". Each attempt is judged against the
 * writes still standing at that moment, not against the log as it was.
 */
export async function undoWrites(
  projectPath: string,
  log: readonly AgentEvent[],
  toolCallIds: readonly string[],
  now: () => number = Date.now,
): Promise<UndoEvent[]> {
  const writes = turnWrites(log);
  const undone = undoneIds(log);
  const order = writes.map((w) => w.toolCallId);
  const targets = [...new Set(toolCallIds)]
    .filter((id) => !undone.has(id))
    .map((id) => writes.find((w) => w.toolCallId === id))
    .filter((w): w is TurnWrite => w !== undefined)
    .sort((a, b) => order.indexOf(b.toolCallId) - order.indexOf(a.toolCallId));

  const events: UndoEvent[] = [];
  for (const target of targets) {
    const at = order.indexOf(target.toolCallId);
    const later = writes.slice(at + 1).filter((w) => !undone.has(w.toolCallId));
    const result = await undoOne(projectPath, target.change, later);
    if (result.ok) undone.add(target.toolCallId);
    events.push({
      kind: "undo",
      toolCallId: target.toolCallId,
      outcome: result.ok ? "undone" : "refused",
      ...(result.ok ? {} : { reason: result.reason }),
      ...(!result.ok && result.byTool ? { byTool: result.byTool } : {}),
      ...(!result.ok && result.changedAt !== undefined ? { changedAt: result.changedAt } : {}),
      at: now(),
    });
  }
  return events;
}

async function undoOne(
  projectPath: string,
  change: ChangeRecord,
  later: readonly TurnWrite[],
): Promise<{ ok: true } | { ok: false; reason: UndoRefusal; byTool?: string; changedAt?: number }> {
  const abs = joinPath(projectPath, change.path);
  let current: FileState;
  try {
    const exists = await fileExists(abs);
    const readable = exists && !change.dir && change.action !== "delete";
    current = { exists, ...(readable ? { text: await readFile(abs) } : {}) };
  } catch {
    return { ok: false, reason: "failed" };
  }

  const plan = planUndo(change, current, later);
  if (!plan.ok) {
    // Who changed it cannot be known; when is on the file itself.
    if (plan.reason === "changedAfter" && current.exists) {
      const changedAt = await modifiedAt(abs);
      if (changedAt !== undefined) return { ...plan, changedAt };
    }
    return plan;
  }

  try {
    switch (plan.op) {
      case "restore": {
        const previous = await readFile(change.backupPath!);
        if (current.exists) await snapshotFile(projectPath, abs);
        else await makeDir(dirName(abs));
        await writeFile(abs, previous);
        break;
      }
      case "remove":
        // Moved into the backups rather than unlinked, like every agent removal.
        await backupFileByMove(projectPath, abs);
        break;
      case "restoreDir":
        await makeDir(dirName(abs));
        await renamePath(change.backupPath!, abs);
        break;
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
