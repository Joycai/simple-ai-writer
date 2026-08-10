/**
 * Chat-session persistence — the storage half. Rows live in the project DB's
 * `chat_sessions` table (schema in lib/project); the blob format belongs to
 * ./chatSession. Only the newest {@link MAX_CHAT_SESSIONS} survive a write —
 * the cap is enforced here, on every upsert, so no caller can forget it.
 *
 * Everything here is best-effort from the caller's point of view: persistence
 * failing must degrade to "chat works, just doesn't survive a restart", never
 * to a broken conversation. Callers wrap these in try/catch accordingly.
 */

import { getDb } from "../project";

/** How many sessions the history keeps. The author asked for five. */
export const MAX_CHAT_SESSIONS = 5;

export interface ChatSessionRow {
  id: number;
  preview: string;
  /** Unix seconds. */
  updatedAt: number;
}

/**
 * Insert or update one session and prune to the cap. Returns the row id —
 * callers pass it back on the next save so a session updates in place.
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
  await db.execute(
    `DELETE FROM chat_sessions WHERE id NOT IN (
       SELECT id FROM chat_sessions ORDER BY updated_at DESC, id DESC LIMIT ?
     )`,
    [MAX_CHAT_SESSIONS],
  );
  return rowId;
}

/** Newest first. */
export async function listChatSessions(projectPath: string): Promise<ChatSessionRow[]> {
  const db = await getDb(projectPath);
  const rows = await db.select<{ id: number; preview: string; updated_at: number }[]>(
    `SELECT id, preview, updated_at FROM chat_sessions
     ORDER BY updated_at DESC, id DESC LIMIT ?`,
    [MAX_CHAT_SESSIONS],
  );
  return rows.map((r) => ({ id: r.id, preview: r.preview, updatedAt: r.updated_at }));
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
