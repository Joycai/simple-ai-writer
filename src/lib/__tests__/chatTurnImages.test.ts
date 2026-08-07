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

const runIllustration = vi.fn(async () => ({
  path: "/proj/.ai-writer/lore/characters/elden/ai-1.png",
  markdown: "",
  degraded: false,
}));
vi.mock("../image/illustrate", () => ({ runIllustration: () => runIllustration() }));
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

const { useAgentStore } = await import("../../stores/agentStore");

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
    turns: [
      { id: "u1", role: "user", text: "画张立绘", log: [], at: 0 },
      { id: "a1", role: "assistant", text: "", log: [], at: 0 },
    ],
    chatAbort: runId as AbortController,
    pending: [],
  });
}

beforeEach(() => {
  runIllustration.mockClear();
  useAgentStore.setState({ turns: [], pending: [], chatAbort: null });
});

describe("approved illustrations in the transcript", () => {
  it("attaches the saved picture to the live assistant turn", async () => {
    const run = {};
    seedChat(run);
    const decision = useAgentStore.getState().requestApproval(illustrate("i1"), run);
    await useAgentStore.getState().approve("i1");

    await expect(decision).resolves.toMatchObject({ approved: true });
    const turn = useAgentStore.getState().turns.find((t) => t.id === "a1");
    expect(turn?.images).toEqual(["/proj/.ai-writer/lore/characters/elden/ai-1.png"]);
  });

  it("tells the model the picture is already on screen", async () => {
    // Otherwise it apologises for being unable to show what it just drew.
    const run = {};
    seedChat(run);
    const decision = useAgentStore.getState().requestApproval(illustrate("i1"), run);
    await useAgentStore.getState().approve("i1");
    const result = await decision;
    expect(result.approved).toBe(true);
    expect((result as { backupPath?: string }).backupPath).toMatch(/shown to the author/i);
  });

  it("collects several pictures on one turn", async () => {
    const run = {};
    seedChat(run);
    const first = useAgentStore.getState().requestApproval(illustrate("i1"), run);
    await useAgentStore.getState().approve("i1");
    runIllustration.mockResolvedValueOnce({ path: "/proj/b.png", markdown: "", degraded: false });
    const second = useAgentStore.getState().requestApproval(illustrate("i2"), run);
    await useAgentStore.getState().approve("i2");
    await Promise.all([first, second]);

    expect(useAgentStore.getState().turns.find((t) => t.id === "a1")?.images).toHaveLength(2);
  });

  it("leaves the transcript alone for another run's picture", async () => {
    // The task panel shares this queue and has no chat turn to attach to;
    // its images must not appear in the conversation.
    seedChat({});
    const other = {};
    const decision = useAgentStore.getState().requestApproval(illustrate("i1"), other);
    await useAgentStore.getState().approve("i1");
    await decision;

    expect(useAgentStore.getState().turns.find((t) => t.id === "a1")?.images).toBeUndefined();
  });

  it("adds nothing when the generation fails", async () => {
    const run = {};
    seedChat(run);
    runIllustration.mockRejectedValueOnce(new Error("provider exploded"));
    const decision = useAgentStore.getState().requestApproval(illustrate("i1"), run);
    await useAgentStore.getState().approve("i1");

    // A failed apply reports as a rejection, so the model knows nothing exists.
    await expect(decision).resolves.toMatchObject({ approved: false });
    expect(useAgentStore.getState().turns.find((t) => t.id === "a1")?.images).toBeUndefined();
  });
});
