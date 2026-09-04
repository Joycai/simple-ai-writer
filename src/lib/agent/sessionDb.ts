/**
 * Chat-session persistence — the storage half. Rows live in the project DB's
 * `chat_sessions` table (schema in lib/project); the blob format belongs to
 * ./chatSession. Only the newest {@link MAX_CHAT_SESSIONS} **unpinned,
 * untitled** sessions survive a write — the cap is enforced here, on every
 * upsert, so no caller can forget it.
 *
 * Two exemptions from that cap, on two independent axes
 * (docs/feature/agent/chat-sessions-plan.md §3.3):
 *
 * - **Pinning**, modelled on the recents list's pins (lib/recentProjects): a
 *   marker on the row rather than a second list. Pinned-first is a *view*
 *   concern — every read here stays recency-ordered, because the caller that
 *   restores "the session I was last in" on project open reads row 0.
 * - **Naming**: a title the author typed is the strongest "I want to find this
 *   again" there is, and silently pruning a named conversation would be exactly
 *   the unconfirmed, unrecoverable loss {@link setChatSessionPinned} refuses to
 *   be. Naming does not pin and pinning does not name: the two columns are
 *   written by two functions that each touch nothing but their own.
 *
 * A third protection is transient: rows the caller says are *open* right now
 * (`keep`) are never pruned and always listed, whatever their age — a
 * conversation the author has on screen must not lose its row under it.
 *
 * Everything here is best-effort from the caller's point of view: persistence
 * failing must degrade to "chat works, just doesn't survive a restart", never
 * to a broken conversation. Callers wrap these in try/catch accordingly.
 */

import { getDb } from "../project";

/** How many *unpinned, untitled* sessions the history keeps. The author asked for five. */
export const MAX_CHAT_SESSIONS = 5;

/** Longest title stored — the same ruler as `sessionPreview`, so a row is one line either way. */
export const MAX_SESSION_TITLE_CHARS = 60;

export interface ChatSessionRow {
  id: number;
  /** The first question, collapsed and clipped — recomputed on every save. */
  preview: string;
  /** The author's own name, or `""`. Only {@link setChatSessionTitle} writes it. */
  title: string;
  /** Unix seconds. */
  updatedAt: number;
  /** Kept for good: exempt from {@link MAX_CHAT_SESSIONS}, never pruned. */
  pinned: boolean;
}

export interface UpsertChatSessionOptions {
  /**
   * Title to store when the row is *created*. Ignored on an update — the UPDATE
   * never names `title`, so a save landing after a rename cannot undo it. This
   * exists for the session named before its first send (plan §3.2): the name
   * lived in memory until there was a row to hang it on.
   */
  title?: string;
  /** Ids of sessions open right now — never pruned. */
  keep?: readonly number[];
}

/**
 * Insert or update one session and prune to the cap. Returns the row id —
 * callers pass it back on the next save so a session updates in place.
 *
 * The UPDATE deliberately names neither `pinned` nor `title`: a save is about
 * the conversation, and both of those are set on other axes entirely (see
 * {@link setChatSessionPinned}, {@link setChatSessionTitle}).
 */
