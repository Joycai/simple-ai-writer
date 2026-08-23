import { describe, expect, it, beforeEach, vi } from "vitest";

import { CHAT_AUTO_APPROVE_KEY, grants, grantsAppend, isAutoApprovable } from "../autoApprove";
import type { Proposal } from "../registry";

// Same shims as subagentChips.test: agentStore reaches projectStore lazily, and
// pulling the real one into a node test drags appStore's `document` access in.
vi.mock("../../../stores/projectStore", () => ({
  useProjectStore: { getState: () => ({ projectPath: "/p", activeFilePath: null }) },
}));
vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: { getState: () => ({ content: "", setContent: () => {} }) },
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
// The apply path is not what these tests are about — they are about whether it
// is reached at all, and with a card or without one.
const written = vi.hoisted(() => [] as { path: string; body: string }[]);
vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async () => "before TARGET after"),
  writeFile: vi.fn(async (path: string, body: string) => { written.push({ path, body }); }),
  fileExists: vi.fn(async () => true),
}));
vi.mock("../backup", () => ({ backupFile: vi.fn(async () => "/p/.ai-writer/backups/x.md") }));

import { useAgentStore } from "../../../stores/agentStore";

const RUN = {} as unknown; // stands in for a panel run's AbortController

function editProposal(id: string): Proposal {
  return {
    kind: "edit", id, path: "/p/writing/ch1.md",
    find: "TARGET", replace: "REPLACED", occurrences: 1, reason: "tighten",
  };
}

function deleteProposal(id: string): Proposal {
  return { kind: "delete", id, path: "/p/writing/ch1.md", chars: 120 };
}

function illustrateProposal(id: string): Proposal {
  return {
    kind: "illustrate", id, path: "/p/writing/ch1.md",
    prompt: "a silver-haired knight", destination: "ch1 插图",
    dest: { kind: "document", docPath: "/p/writing/ch1.md" },
    note: "knight", modelId: "m1", modelName: "Test Image", costUsd: 0.04,
  };
}

describe("isAutoApprovable — the kind-level floor", () => {
  it("covers the text-moving kinds, copy included, and never delete/illustrate", () => {
    for (const kind of ["edit", "rewrite", "create", "move", "copy"] as const) {
      expect(isAutoApprovable(kind)).toBe(true);
    }
    // Green-to-red here means a prose grant started deleting files or
    // spending money without a card.
    expect(isAutoApprovable("delete")).toBe(false);
    expect(isAutoApprovable("illustrate")).toBe(false);
  });
});

