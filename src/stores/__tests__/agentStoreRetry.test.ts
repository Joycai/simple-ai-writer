import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyChat, useAgentStore } from "../agentStore";

const original = useAgentStore.getState();
afterEach(() => useAgentStore.setState(original, true));

function seed() {
  const chat = {
    ...emptyChat("failed"), error: "504",
    history: [{ role: "user" as const, content: "original request" }],
    turns: [{ id: "a1", role: "assistant" as const, text: "partial output", at: 1,
      log: [{ kind: "run-error" as const, message: "504", at: 2 }] }],
  };
  const send = vi.fn(async () => {});
  useAgentStore.setState({
    chats: { failed: chat, other: emptyChat("other") }, activeChatKey: "other",
    runningChats: [], compactingChats: [], chatQueue: [], sendChatTo: send,
  });
  return { chat, send };
}

describe("retry failed chat", () => {
  it("continues the targeted conversation without erasing progress or sending twice", async () => {
    const { chat, send } = seed();
    await Promise.all([
      useAgentStore.getState().retryChat("failed"),
      useAgentStore.getState().retryChat("failed"),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([
      "failed", expect.any(String), undefined, [], { displayText: expect.any(String) },
    ]);
    expect(useAgentStore.getState().chats.failed.history).toBe(chat.history);
    expect(useAgentStore.getState().chats.failed.turns).toBe(chat.turns);
    expect(useAgentStore.getState().activeChatKey).toBe("other");
  });

  it("does not retry unrelated errors or busy conversations", async () => {
    const { chat, send } = seed();
    useAgentStore.setState({ runningChats: ["failed"] });
    await useAgentStore.getState().retryChat("failed");
    useAgentStore.setState({ runningChats: [], chats: { failed: { ...chat, error: "compaction failed" } } });
    await useAgentStore.getState().retryChat("failed");
    useAgentStore.setState({ chats: { failed: { ...chat, history: null } } });
    await useAgentStore.getState().retryChat("failed");
    expect(send).not.toHaveBeenCalled();
  });
});
