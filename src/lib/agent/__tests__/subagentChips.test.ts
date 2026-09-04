import { describe, expect, it, beforeEach, vi } from "vitest";

// agentStore reaches projectStore lazily (a static import back would close the
// store cycle). Pulling the real one into a node test drags appStore in with
// it, which touches `document` at module scope.
vi.mock("../../../stores/projectStore", () => ({
  useProjectStore: { getState: () => ({ projectPath: "/p" }) },
}));
vi.mock("../sessionDb", () => ({
  loadChatSession: vi.fn(async () => "{}"),
  listChatSessions: vi.fn(async () => []),
  upsertChatSession: vi.fn(async () => 1),
  MAX_CHAT_SESSIONS: 5,
}));
vi.mock("../chatSession", () => ({
  deserializeChatSession: () => ({ turns: [], history: [], meta: {}, usage: null }),
  serializeChatSession: () => "{}",
  sessionPreview: () => "",
  maxTurnId: () => 0,
}));

import { activeChat, emptyChat, useAgentStore } from "../../../stores/agentStore";

const disabledNow = () => activeChat(useAgentStore.getState()).disabledSubAgents;

describe("SubAgentChips store state", () => {
  beforeEach(() => {
    useAgentStore.setState({
      chats: { c0: emptyChat("c0") }, chatOrder: ["c0"], activeChatKey: "c0",
      runningChats: [], compactingChats: [], chatQueue: [], chatAborts: {},
    });
  });

  it("toggles subagent in and out of disabledSubAgents array", () => {
    const store = useAgentStore.getState();
    expect(disabledNow()).toEqual([]);

    store.toggleSubAgent("search");
    expect(disabledNow()).toEqual(["search"]);

    store.toggleSubAgent("vision");
    expect(disabledNow()).toEqual(["search", "vision"]);

    store.toggleSubAgent("search");
    expect(disabledNow()).toEqual(["vision"]);

    store.toggleSubAgent("vision");
    expect(disabledNow()).toEqual([]);
  });

  it("resets disabledSubAgents on a new conversation", () => {
    useAgentStore.setState((st) => ({
      chats: { c0: { ...activeChat(st), disabledSubAgents: ["search", "longread"] } },
    }));
    useAgentStore.getState().newChat();
    expect(disabledNow()).toEqual([]);
  });
  it("clears the override when switching to another saved conversation", async () => {
    // The chip says "this conversation". resetChat cleared it, but switching
    // sessions from the history menu did not — so a subagent switched off in
    // conversation A stayed off in conversation B.
    useAgentStore.setState((st) => ({
      chats: { c0: { ...activeChat(st), disabledSubAgents: ["search"], sessionId: 1 } },
    }));

    await useAgentStore.getState().switchChatSession(2);

    expect(activeChat(useAgentStore.getState()).sessionId).toBe(2);
    expect(disabledNow()).toEqual([]);
  });
});