export async function upsertChatSession(
  projectPath: string,
  id: number | null,
  data: string,
  preview: string,
  opts: UpsertChatSessionOptions = {},
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
      `INSERT INTO chat_sessions (preview, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [preview, normalizeSessionTitle(opts.title ?? ""), data, now, now],
    );
    rowId = res.lastInsertId ?? 0;
  }
  // `pinned = 0 AND title = ''` in both halves: the outer filter alone would
  // still let the *subquery* spend the five kept slots on exempt rows, and the
  // cap would then start eating recent ordinary sessions the moment the author
  // pinned or named anything.
  const keep = keepIds(opts.keep, rowId);
  await db.execute(
    `DELETE FROM chat_sessions WHERE pinned = 0 AND title = '' AND id NOT IN (
       SELECT id FROM chat_sessions WHERE pinned = 0 AND title = ''
       ORDER BY updated_at DESC, id DESC LIMIT ?
     )${keep.clause}`,
    [MAX_CHAT_SESSIONS, ...keep.params],
  );
  return rowId;
}

/**
 * Every pinned or titled session, every open one, plus the newest
 * {@link MAX_CHAT_SESSIONS} ordinary ones — newest first, exemptions and all.
 *
 * The cap is re-applied here rather than trusted from the prune, because
 * unpinning (or clearing a title) does not delete anything (see
 * {@link setChatSessionPinned}): a row that just lost its exemption is over the
 * cap until the next save, and it must stop being offered at the moment it
 * stops being kept, not one save later.
 */
export async function listChatSessions(
  projectPath: string,
  keep: readonly number[] = [],
): Promise<ChatSessionRow[]> {
  const db = await getDb(projectPath);
  const open = keepIds(keep, null);
  const rows = await db.select<{
    id: number; preview: string; title: string; pinned: number; updated_at: number;
  }[]>(
    `SELECT id, preview, title, pinned, updated_at FROM chat_sessions
     WHERE pinned = 1 OR title <> '' OR id IN (
       SELECT id FROM chat_sessions WHERE pinned = 0 AND title = ''
       ORDER BY updated_at DESC, id DESC LIMIT ?
     )${open.orClause}
     ORDER BY updated_at DESC, id DESC`,
    [MAX_CHAT_SESSIONS, ...open.params],
  );
  return rows.map((r) => ({
    id: r.id,
    preview: r.preview,
    title: r.title ?? "",
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
 * Name (or, with `""`, un-name) one session. Writes this one column and
 * nothing else — not `updated_at`, because renaming is not "the conversation
 * moved on" and must not reorder the recents; not `pinned`, because the two
 * axes are independent (a pinned session is renamed the same way).
 *
 * The title is normalised here as well as at the UI, so no spelling of a
 * caller can store a newline or an over-long name.
 */
export async function setChatSessionTitle(
  projectPath: string,
  id: number,
  title: string,
): Promise<void> {
  const db = await getDb(projectPath);
  await db.execute(
    `UPDATE chat_sessions SET title = ? WHERE id = ?`,
    [normalizeSessionTitle(title), id],
  );
}

/**
 * Remove one session for good. The only deliberate deletion in this module —
 * the prune above is the other, automatic one. Callers own the confirmation
 * (plan §3.5); this function assumes it was given.
 */
export async function deleteChatSession(projectPath: string, id: number): Promise<void> {
  const db = await getDb(projectPath);
  await db.execute(`DELETE FROM chat_sessions WHERE id = ?`, [id]);
}

/**
 * What a title looks like once stored: newlines and runs of whitespace folded
 * to one space, trimmed, clipped to {@link MAX_SESSION_TITLE_CHARS}. Empty in
 * means empty out — "no title", never a blank row label.
 */
export function normalizeSessionTitle(raw: string): string {
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > MAX_SESSION_TITLE_CHARS
    ? line.slice(0, MAX_SESSION_TITLE_CHARS).trimEnd()
    : line;
}

/**
 * The one three-step fallback for what a session is *called*: the author's
 * title, else the first question's preview, else the caller's word for an
 * empty conversation. Every surface — list rows, the drawer header, a delete
 * confirmation, a notification — reads through here, so none of them can
 * forget the middle step.
 */
export function sessionLabel(
  row: { title?: string; preview?: string } | null | undefined,
  untitled: string,
): string {
  return row?.title || row?.preview || untitled;
}

/**
 * The two sections the history menu draws, out of one recency-ordered list.
 * Pure, and the only place that decides pinned sessions are shown as a
 * *section* rather than as a badge on a row (设计稿 15's rule for the recents
 * list, which this feature is the second instance of). A title is not a
 * section: named-but-unpinned rows stay under 最近.
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

/**
 * The `keep` list as SQL: an `AND id NOT IN (…)` for the prune, an
 * `OR id IN (…)` for the list, and the placeholders' values. The row just
 * written is always kept — it is open by definition — so the caller need not
 * know its id before the insert that creates it.
 */
function keepIds(
  keep: readonly number[] | undefined,
  justWritten: number | null,
): { clause: string; orClause: string; params: number[] } {
  const ids = Array.from(new Set([
    ...(keep ?? []),
    ...(justWritten !== null ? [justWritten] : []),
  ])).filter((n) => Number.isInteger(n));
  if (ids.length === 0) return { clause: "", orClause: "", params: [] };
  const holes = ids.map(() => "?").join(", ");
  return {
    clause: ` AND id NOT IN (${holes})`,
    orClause: ` OR id IN (${holes})`,
    params: ids,
  };
}
