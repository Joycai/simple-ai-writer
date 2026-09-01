/**
 * Chat-session persistence — the storage half. Rows live in the project DB's
 * `chat_sessions` table (schema in lib/project); the blob format belongs to
 * ./chatSession. Only the newest {@link MAX_CHAT_SESSIONS} **unpinned**
 * sessions survive a write — the cap is enforced here, on every upsert, so no
 * caller can forget it.
 *
 * Pinning is the author's exemption from that cap, modelled on the recents
 * list's pins (lib/recentProjects): a marker on the row rather than a second
 * list, the cap counts unpinned rows only, and the pinned-first arrangement is
 * a *view* concern — every read here stays recency-ordered, because the caller
 * that restores "the session I was last in" on project open reads row 0.
 *
 * Everything here is best-effort from the caller's point of view: persistence
 * failing must degrade to "chat works, just doesn't survive a restart", never
 * to a broken conversation. Callers wrap these in try/catch accordingly.
 */

import { getDb } from "../project";

/** How many *unpinned* sessions the history keeps. The author asked for five. */
export const MAX_CHAT_SESSIONS = 5;

export interface ChatSessionRow {
  id: number;
  preview: string;
  /** Unix seconds. */
  updatedAt: number;
  /** Kept for good: exempt from {@link MAX_CHAT_SESSIONS}, never pruned. */
  pinned: boolean;
}

/**
 * Insert or update one session and prune to the cap. Returns the row id —
 * callers pass it back on the next save so a session updates in place.
 *
 * The UPDATE deliberately does not name `pinned`: a save is about the
 * conversation, and the pin is set on another axis entirely (see
 * {@link setChatSessionPinned}).
 */
export async function upsertChatSession(
  projectPath: string,
  id: number | null,
  data: string,
  preview: string,
): Promise<number> {
  const db = await getDb(projectPath);
  const now = Math.floor(Date.now() / 1000);
  let rowId = id;
  if (rowId !== null) {
    const res = await db.execute(
      `UPDATE chat_sessions SET data = ?, preview = ?, updated_at = ? WHERE id = ?`,
      [data, preview, now, rowId],
    );
    // The row can be gone — pruned by another save, or the DB was reset.
    if (res.rowsAffected === 0) rowId = null;
  }
  if (rowId === null) {
    const res = await db.execute(
      `INSERT INTO chat_sessions (preview, data, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [preview, data, now, now],
    );
    rowId = res.lastInsertId ?? 0;
  }
  // `pinned = 0` in both halves: the filter alone would still let the *subquery*
  // spend the five kept slots on pinned rows, and the cap would then start
  // eating recent unpinned sessions the moment the author pinned anything.
  await db.execute(
    `DELETE FROM chat_sessions WHERE pinned = 0 AND id NOT IN (
       SELECT id FROM chat_sessions WHERE pinned = 0
       ORDER BY updated_at DESC, id DESC LIMIT ?
     )`,
    [MAX_CHAT_SESSIONS],
  );
  return rowId;
}

/**
 * Every pinned session plus the newest {@link MAX_CHAT_SESSIONS} unpinned
 * ones, newest first — pins and all.
 *
 * The cap is re-applied here rather than trusted from the prune, because
 * unpinning does not delete anything (see {@link setChatSessionPinned}): a row
 * that just lost its pin is over the cap until the next save, and it must stop
 * being offered at the moment it stops being kept, not one save later.
 */
export async function listChatSessions(projectPath: string): Promise<ChatSessionRow[]> {
  const db = await getDb(projectPath);
  const rows = await db.select<{ id: number; preview: string; pinned: number; updated_at: number }[]>(
    `SELECT id, preview, pinned, updated_at FROM chat_sessions
     WHERE pinned = 1 OR id IN (
       SELECT id FROM chat_sessions WHERE pinned = 0
       ORDER BY updated_at DESC, id DESC LIMIT ?
     )
     ORDER BY updated_at DESC, id DESC`,
    [MAX_CHAT_SESSIONS],
  );
  return rows.map((r) => ({
    id: r.id,
    preview: r.preview,
    updatedAt: r.updated_at,
    pinned: !!r.pinned,
  }));
}

/**
 * Pin or unpin one session.
 *
 * Unpinning writes the flag and stops — it does **not** prune, even when the
 * row is already past the cap. Deleting a conversation as the direct result of
 * clicking a toggle would be an unconfirmed, unrecoverable loss; letting the
 * ordinary prune take it on the next save is the same contract every unpinned
 * session already lives under. What the author sees immediately is the row
 * leaving the 已固定 section, which is what they asked for.
 */
export async function setChatSessionPinned(
  projectPath: string,
  id: number,
  pinned: boolean,
): Promise<void> {
  const db = await getDb(projectPath);
  await db.execute(`UPDATE chat_sessions SET pinned = ? WHERE id = ?`, [pinned ? 1 : 0, id]);
}

/**
 * The two sections the history menu draws, out of one recency-ordered list.
 * Pure, and the only place that decides pinned sessions are shown as a
 * *section* rather than as a badge on a row (设计稿 15's rule for the recents
 * list, which this feature is the second instance of).
 */
export function splitChatSessions(
  rows: readonly ChatSessionRow[],
): { pinned: ChatSessionRow[]; recent: ChatSessionRow[] } {
  return {
    pinned: rows.filter((r) => r.pinned),
    recent: rows.filter((r) => !r.pinned),
  };
}

export async function loadChatSession(
  projectPath: string,
  id: number,
): Promise<string | null> {
  const db = await getDb(projectPath);
  const rows = await db.select<{ data: string }[]>(
    `SELECT data FROM chat_sessions WHERE id = ?`,
    [id],
  );
  return rows[0]?.data ?? null;
}
