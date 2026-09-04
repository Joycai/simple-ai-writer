/**
 * A picture the assistant draws has to land in the transcript.
 *
 * Before this, the app saved it and said nothing, so the assistant — whose
 * only evidence was a tool result reading "Saved to …" — apologised for being
 * unable to show it. The transcript is filled from the approval, not from what
 * the model happens to say, because the app is the one that knows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IllustrateProposal } from "../agent/registry";

const runIllustration = vi.fn(async (_p?: unknown, _root?: string, _signal?: AbortSignal) => ({
  path: "/proj/.ai-writer/lore/characters/elden/ai-1.png",
  markdown: "",
  degraded: false,
}));
vi.mock("../image/illustrate", () => ({
  runIllustration: (p: unknown, root: string, signal?: AbortSignal) => runIllustration(p, root, signal),
}));
// applyProposal reaches for both stores; neither is loadable under vitest's
// node environment, and the illustrate path only needs projectPath from them.
vi.mock("../../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({ projectPath: "/proj", createEntry: vi.fn(), moveEntry: vi.fn(), deleteEntry: vi.fn() }),
  },
}));
vi.mock("../../stores/loreStore", () => ({
  useLoreStore: { getState: () => ({ scanProject: vi.fn() }) },
}));

const { useAgentStore, activeChat, emptyChat } = await import("../../stores/agentStore");

function illustrate(id: string): IllustrateProposal {
  return {
    kind: "illustrate", id, path: "/proj/.ai-writer/lore/characters/elden",
    prompt: "a knight", destination: "艾尔登",
    dest: { kind: "lore", entityName: "艾尔登", entityDir: "/proj/.ai-writer/lore/characters/elden" },
    note: "立绘", modelId: "m1", modelName: "Nano", costUsd: 0.04,
  };
}

/** A chat session with one assistant turn waiting for content. */
function seedChat(runId: unknown) {
  useAgentStore.setState({
    chats: {
      c0: {
        ...emptyChat("c0"),
        turns: [
          { id: "u1", role: "user", text: "画张立绘", log: [], at: 0 },
          { id: "a1", role: "assistant", text: "", log: [], at: 0 },
        ],
      },
    },
    chatOrder: ["c0"],
    activeChatKey: "c0",
    runningChats: ["c0"],
    chatAborts: { c0: runId as AbortController },
    pending: [],
  });
}
const turnsNow = () => activeChat(useAgentStore.getState()).turns;

/** What sendChat passes: the picture belongs to *this* turn, whatever happens later. */
const toTurn = (turnId: string) => ({ turnId });

beforeEach(() => {
  runIllustration.mockClear();
  useAgentStore.setState({
    chats: { c0: emptyChat("c0") }, chatOrder: ["c0"], activeChatKey: "c0",
    pending: [], runningChats: [], chatAborts: {},
  });
});

describe("approved illustrations in the transcript", () => {
  it("attaches the saved picture to the live assistant turn", async () => {
    const run = {};
    seedChat(run);
    const decision = useAgentStore.getState().requestApproval(illustrate("i1"), run, toTurn("a1"));
    await useAgentStore.getState().approve("i1");

    await expect(decision).resolves.toMatchObject({ approved: true });
    const turn = turnsNow().find((t) => t.id === "a1");
    expect(turn?.images).toEqual(["/proj/.ai-writer/lore/characters/elden/ai-1.png"]);
  });

  it("still attaches the picture after the author pressed 停止", async () => {
    // stopChat clears chatAbort, and approve() has already left the pending
    // queue — so the run was over by every measure the store used to check
    // while the (paid-for) generation was still in flight. The picture landed
    // on disk and never appeared in the conversation.
    const run = {};
    seedChat(run);
    const decision = useAgentStore.getState().requestApproval(illustrate("i1"), run, toTurn("a1"));
    const applied = useAgentStore.getState().approve("i1");
    useAgentStore.setState({ chatAborts: {}, runningChats: [] });
    await applied;
    await decision;

    expect(turnsNow().find((t) => t.id === "a1")?.images)
      .toEqual(["/proj/.ai-writer/lore/characters/elden/ai-1.png"]);
  });

  it("hands the run's abort signal to the generation", async () => {
    // Approval removes the card from the queue, so rejectAll can no longer
    // cancel it — the signal is the only remaining way 停止 reaches the
    // request that is spending the author's money.
    const controller = new AbortController();
    seedChat(controller);
    useAgentStore.getState().requestApproval(illustrate("i1"), controller, {
      turnId: "a1", signal: controller.signal,
    });
    await useAgentStore.getState().approve("i1");

    expect(runIllustration).toHaveBeenCalledWith(
      expect.anything(), "/proj", controller.signal,
    );
  });

  it("tells the model the picture is already on screen", async () => {
    // Otherwise it apologises for being unable to show what it just drew.
    const run = {};
    seedChat(run);
    const decision = useAgentStore.getState().requestApproval(illustrate("i1"), run, toTurn("a1"));
    await useAgentStore.getState().approve("i1");
    const result = await decision;
    expect(result.approved).toBe(true);
    expect((result as { backupPath?: string }).backupPath).toMatch(/shown to the author/i);
  });

  it("collects several pictures on one turn", async () => {
    const run = {};
    seedChat(run);
    const first = useAgentStore.getState().requestApproval(illustrate("i1"), run, toTurn("a1"));
    await useAgentStore.getState().approve("i1");
    runIllustration.mockResolvedValueOnce({ path: "/proj/b.png", markdown: "", degraded: false });
    const second = useAgentStore.getState().requestApproval(illustrate("i2"), run, toTurn("a1"));
    await useAgentStore.getState().approve("i2");
    await Promise.all([first, second]);

    expect(turnsNow().find((t) => t.id === "a1")?.images).toHaveLength(2);
  });

  it("leaves the transcript alone for another run's picture", async () => {
    // The task panel shares this queue and has no chat turn to attach to;
    // its images must not appear in the conversation.
    seedChat({});
    const other = {};
    const decision = useAgentStore.getState().requestApproval(illustrate("i1"), other);
    await useAgentStore.getState().approve("i1");
    await decision;

    expect(turnsNow().find((t) => t.id === "a1")?.images).toBeUndefined();
  });

  it("adds nothing when the generation fails", async () => {
    const run = {};
    seedChat(run);
    runIllustration.mockRejectedValueOnce(new Error("provider exploded"));
    const decision = useAgentStore.getState().requestApproval(illustrate("i1"), run, toTurn("a1"));
    await useAgentStore.getState().approve("i1");

    // A failed apply reports as a rejection, so the model knows nothing exists.
    await expect(decision).resolves.toMatchObject({ approved: false });
    expect(turnsNow().find((t) => t.id === "a1")?.images).toBeUndefined();
  });
});
