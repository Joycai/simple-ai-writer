import { describe, expect, it, beforeEach, vi } from "vitest";

import { canGrantCommand, chatAutoApproveKey, grants, grantsAppend, grantsCommand, isAutoApprovable } from "../autoApprove";

/** The active conversation's key in these tests — the store starts with one tab, `c0`. */
const CHAT_AUTO_APPROVE_KEY = chatAutoApproveKey("c0");
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

import { activeChat, emptyChat, useAgentStore } from "../../../stores/agentStore";

const RUN = {} as unknown; // stands in for a panel run's AbortController

function editProposal(id: string): Proposal {
  return {
    kind: "edit", id, path: "/p/writing/ch1.md",
    find: "TARGET", replace: "REPLACED", occurrences: 1, reason: "tighten",
    matches: [{ line: 1, endLine: 1, before: "", after: "" }],
  };
}

function deleteProposal(id: string): Proposal {
  return { kind: "delete", id, path: "/p/writing/ch1.md", chars: 120 };
}

function commandProposal(id: string, command: string, over: Partial<Extract<Proposal, { kind: "command" }>> = {}): Proposal {
  return {
    kind: "command", id, path: "/p", command, cwdLabel: ".", timeoutMs: 60_000,
    shell: { kind: "zsh", path: "/bin/zsh", version: null },
    program: "git", compound: false, danger: null,
    ...over,
  };
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
    for (const kind of ["edit", "rewrite", "create", "move", "copy", "convert"] as const) {
      expect(isAutoApprovable(kind)).toBe(true);
    }
    // Green-to-red here means a prose grant started deleting files or
    // spending money without a card.
    expect(isAutoApprovable("delete")).toBe(false);
    expect(isAutoApprovable("illustrate")).toBe(false);
    // ...or running shell commands: a prose grant is not a shell grant.
    expect(isAutoApprovable("command")).toBe(false);
  });
});

describe("per-program command grants (shell-command-plan §3.4)", () => {
  const simple = { program: "git", compound: false, danger: null };

  it("the row is offered only for a simple, ordinary line", () => {
    expect(canGrantCommand(simple)).toBe(true);
    expect(canGrantCommand({ ...simple, compound: true })).toBe(false);
    expect(canGrantCommand({ ...simple, danger: "delete" })).toBe(false);
    expect(canGrantCommand({ ...simple, program: "" })).toBe(false);
  });

  it("covers the named program and re-judges every line", () => {
    const state = {
      key: CHAT_AUTO_APPROVE_KEY, proposals: false, plans: false,
      appendPaths: [], illustrateLeft: 0, commandPrograms: ["git"],
    };
    expect(grantsCommand(state, CHAT_AUTO_APPROVE_KEY, simple)).toBe(true);
    expect(grantsCommand(state, CHAT_AUTO_APPROVE_KEY, { ...simple, program: "pandoc" })).toBe(false);
    // `git status` earned the grant; `git status; rm -rf ~` must not ride it.
    expect(grantsCommand(state, CHAT_AUTO_APPROVE_KEY, { ...simple, compound: true })).toBe(false);
    expect(grantsCommand(state, CHAT_AUTO_APPROVE_KEY, { ...simple, danger: "history-rewrite" })).toBe(false);
    // The key rule of every grant.
    expect(grantsCommand(state, RUN, simple)).toBe(false);
    expect(grantsCommand(state, undefined, simple)).toBe(false);
    expect(grantsCommand(null, CHAT_AUTO_APPROVE_KEY, simple)).toBe(false);
  });

  it("a blanket 本次都批准 never covers a command", () => {
    const state = {
      key: CHAT_AUTO_APPROVE_KEY, proposals: true, plans: true,
      appendPaths: [], illustrateLeft: 0, commandPrograms: [],
    };
    expect(grantsCommand(state, CHAT_AUTO_APPROVE_KEY, simple)).toBe(false);
  });
});

