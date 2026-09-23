/**
 * A chat's scratch area: where pasted pictures live, and how they die
 * (docs/feature/agent/chat-image-paste-plan.md §3.2, §4).
 *
 * A pasted picture is written to disk the moment it arrives, so from then on
 * it is a path like any `@`-attached file — the turn's thumbnails, the saved
 * session, `read_image` and the vision subagent all already know that shape.
 *
 * The directory belongs to the session and dies with it. Of the three ways a
 * session dies only one runs through app code (the author deleting it); the
 * prune in `sessionDb.upsertChatSession` is one SQL statement with no per-row
 * callback, and a tab that never sent anything has no row at all. So instead
 * of a delete hook per death, a reconciliation sweep: whatever directory no
 * session claims is removed, once per project per launch.
 */

import { nanoid } from "nanoid";
import { fileExists, readDir, removeDir, statPath, writeBinaryFile } from "../fs/fileio";
import { sha256Hex } from "../import/cache";
import { isStrictDescendant, joinPath } from "../paths";

/** Under the project root. `.ai-writer/tmp/` is outside backups and sync. */
const CHAT_STASH_DIR = ".ai-writer/tmp/chat";

/**
 * How long an unclaimed directory survives the sweep.
 *
 * `window.lock` warns rather than refuses, so one project can be open in two
 * windows — and the other window's "pasted, not sent yet" session has no row
 * this window can see. A day's grace covers that "just pasted" case; the price
 * is an orphan living one day longer. It is measured from the directory's last
 * write, not the session's last use, so an older session open in another
 * window whose row was pruned here is not covered — an accepted multi-window
 * edge (chat-image-paste-plan §4).
 */
export const STASH_GRACE_MS = 24 * 60 * 60 * 1000;

/** A new session's scratch id. Only ever made on the first paste. */
export function newStashId(): string {
  return nanoid(10);
}

function stashRoot(projectPath: string): string {
  return joinPath(projectPath, CHAT_STASH_DIR);
}

export function chatStashDir(projectPath: string, stashId: string): string {
  return joinPath(stashRoot(projectPath), stashId);
}

/**
 * Where a pasted picture lives: named by content (the first 12 hex digits of
 * its SHA-256), so the same picture pasted twice is the same file and the same
 * `attachedKey` — the chip row dedupes it without a second mechanism. Known
 * before anything is written, so a picture that is already a chip is
 * recognised as one before it is counted against the cap.
 */
export async function pastedImagePath(
  projectPath: string,
  stashId: string,
  bytes: Uint8Array,
  ext: string,
): Promise<string> {
  const hash = (await sha256Hex(bytes)).slice(0, 12);
  return joinPath(chatStashDir(projectPath, stashId), `${hash}.${ext}`);
}

/** Write a pasted picture at {@link pastedImagePath}'s answer, unless it is already there. */
export async function writePastedImage(path: string, bytes: Uint8Array): Promise<void> {
  if (!(await fileExists(path))) await writeBinaryFile(path, bytes);
}

/**
 * Which scratch directories to remove: those no live session claims whose
 * last change is older than {@link STASH_GRACE_MS}. A directory whose time
 * the filesystem did not report is kept — not knowing its age is not
 * knowing it is an orphan.
 */
export function stashSweepPlan(
  dirs: readonly { id: string; mtimeMs: number | null }[],
  live: ReadonlySet<string>,
  now: number,
): string[] {
  return dirs
    .filter((d) => !live.has(d.id) && d.mtimeMs !== null && now - d.mtimeMs > STASH_GRACE_MS)
    .map((d) => d.id);
}

/**
 * Remove one directory, refusing anything that isn't strictly inside the
 * scratch root. The id comes from a saved session and a database column,
 * both hand-editable; a delete should not trust either.
 */
async function removeStashDir(projectPath: string, stashId: string): Promise<void> {
  const dir = chatStashDir(projectPath, stashId);
  if (!stashId || !isStrictDescendant(stashRoot(projectPath), dir)) return;
  await removeDir(dir);
}

/**
 * The author deleted the session: its pictures go now, without the grace
 * period — the author asked for exactly that. (With the project open in two
 * windows, the other one may still show the session; plan §4 accepts it.)
 * Best-effort: a failure leaves the directory to the next sweep.
 */
export async function removeChatStash(projectPath: string, stashId: string | null | undefined): Promise<void> {
  if (!stashId) return;
  try {
    if (await fileExists(chatStashDir(projectPath, stashId))) await removeStashDir(projectPath, stashId);
  } catch {
    // The sweep gets it.
  }
}

/**
 * Tabs with a paste in flight — its files are being read and written, and its
 * chips not yet on the composer. The store must not hand such a tab to another
 * conversation meanwhile (agentStore's `newChat` / `switchChatSession`): the
 * chips would land in a conversation that does not claim their directory.
 */
const pasting = new Map<string, number>();

export function markPasting(chatKey: string, on: boolean): void {
  const n = (pasting.get(chatKey) ?? 0) + (on ? 1 : -1);
  if (n > 0) pasting.set(chatKey, n);
  else pasting.delete(chatKey);
}

export function isPasting(chatKey: string): boolean {
  return pasting.has(chatKey);
}

/** Projects swept this launch. Module state on purpose: one sweep per launch is the contract. */
const swept = new Set<string>();

/**
 * Reconcile the scratch area against the sessions that exist.
 *
 * Runs once per project per launch, when the project's session list is read
 * (that is when the live ids are in hand). Not after each prune: a pruned
 * session is reconciled on the next open, which is not worth a `readDir` on
 * every save. Swallows every error — a failed sweep is a few stray pictures
 * in tmp, never a session that won't open.
 */
export async function sweepChatStash(
  projectPath: string,
  live: ReadonlySet<string>,
  now = Date.now(),
): Promise<void> {
  if (swept.has(projectPath)) return;
  swept.add(projectPath);
  try {
    const root = stashRoot(projectPath);
    if (!(await fileExists(root))) return;
    const dirs: { id: string; mtimeMs: number | null }[] = [];
    for (const entry of await readDir(root)) {
      if (!entry.isDirectory) continue;
      const stat = await statPath(entry.path).catch(() => null);
      dirs.push({ id: entry.name, mtimeMs: stat?.modifiedMs ?? null });
    }
    for (const id of stashSweepPlan(dirs, live, now)) {
      try {
        await removeStashDir(projectPath, id);
      } catch {
        // Next launch's sweep gets it.
      }
    }
  } catch {
    // See above: never fatal.
  }
}

/** Test seam: forget which projects were swept. */
export function resetChatStashSweepForTests(): void {
  swept.clear();
}
