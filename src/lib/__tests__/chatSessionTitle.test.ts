/**
 * 会话标题 — the author's own name for a conversation, and the second
 * exemption from the five-session cap (docs/feature/agent/chat-sessions-plan.md §3).
 *
 * The promise, in one sentence: **a name the author typed stays, and stays
 * theirs**. Checked from each side — a save never rewrites it, a rename writes
 * nothing but it, the prune cannot reach a named row, an open row cannot be
 * pruned either, and the label every surface shows falls back in one order.
 *
 * SQL is asserted rather than executed (no SQLite in vitest), same as the pin
 * tests beside this file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  MAX_SESSION_TITLE_CHARS,
  deleteChatSession,
  listChatSessions,
  normalizeSessionTitle,
  sessionLabel,
  setChatSessionTitle,
  upsertChatSession,
} from "../agent/sessionDb";

function stmt(re: RegExp): [string, unknown[]] {
  const call = mockExecute.mock.calls.find((c) => re.test(String(c[0])));
  if (!call) throw new Error(`no statement matching ${re}`);
  return call as unknown as [string, unknown[]];
}
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("chat session titles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 7 });
  });

  it("saves a session without touching its title", async () => {
    await upsertChatSession("/p", 3, "{}", "hello", { title: "ignored on update" });
    const [sql] = stmt(/^\s*UPDATE chat_sessions SET data/);
    // A run finishing must not undo a rename the author made while it ran.
    expect(sql).not.toContain("title");
  });

  it("writes the in-memory title when the row is first created", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0, lastInsertId: 0 }); // UPDATE misses
    await upsertChatSession("/p", 3, "{}", "hello", { title: "  第三章\n改稿  " });
    const [sql, params] = stmt(/^\s*INSERT INTO chat_sessions/);
    expect(flat(sql)).toContain("(preview, title, data, created_at, updated_at)");
    // Normalised on the way in, like every other spelling of a title write.
    expect(params[1]).toBe("第三章 改稿");
  });

  it("never prunes a named session", async () => {
    await upsertChatSession("/p", null, "{}", "hello");
    const [sql] = stmt(/^\s*DELETE FROM chat_sessions/);
    // Both halves again (see the pin test): the outer filter spares the named
    // row, the subquery's filter stops named rows from spending the kept slots.
    expect(flat(sql)).toContain("WHERE pinned = 0 AND title = '' AND id NOT IN");
    expect(flat(sql)).toContain("SELECT id FROM chat_sessions WHERE pinned = 0 AND title = ''");
  });

  it("never prunes a session that is open right now", async () => {
    await upsertChatSession("/p", 3, "{}", "hello", { keep: [11, 12] });
    const [sql, params] = stmt(/^\s*DELETE FROM chat_sessions/);
    expect(flat(sql)).toMatch(/AND id NOT IN \(\?, \?, \?\)$/);
    // The cap, then the open ids (the row just written among them, once).
    expect(params).toEqual([MAX_CHAT_SESSIONS, 11, 12, 3]);
  });

  it("lists named and open sessions past the cap", async () => {
    mockSelect.mockResolvedValueOnce([
      { id: 9, preview: "newest", title: "", pinned: 0, updated_at: 300 },
      { id: 4, preview: "old", title: "时间线", pinned: 0, updated_at: 100 },
    ]);
    const rows = await listChatSessions("/p", [21]);
    const [sql, params] = mockSelect.mock.calls[0] as unknown as [string, unknown[]];
    expect(flat(sql)).toContain("WHERE pinned = 1 OR title <> '' OR id IN");
    expect(flat(sql)).toContain("OR id IN (?) ORDER BY");
    expect(params).toEqual([MAX_CHAT_SESSIONS, 21]);
    expect(rows.map((r) => r.title)).toEqual(["", "时间线"]);
  });

  it("renames by writing the title column and nothing else", async () => {
    await setChatSessionTitle("/p", 4, "  第三章  改稿 ");
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = stmt(/^\s*UPDATE chat_sessions SET title/);
    // Not updated_at: a rename is not "the conversation moved on", and must
    // not reorder the recents. Not pinned: the two axes are independent.
    expect(flat(sql)).toBe("UPDATE chat_sessions SET title = ? WHERE id = ?");
    expect(params).toEqual(["第三章 改稿", 4]);
  });

  it("deletes one row, and only on purpose", async () => {
    await deleteChatSession("/p", 4);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = stmt(/^\s*DELETE FROM chat_sessions WHERE id/);
    expect(flat(sql)).toBe("DELETE FROM chat_sessions WHERE id = ?");
    expect(params).toEqual([4]);
  });

  it("normalises a title: one line, trimmed, clipped, empty stays empty", () => {
    expect(normalizeSessionTitle("  a\n\tb   c ")).toBe("a b c");
    expect(normalizeSessionTitle("   \n ")).toBe("");
    const long = "字".repeat(MAX_SESSION_TITLE_CHARS + 10);
    expect(normalizeSessionTitle(long)).toHaveLength(MAX_SESSION_TITLE_CHARS);
    expect(normalizeSessionTitle("x".repeat(MAX_SESSION_TITLE_CHARS))).toHaveLength(MAX_SESSION_TITLE_CHARS);
  });

  it("labels a session title → preview → untitled, in that order", () => {
    expect(sessionLabel({ title: "时间线", preview: "第一句" }, "（空会话）")).toBe("时间线");
    expect(sessionLabel({ title: "", preview: "第一句" }, "（空会话）")).toBe("第一句");
    expect(sessionLabel({ title: "", preview: "" }, "（空会话）")).toBe("（空会话）");
    expect(sessionLabel(null, "（空会话）")).toBe("（空会话）");
  });
});
