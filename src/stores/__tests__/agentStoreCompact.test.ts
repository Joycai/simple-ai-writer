import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionMeta, noteTurnStart } from "../../lib/agent/compact";
import type { StreamMessage } from "../../lib/ai/types";
import { emptyChat, useAgentStore } from "../agentStore";
import { summarizeForCompaction } from "../../lib/agent/compactRun";
import { loadApiKey } from "../../lib/keyStore";
import { updateSkillState } from "../../lib/agent/skillStateRun";

vi.mock("../appStore", () => ({ useAppStore: { getState: () => ({ contextUtilization: 0.8 }) } }));
vi.mock("../../lib/keyStore", () => ({ loadApiKey: vi.fn(async () => "test") }));
vi.mock("../../lib/agent/stateFlag", () => ({ isSkillStateEnabled: () => true, newChatStateMemory: () => false }));
vi.mock("../../lib/agent/skillStateRun", () => ({ updateSkillState: vi.fn(async () => null), requestStateUpdate: vi.fn() }));
vi.mock("../../lib/ai/conn", async (original) => ({
  ...await original<typeof import("../../lib/ai/conn")>(),
  resolveConn: () => ({ ok: true, model: {}, provider: { id: "provider" } }),
  plannedLimits: () => ({ contextSize: 64000 }), connOptions: () => ({}),
}));
vi.mock("../../lib/agent/toolCost", async (original) => ({
  ...await original<typeof import("../../lib/agent/toolCost")>(),
  messageCeilingFor: () => 50000, plannedToolTokens: () => 1000,
}));
vi.mock("../../lib/agent/compactRun", async (original) => ({
  ...await original<typeof import("../../lib/agent/compactRun")>(),
  summarizeForCompaction: vi.fn(async () => "Summary"),
}));

const original = useAgentStore.getState();
function seed(turns = 4) {
  const meta = createSessionMeta();
  const seed: StreamMessage = { role: "user", content: "seed context" };
  meta.seedContext = seed;
  const history: StreamMessage[] = [{ role: "system", content: "system" }, seed];
  for (let i = 0; i < turns; i++) {
    const user: StreamMessage = { role: "user", content: `Question ${i}` };
    noteTurnStart(meta, user);
    history.push(user, { role: "assistant", content: "answer ".repeat(1000) });
  }
  const chat = { ...emptyChat("a"), history, meta };
  const persist = vi.fn(async () => {});
  useAgentStore.setState({ chats: { a: chat, b: emptyChat("b") }, activeChatKey: "a",
    chatOrder: ["a", "b"], runningChats: [], compactingChats: [], chatQueue: [], persistChat: persist });
  return { chat, persist };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(summarizeForCompaction).mockResolvedValue("Summary"); vi.mocked(loadApiKey).mockResolvedValue("test"); });
afterEach(() => useAgentStore.setState(original, true));

describe("manual context compaction", () => {
  it("reserves synchronously, refuses duplicate clicks and commits only to its owner", async () => {
    const { chat, persist } = seed();
    const summary = deferred<string>();
    vi.mocked(summarizeForCompaction).mockReturnValue(summary.promise);
    const first = useAgentStore.getState().compactChatNow("a");
    expect(useAgentStore.getState().compactingChats).toEqual(["a"]);
    expect(await useAgentStore.getState().compactChatNow("a")).toEqual({ status: "skipped", reason: "busy" });
    await vi.waitFor(() => expect(summarizeForCompaction).toHaveBeenCalledTimes(1));
    useAgentStore.setState({ activeChatKey: "b" });
    summary.resolve("Kept facts");
    const result = await first;
    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.toTokens).toBeLessThan(result.fromTokens);
    const state = useAgentStore.getState();
    expect(state.chats.a.contextVersion).toBe(1);
    expect(state.chats.a.meta?.summaryText).toBe("Kept facts");
    expect(state.chats.a.compactFeedback?.result).toEqual(result);
    expect(state.chats.b.history).toBeNull();
    expect(state.activeChatKey).toBe("b");
    expect(state.compactingChats).toEqual([]);
    expect(persist).toHaveBeenCalledWith("a");
    expect(chat.meta.summaryText).not.toBe("Kept facts");
    // References shared by history and meta survive the single snapshot clone.
    expect(state.chats.a.history).toContain(state.chats.a.meta?.turnStarts[0]);
  });

  it("reports failure without replacing live history and supports a successful retry", async () => {
    const { chat } = seed();
    vi.mocked(summarizeForCompaction).mockRejectedValueOnce(new Error("gateway failure"));
    const failed = await useAgentStore.getState().compactChatNow("a");
    expect(failed.status).toBe("failed");
    expect(useAgentStore.getState().chats.a.history).toBe(chat.history);
    expect(useAgentStore.getState().chats.a.meta).toBe(chat.meta);
    expect(useAgentStore.getState().chats.a.compactFeedback?.result).toEqual(failed);
    expect((await useAgentStore.getState().compactChatNow("a")).status).toBe("success");
  });

  it("cancels during key loading without calling a model", async () => {
    const { chat } = seed();
    const key = deferred<string>();
    vi.mocked(loadApiKey).mockReturnValue(key.promise);
    const task = useAgentStore.getState().compactChatNow("a");
    await vi.waitFor(() => expect(loadApiKey).toHaveBeenCalled());
    useAgentStore.getState().stopChat("a");
    key.resolve("key");
    expect(await task).toEqual({ status: "cancelled" });
    expect(summarizeForCompaction).not.toHaveBeenCalled();
    expect(useAgentStore.getState().chats.a.history).toBe(chat.history);
    expect(useAgentStore.getState().chats.a.compactFeedback?.result?.status).toBe("cancelled");
  });

  it("discards a late model response after reset, including mutations to meta", async () => {
    const { chat, persist } = seed();
    const summary = deferred<string>();
    vi.mocked(summarizeForCompaction).mockReturnValue(summary.promise);
    const task = useAgentStore.getState().compactChatNow("a");
    await vi.waitFor(() => expect(summarizeForCompaction).toHaveBeenCalled());
    await useAgentStore.getState().resetChatForProject(null);
    const newChats = useAgentStore.getState().chats;
    summary.resolve("late result");
    expect(await task).toEqual({ status: "cancelled" });
    expect(useAgentStore.getState().chats).toBe(newChats);
    expect(chat.meta.summaryText).not.toBe("late result");
    expect(persist).not.toHaveBeenCalled();
  });

  it("distinguishes missing/no fold from successful compaction", async () => {
    seed(1);
    expect(await useAgentStore.getState().compactChatNow("missing")).toEqual({ status: "skipped", reason: "missing" });
    expect(await useAgentStore.getState().compactChatNow("a")).toEqual({ status: "skipped", reason: "nothing" });
    expect(summarizeForCompaction).not.toHaveBeenCalled();
    expect(useAgentStore.getState().compactingChats).toEqual([]);
  });

  it("routes state-memory compaction through the state updater and reports its failure", async () => {
    const { chat } = seed();
    chat.meta.stateMode = true;
    expect((await useAgentStore.getState().compactChatNow("a")).status).toBe("failed");
    expect(updateSkillState).toHaveBeenCalledTimes(1);
    expect(summarizeForCompaction).not.toHaveBeenCalled();
  });
});