describe("本次都批准 grants", () => {
  beforeEach(() => {
    written.length = 0;
    useAgentStore.setState({ pending: [], pendingPlans: [], autoApprove: null, turns: [] });
  });

  it("applies a covered proposal without ever queuing a card", async () => {
    const store = useAgentStore.getState();
    store.enableAutoApprove(CHAT_AUTO_APPROVE_KEY, "proposals");

    const decision = await store.requestApproval(editProposal("e1"), RUN, {
      autoApproveKey: CHAT_AUTO_APPROVE_KEY,
    });

    expect(decision).toMatchObject({ approved: true, auto: true });
    // Not "emptied afterwards" — never entered. A card that appears for a
    // frame and self-approves is a different, worse thing.
    expect(useAgentStore.getState().pending).toEqual([]);
    expect(written).toEqual([{ path: "/p/writing/ch1.md", body: "before REPLACED after" }]);
  });

  // The floor of the whole design. If this ever goes green-to-red, a grant the
  // author gave for prose has started deleting chapters and buying pictures.
  it("still asks for delete and illustrate, grant or no grant", () => {
    const store = useAgentStore.getState();
    store.enableAutoApprove(CHAT_AUTO_APPROVE_KEY, "proposals");

    void store.requestApproval(deleteProposal("d1"), RUN, { autoApproveKey: CHAT_AUTO_APPROVE_KEY });
    void store.requestApproval(illustrateProposal("i1"), RUN, { autoApproveKey: CHAT_AUTO_APPROVE_KEY });

    expect(useAgentStore.getState().pending.map((p) => p.proposal.id)).toEqual(["d1", "i1"]);
  });

  it("does not let one surface's grant cover another's proposal", () => {
    const store = useAgentStore.getState();
    store.enableAutoApprove(RUN, "proposals"); // panel task granted

    void store.requestApproval(editProposal("e1"), RUN, {
      autoApproveKey: CHAT_AUTO_APPROVE_KEY, // ...chat asks
    });

    expect(useAgentStore.getState().pending.map((p) => p.proposal.id)).toEqual(["e1"]);
  });

  it("skips the plan card but keeps the plan itself", async () => {
    const store = useAgentStore.getState();
    store.enableAutoApprove(CHAT_AUTO_APPROVE_KEY, "plans");

    const plan = { id: "p1", steps: [{ action: "update" as const, entity: "Ava", detail: "age" }] };
    const decision = await store.requestPlanApproval(plan, RUN, CHAT_AUTO_APPROVE_KEY);

    expect(decision).toEqual({ approved: true });
    expect(useAgentStore.getState().pendingPlans).toEqual([]);
    // A grant for plans is not a grant for manuscript edits.
    void store.requestApproval(editProposal("e1"), RUN, { autoApproveKey: CHAT_AUTO_APPROVE_KEY });
    expect(useAgentStore.getState().pending).toHaveLength(1);
  });

  it("holds only one grant at a time — a new surface displaces the old", () => {
    const store = useAgentStore.getState();
    store.enableAutoApprove(CHAT_AUTO_APPROVE_KEY, "proposals");
    store.enableAutoApprove(RUN, "plans");

    expect(useAgentStore.getState().autoApprove).toEqual({
      key: RUN, proposals: false, plans: true, appendPaths: [], illustrateLeft: 0,
    });
  });

  it("merges kinds when the same surface grants twice", () => {
    const store = useAgentStore.getState();
    store.enableAutoApprove(CHAT_AUTO_APPROVE_KEY, "proposals");
    store.enableAutoApprove(CHAT_AUTO_APPROVE_KEY, "plans");

    expect(useAgentStore.getState().autoApprove).toEqual({
      key: CHAT_AUTO_APPROVE_KEY, proposals: true, plans: true, appendPaths: [], illustrateLeft: 0,
    });
  });

  it("ends a panel run's grant when the run drains its queues", () => {
    const store = useAgentStore.getState();
    store.enableAutoApprove(RUN, "proposals");

    store.rejectAll("task ended", RUN);

    expect(useAgentStore.getState().autoApprove).toBeNull();
  });

  it("leaves chat's grant alone when an unrelated run ends", () => {
    const store = useAgentStore.getState();
    store.enableAutoApprove(CHAT_AUTO_APPROVE_KEY, "proposals");

    store.rejectAll("task ended", RUN);

    expect(useAgentStore.getState().autoApprove).toMatchObject({ key: CHAT_AUTO_APPROVE_KEY });
  });

  it("covers only the file it names, and only appends", () => {
    const store = useAgentStore.getState();
    store.grantAppendPath(CHAT_AUTO_APPROVE_KEY, "/proj/page.html");
    const state = useAgentStore.getState().autoApprove;

    expect(grantsAppend(state, CHAT_AUTO_APPROVE_KEY, "/proj/page.html")).toBe(true);
    expect(grantsAppend(state, CHAT_AUTO_APPROVE_KEY, "/proj/other.html")).toBe(false);
    // The narrow grant must not quietly become a blanket one.
    expect(grants(state, CHAT_AUTO_APPROVE_KEY, "proposals")).toBe(false);
    expect(grants(state, CHAT_AUTO_APPROVE_KEY, "plans")).toBe(false);
  });

  it("belongs to the surface that made it", () => {
    const store = useAgentStore.getState();
    store.grantAppendPath(CHAT_AUTO_APPROVE_KEY, "/proj/page.html");
    const state = useAgentStore.getState().autoApprove;

    expect(grantsAppend(state, RUN, "/proj/page.html")).toBe(false);
    expect(grantsAppend(state, undefined, "/proj/page.html")).toBe(false);
  });

  it("keeps 本次都批准 alongside a per-file append grant", () => {
    const store = useAgentStore.getState();
    store.grantAppendPath(CHAT_AUTO_APPROVE_KEY, "/proj/page.html");
    store.enableAutoApprove(CHAT_AUTO_APPROVE_KEY, "proposals");

    expect(useAgentStore.getState().autoApprove).toEqual({
      key: CHAT_AUTO_APPROVE_KEY, proposals: true, plans: false,
      appendPaths: ["/proj/page.html"], illustrateLeft: 0,
    });
  });

  it("ends chat's grant on a new conversation", () => {
    useAgentStore.setState({
      autoApprove: { key: CHAT_AUTO_APPROVE_KEY, proposals: true, plans: true, appendPaths: [], illustrateLeft: 0 },
    });
    useAgentStore.getState().resetChat();
    expect(useAgentStore.getState().autoApprove).toBeNull();
  });

  it("ends chat's grant when switching to another saved conversation", async () => {
    useAgentStore.setState({
      autoApprove: { key: CHAT_AUTO_APPROVE_KEY, proposals: true, plans: false, appendPaths: [], illustrateLeft: 0 },
      chatSessionId: 1, chatRunning: false, turns: [],
    });

    await useAgentStore.getState().switchChatSession(2);

    expect(useAgentStore.getState().autoApprove).toBeNull();
  });
});
