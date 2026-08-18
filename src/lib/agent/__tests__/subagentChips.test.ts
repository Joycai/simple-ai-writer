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

import { useAgentStore } from "../../../stores/agentStore";

describe("SubAgentChips store state", () => {
  beforeEach(() => {
    useAgentStore.setState({ disabledSubAgents: [] });
  });

  it("toggles subagent in and out of disabledSubAgents array", () => {
    const store = useAgentStore.getState();
    expect(store.disabledSubAgents).toEqual([]);

    store.toggleSubAgent("search");
    expect(useAgentStore.getState().disabledSubAgents).toEqual(["search"]);

    store.toggleSubAgent("vision");
    expect(useAgentStore.getState().disabledSubAgents).toEqual(["search", "vision"]);

    store.toggleSubAgent("search");
    expect(useAgentStore.getState().disabledSubAgents).toEqual(["vision"]);

    store.toggleSubAgent("vision");
    expect(useAgentStore.getState().disabledSubAgents).toEqual([]);
  });

  it("resets disabledSubAgents on resetChat", () => {
    useAgentStore.setState({ disabledSubAgents: ["search", "longread"] });
    useAgentStore.getState().resetChat();
    expect(useAgentStore.getState().disabledSubAgents).toEqual([]);
  });
  it("clears the override when switching to another saved conversation", async () => {
    // The chip says "this conversation". resetChat cleared it, but switching
    // sessions from the history menu did not — so a subagent switched off in
    // conversation A stayed off in conversation B.
    useAgentStore.setState({
      disabledSubAgents: ["search"], chatSessionId: 1, chatRunning: false, turns: [],
    });

    await useAgentStore.getState().switchChatSession(2);

    expect(useAgentStore.getState().chatSessionId).toBe(2);
    expect(useAgentStore.getState().disabledSubAgents).toEqual([]);
  });
});
