/**
 * 固定会话 — the author's exemption from the five-session cap.
 *
 * The whole promise of the pin is one sentence: **a pinned session is still
 * there later**. Everything below is that sentence checked from a different
 * side — the prune can't reach a pinned row, the pins can't spend the recent
 * list's slots, a save doesn't quietly release a pin, and the menu shows pins
 * as their own section without reordering what "newest" means.
 *
 * The SQL is asserted rather than executed (no SQLite in vitest — same
 * approach as persistUsage.test.ts), so each check names the clause it needs
 * and why, not the statement's exact spelling.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Both declare their parameters so the assertions below can read them back.
const mockExecute = vi.fn(async (_sql: string, _params?: unknown[]) => ({
  rowsAffected: 1,
  lastInsertId: 7,
}));
const mockSelect = vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]);
vi.mock("../project", () => ({
  getDb: vi.fn(async () => ({ execute: mockExecute, select: mockSelect })),
}));

import {
  MAX_CHAT_SESSIONS,
  listChatSessions,
  setChatSessionPinned,
  splitChatSessions,
  upsertChatSession,
  type ChatSessionRow,
} from "../agent/sessionDb";

/** The statement (sql, params) whose text matches — there is only ever one. */
function stmt(re: RegExp): [string, unknown[]] {
  const call = mockExecute.mock.calls.find((c) => re.test(String(c[0])));
  if (!call) throw new Error(`no statement matching ${re}`);
  return call as unknown as [string, unknown[]];
}

/** Collapse the whitespace so a clause can be matched as one phrase. */
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("chat session pinning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 7 });
  });

  it("never prunes a pinned session", async () => {
    await upsertChatSession("/p", 3, "{}", "hello");
    const [sql, params] = stmt(/^\s*DELETE FROM chat_sessions/);
    // Two independent guards, and the pin needs both: the outer filter is what
    // spares a pinned row from deletion, and the subquery's own filter is what
    // stops pins from spending the kept slots (pin five conversations with the
    // subquery unfiltered and every unpinned session dies on the next save).
    expect(flat(sql)).toContain("DELETE FROM chat_sessions WHERE pinned = 0");
    expect(flat(sql)).toContain("SELECT id FROM chat_sessions WHERE pinned = 0");
    expect(params).toEqual([MAX_CHAT_SESSIONS]);
  });

  it("does not touch the pin when saving a session", async () => {
    await upsertChatSession("/p", 3, "{}", "hello");
    const [sql] = stmt(/^\s*UPDATE chat_sessions SET data/);
    expect(sql).not.toContain("pinned");
  });

  it("lists every pinned session plus the newest capped few", async () => {
    mockSelect.mockResolvedValueOnce([
      { id: 9, preview: "newest", pinned: 0, updated_at: 300 },
      { id: 4, preview: "kept for good", pinned: 1, updated_at: 100 },
    ]);
    const rows = await listChatSessions("/p");
    const [sql, params] = mockSelect.mock.calls[0] as unknown as [string, unknown[]];
    expect(flat(sql)).toContain("WHERE pinned = 1 OR id IN");
    // The cap is re-applied on read, because unpinning does not delete.
    expect(params).toEqual([MAX_CHAT_SESSIONS]);
    // Recency order, pins and all: resetChatForProject restores row 0 as
    // "where I left off", and a pinned-first list would reopen an old
    // conversation on every project open.
    expect(rows.map((r) => r.id)).toEqual([9, 4]);
    expect(rows.map((r) => r.pinned)).toEqual([false, true]);
  });

  it("writes the flag and nothing else when unpinning", async () => {
    await setChatSessionPinned("/p", 4, false);
    // One statement: no prune rides along. Releasing a pin must not be able to
    // delete the conversation on the spot — the ordinary cap takes it at the
    // next save, which is the contract every unpinned session already has.
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = stmt(/^\s*UPDATE chat_sessions SET pinned/);
    expect(flat(sql)).toBe("UPDATE chat_sessions SET pinned = ? WHERE id = ?");
    expect(params).toEqual([0, 4]);
  });

  it("splits the menu into pinned and recent, preserving each one's order", () => {
    const row = (id: number, pinned: boolean, updatedAt: number): ChatSessionRow =>
      ({ id, preview: `s${id}`, updatedAt, pinned });
    const { pinned, recent } = splitChatSessions([
      row(9, false, 300), row(8, true, 250), row(4, true, 100), row(2, false, 50),
    ]);
    expect(pinned.map((r) => r.id)).toEqual([8, 4]);
    expect(recent.map((r) => r.id)).toEqual([9, 2]);
  });
});