describe("本次都批准 grants", () => {
  beforeEach(() => {
    written.length = 0;
    useAgentStore.setState({
      pending: [], pendingPlans: [], autoApprove: null,
      chats: { c0: emptyChat("c0") }, chatOrder: ["c0"], activeChatKey: "c0",
      runningChats: [], compactingChats: [], chatQueue: [], chatAborts: {},
    });
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
      key: RUN, proposals: false, plans: true, appendPaths: [], illustrateLeft: 0, commandPrograms: [],
    });
  });

  it("merges kinds when the same surface grants twice", () => {
    const store = useAgentStore.getState();
    store.enableAutoApprove(CHAT_AUTO_APPROVE_KEY, "proposals");
    store.enableAutoApprove(CHAT_AUTO_APPROVE_KEY, "plans");

    expect(useAgentStore.getState().autoApprove).toEqual({
      key: CHAT_AUTO_APPROVE_KEY, proposals: true, plans: true, appendPaths: [], illustrateLeft: 0, commandPrograms: [],
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

  it("a program grant skips the card for a simple line of that program and nothing else", () => {
    const store = useAgentStore.getState();
    store.grantCommandProgram(CHAT_AUTO_APPROVE_KEY, "git");
    store.grantCommandProgram(CHAT_AUTO_APPROVE_KEY, "git"); // idempotent

    expect(useAgentStore.getState().autoApprove).toMatchObject({ commandPrograms: ["git"] });
    // The store's own coverage path, not just the pure predicate. A covered
    // command never queues; the apply step it reaches is mocked away by the
    // module mocks above, so only queue membership is asserted.
    void store.requestApproval(commandProposal("c1", "git status; rm -rf ~", { compound: true }), RUN, { autoApproveKey: CHAT_AUTO_APPROVE_KEY });
    void store.requestApproval(commandProposal("c2", "git push --force", { danger: "history-rewrite" }), RUN, { autoApproveKey: CHAT_AUTO_APPROVE_KEY });
    void store.requestApproval(commandProposal("c3", "pandoc a.md -o a.epub", { program: "pandoc" }), RUN, { autoApproveKey: CHAT_AUTO_APPROVE_KEY });
    expect(useAgentStore.getState().pending.map((p) => p.proposal.id)).toEqual(["c1", "c2", "c3"]);
    // A blanket grant on top changes nothing for commands.
    store.enableAutoApprove(CHAT_AUTO_APPROVE_KEY, "proposals");
    void store.requestApproval(commandProposal("c4", "pandoc x", { program: "pandoc" }), RUN, { autoApproveKey: CHAT_AUTO_APPROVE_KEY });
    expect(useAgentStore.getState().pending.map((p) => p.proposal.id)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("keeps 本次都批准 alongside a per-file append grant", () => {
    const store = useAgentStore.getState();
    store.grantAppendPath(CHAT_AUTO_APPROVE_KEY, "/proj/page.html");
    store.enableAutoApprove(CHAT_AUTO_APPROVE_KEY, "proposals");

    expect(useAgentStore.getState().autoApprove).toEqual({
      key: CHAT_AUTO_APPROVE_KEY, proposals: true, plans: false,
      appendPaths: ["/proj/page.html"], illustrateLeft: 0, commandPrograms: [],
    });
  });

  it("ends chat's grant on a new conversation", () => {
    useAgentStore.setState({
      autoApprove: { key: CHAT_AUTO_APPROVE_KEY, proposals: true, plans: true, appendPaths: [], illustrateLeft: 0, commandPrograms: [] },
    });
    useAgentStore.getState().newChat();
    expect(useAgentStore.getState().autoApprove).toBeNull();
  });

  it("does not carry chat's grant into another saved conversation", async () => {
    useAgentStore.setState((st) => ({
      autoApprove: { key: CHAT_AUTO_APPROVE_KEY, proposals: true, plans: false, appendPaths: [], illustrateLeft: 0, commandPrograms: [] },
      chats: { c0: { ...activeChat(st), sessionId: 1 } },
    }));

    await useAgentStore.getState().switchChatSession(2);

    // Standing authorisation to rewrite prose is the last thing that should
    // follow the author into another manuscript: whatever tab the saved
    // conversation opened in, no grant covers it.
    const st = useAgentStore.getState();
    expect(activeChat(st).sessionId).toBe(2);
    expect(grants(st.autoApprove, chatAutoApproveKey(st.activeChatKey), "proposals")).toBe(false);
  });

  it("keeps one conversation's grant off another open conversation", () => {
    useAgentStore.setState({
      autoApprove: { key: chatAutoApproveKey("c0"), proposals: true, plans: false, appendPaths: [], illustrateLeft: 0, commandPrograms: [] },
    });
    // The literal "chat" key would have covered both; the per-conversation
    // key covers exactly the one it was pressed in.
    expect(grants(useAgentStore.getState().autoApprove, chatAutoApproveKey("c1"), "proposals")).toBe(false);
    expect(grants(useAgentStore.getState().autoApprove, chatAutoApproveKey("c0"), "proposals")).toBe(true);
  });
});
