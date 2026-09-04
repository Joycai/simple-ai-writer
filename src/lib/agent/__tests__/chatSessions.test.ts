/**
 * 多个活会话 — the chat assistant's open conversations as tabs
 * (docs/feature/agent/chat-sessions-plan.md §4, §5 for the invariants).
 *
 * Nothing here runs a model: the tests set `runningChats` / `chatAborts` /
 * `chatQueue` by hand and exercise the bookkeeping around them — which tab is
 * on screen versus which is generating, what stop reaches, what close refuses,
 * where a card lands, what a save carries. The run itself is covered by the
 * runtime's own tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../stores/projectStore", () => ({
  useProjectStore: { getState: () => ({ projectPath: "/p", activeFilePath: null }) },
}));
const db = vi.hoisted(() => ({
  upsert: vi.fn(async () => 41),
  list: vi.fn(async () => [] as unknown[]),
  setTitle: vi.fn(async () => {}),
  del: vi.fn(async () => {}),
  load: vi.fn(async () => "{}"),
}));
vi.mock("../sessionDb", () => ({
  loadChatSession: db.load,
  listChatSessions: db.list,
  upsertChatSession: db.upsert,
  setChatSessionTitle: db.setTitle,
  deleteChatSession: db.del,
  normalizeSessionTitle: (t: string) => t.replace(/\s+/g, " ").trim(),
  MAX_CHAT_SESSIONS: 5,
}));
vi.mock("../chatSession", () => ({
  deserializeChatSession: () => ({
    turns: [{ id: "t9", role: "user", text: "old", log: [], at: 0 }],
    history: [{ role: "system", content: "s" }], meta: { stateMode: false }, usage: null, taskId: null,
  }),
  serializeChatSession: () => "{}",
  sessionPreview: () => "first line",
  maxTurnId: () => 0,
}));
vi.mock("../../notify", () => ({ notify: vi.fn() }));

import {
  activeChat, chatSurface, emptyChat, isChatBusy, useAgentStore, type LiveChat,
} from "../../../stores/agentStore";
import { chatAutoApproveKey } from "../autoApprove";
import type { Proposal } from "../registry";

const state = () => useAgentStore.getState();
const chat = (key: string) => state().chats[key];
const turn = (id: string, role: "user" | "assistant" = "user") =>
  ({ id, role, text: role === "user" ? "q" : "", log: [], at: 0 });
const withTurns = (key: string, n = 1): LiveChat =>
  ({ ...emptyChat(key), turns: Array.from({ length: n }, (_, i) => turn(`${key}-t${i}`)) });

function seed(chats: LiveChat[], active = chats[0].key) {
  useAgentStore.setState({
    chats: Object.fromEntries(chats.map((c) => [c.key, c])),
    chatOrder: chats.map((c) => c.key),
    activeChatKey: active,
    runningChats: [], compactingChats: [], chatQueue: [], chatAborts: {},
    pending: [], pendingPlans: [], pendingRoundLimits: [], pendingTruncations: [], pendingQuestions: [],
    autoApprove: null, chatSessions: [],
  });
}

const edit = (id: string): Proposal =>
  ({ kind: "edit", id, path: "/p/a.md", find: "a", replace: "b", occurrences: 1, target: "first" } as unknown as Proposal);

beforeEach(() => {
  vi.clearAllMocks();
  seed([emptyChat("c0")]);
});

describe("tabs: which conversation is on screen", () => {
  it("newChat reuses the idle empty tab, reset to defaults, rather than adding a blank one", () => {
    seed([{ ...emptyChat("c0"), disabledSubAgents: ["search"], planMode: true }]);
    const key = state().newChat();
    expect(key).toBe("c0");
    expect(state().chatOrder).toEqual(["c0"]);
    expect(chat("c0").disabledSubAgents).toEqual([]);
    expect(chat("c0").planMode).toBe(false);
  });

  it("newChat adds a tab when the open ones all have turns, and makes it active", () => {
    seed([withTurns("c0")]);
    const key = state().newChat();
    expect(key).not.toBe("c0");
    expect(state().chatOrder).toEqual(["c0", key]);
    expect(state().activeChatKey).toBe(key);
    expect(activeChat(state()).turns).toEqual([]);
  });

  it("activateChat brings a tab on screen and marks it read; the run behind it is untouched", () => {
    seed([withTurns("c0"), { ...withTurns("c1"), unread: true }]);
    useAgentStore.setState({ runningChats: ["c1"], chatAborts: { c1: new AbortController() } });
    state().activateChat("c1");
    expect(state().activeChatKey).toBe("c1");
    expect(chat("c1").unread).toBe(false);
    expect(state().runningChats).toEqual(["c1"]);
  });

  it("switching to a saved conversation opens it beside a non-empty active tab", async () => {
    seed([withTurns("c0")]);
    await state().switchChatSession(7);
    expect(state().chatOrder).toHaveLength(2);
    expect(activeChat(state()).sessionId).toBe(7);
    // The conversation the author was in stays open, untouched.
    expect(chat("c0").turns).toHaveLength(1);
  });

  it("switching to a conversation that is already open focuses its tab instead of loading twice", async () => {
    seed([withTurns("c0"), { ...withTurns("c1"), sessionId: 7 }]);
    await state().switchChatSession(7);
    expect(state().activeChatKey).toBe("c1");
    expect(state().chatOrder).toEqual(["c0", "c1"]);
    expect(db.load).not.toHaveBeenCalled();
  });
});

describe("running: which conversations are generating", () => {
  it("stopChat stops one conversation and leaves the others running", () => {
    const a = new AbortController();
    const b = new AbortController();
    seed([withTurns("c0"), withTurns("c1")]);
    useAgentStore.setState({ runningChats: ["c0", "c1"], chatAborts: { c0: a, c1: b } });
    state().stopChat("c0");
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(state().runningChats).toEqual(["c1"]);
    expect(state().chatAborts).toEqual({ c1: b });
  });

  it("stopChat drops the conversation's queued sends and their placeholder answers", () => {
    seed([
      { ...emptyChat("c0"), turns: [turn("u1"), turn("a1", "assistant")] },
      withTurns("c1"),
    ]);
    // Three others hold the slots, so the queued job could not have started.
    useAgentStore.setState({
      runningChats: ["x", "y", "z"],
      chatQueue: [
        { key: "c0", assistantTurnId: "a1" } as never,
        { key: "c1", assistantTurnId: "zz" } as never,
      ],
    });
    state().stopChat("c0");
    expect(state().chatQueue.map((j) => j.key)).toEqual(["c1"]);
    // The author's words stay as the record of the ask; the empty answer goes.
    expect(chat("c0").turns.map((t) => t.id)).toEqual(["u1"]);
  });

  it("names a conversation busy while generating, folding or queued", () => {
    seed([withTurns("c0"), withTurns("c1"), withTurns("c2"), withTurns("c3")]);
    useAgentStore.setState({
      runningChats: ["c0"], compactingChats: ["c1"], chatQueue: [{ key: "c2" } as never],
    });
    expect(isChatBusy(state(), "c0")).toBe(true);
    expect(isChatBusy(state(), "c1")).toBe(true);
    expect(isChatBusy(state(), "c2")).toBe(true);
    expect(isChatBusy(state(), "c3")).toBe(false);
  });
});

describe("closing", () => {
  it("refuses to close a busy conversation — stop it first", async () => {
    seed([withTurns("c0"), withTurns("c1")]);
    useAgentStore.setState({ runningChats: ["c1"], chatAborts: { c1: new AbortController() } });
    expect(await state().closeChat("c1")).toBe(false);
    expect(state().chatOrder).toEqual(["c0", "c1"]);
  });

  it("closes an idle tab, activates the neighbour on the left, and ends its grant", async () => {
    seed([withTurns("c0"), withTurns("c1"), withTurns("c2")], "c1");
    useAgentStore.setState({
      autoApprove: { key: chatAutoApproveKey("c1"), proposals: true, plans: false, appendPaths: [], illustrateLeft: 0 },
    });
    expect(await state().closeChat("c1")).toBe(true);
    expect(state().chatOrder).toEqual(["c0", "c2"]);
    expect(state().activeChatKey).toBe("c0");
    expect(state().autoApprove).toBeNull();
  });

  it("never leaves zero tabs: closing the last one opens an empty conversation", async () => {
    seed([withTurns("c0")]);
    await state().closeChat("c0");
    expect(state().chatOrder).toHaveLength(1);
    expect(activeChat(state()).turns).toEqual([]);
  });
});

describe("cards belong to the conversation that raised them", () => {
  it("a card for a background conversation marks its tab, not the active one", () => {
    seed([withTurns("c0"), withTurns("c1")]);
    const run = new AbortController();
    void state().requestApproval(edit("e1"), run, { surface: chatSurface("c1") });
    expect(state().pending[0].surface).toBe("chat:c1");
    expect(chat("c1").unread).toBe(true);
    expect(chat("c0").unread).toBe(false);
  });

  it("a card for the conversation on screen does not mark it", () => {
    seed([withTurns("c0")]);
    void state().requestRoundExtension(3, 5, {}, false, chatSurface("c0"));
    expect(chat("c0").unread).toBe(false);
  });

  it("a grant pressed in one conversation never covers another", async () => {
    seed([withTurns("c0"), withTurns("c1")]);
    state().enableAutoApprove(chatAutoApproveKey("c0"), "proposals");
    const run = new AbortController();
    void state().requestApproval(edit("e1"), run, {
      surface: chatSurface("c1"), autoApproveKey: chatAutoApproveKey("c1"),
    });
    // Queued, not auto-applied: c1 has no grant of its own.
    expect(state().pending.map((p) => p.proposal.id)).toEqual(["e1"]);
  });
});

describe("saving", () => {
  it("carries the in-memory title and every open row id into the save", async () => {
    seed([
      { ...withTurns("c0"), history: [{ role: "system", content: "s" }], meta: {} as never, title: "第三章", sessionId: null },
      { ...withTurns("c1"), sessionId: 12 },
      { ...withTurns("c2"), sessionId: 13 },
    ]);
    await state().persistChat("c0");
    expect(db.upsert).toHaveBeenCalledWith("/p", null, "{}", "first line", { title: "第三章", keep: [12, 13] });
    // The new row's id is adopted, so the next save updates in place.
    expect(chat("c0").sessionId).toBe(41);
    expect(db.list).toHaveBeenCalledWith("/p", [41, 12, 13]);
  });

  it("renames in memory at once, and on disk only once there is a row", async () => {
    seed([withTurns("c0")]);
    await state().renameChat("  时间线\n梳理 ");
    expect(chat("c0").title).toBe("时间线 梳理");
    expect(db.setTitle).not.toHaveBeenCalled();

    useAgentStore.setState((st) => ({ chats: { c0: { ...st.chats.c0, sessionId: 5 } } }));
    await state().renameChat("时间线");
    expect(db.setTitle).toHaveBeenCalledWith("/p", 5, "时间线");
  });

  it("renaming works while the conversation is generating", async () => {
    seed([{ ...withTurns("c0"), sessionId: 5 }]);
    useAgentStore.setState({ runningChats: ["c0"], chatAborts: { c0: new AbortController() } });
    await state().renameChat("改稿");
    expect(chat("c0").title).toBe("改稿");
    expect(db.setTitle).toHaveBeenCalledWith("/p", 5, "改稿");
  });

  it("deleting refuses a busy open conversation, and otherwise drops its row and its tab", async () => {
    seed([withTurns("c0"), { ...withTurns("c1"), sessionId: 8 }]);
    useAgentStore.setState({ runningChats: ["c1"], chatAborts: { c1: new AbortController() } });
    expect(await state().deleteChatSession(8)).toBe(false);
    expect(db.del).not.toHaveBeenCalled();

    state().stopChat("c1");
    expect(await state().deleteChatSession(8)).toBe(true);
    expect(db.del).toHaveBeenCalledWith("/p", 8);
    expect(state().chatOrder).toEqual(["c0"]);
  });
});

describe("project switch", () => {
  it("stops every run, empties the queue and leaves one tab", async () => {
    const a = new AbortController();
    const b = new AbortController();
    seed([withTurns("c0"), withTurns("c1")]);
    useAgentStore.setState({
      runningChats: ["c0", "c1"], chatAborts: { c0: a, c1: b },
      chatQueue: [{ key: "c0", assistantTurnId: "x" } as never],
    });
    await state().resetChatForProject(null);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(state().runningChats).toEqual([]);
    expect(state().chatQueue).toEqual([]);
    expect(state().chatOrder).toHaveLength(1);
    expect(activeChat(state()).turns).toEqual([]);
  });
});
