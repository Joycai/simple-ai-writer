import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandProposal } from "../../lib/agent/toolTypes";
const environment = vi.hoisted(() => ({ project: "/project", cli: true }));
const runCommand = vi.fn(async () => ({ report: "exit 0" }));
vi.mock("../../lib/cli/run", () => ({ runCommand: (...args: unknown[]) => (runCommand as (...args: unknown[]) => unknown)(...args) }));
vi.mock("../../lib/cli/flag", () => ({ isCliEnabled: () => environment.cli }));
vi.mock("../projectStore", () => ({ useProjectStore: { getState: () => ({ projectPath: environment.project }) } }));
import { useAgentStore } from "../agentStore";
import { chatFromSnapshot, emptyChat } from "../agent/chatJob";
import { createSessionMeta } from "../../lib/agent/compact";
await import("../projectStore");
await import("../../lib/cli/run");
const state = () => useAgentStore.getState();
const command: CommandProposal = {
  kind: "command", id: "command", path: "/project", command: "pnpm test", cwdLabel: ".", timeoutMs: 60000,
  shell: { kind: "zsh", path: "/bin/zsh", version: null, os: "macos", osVersion: null, arch: "arm64" }, compound: false, danger: null,
};
let run: AbortController;
const binding = (): NonNullable<Parameters<ReturnType<typeof useAgentStore.getState>["requestApproval"]>[2]> => ({ projectPath: "/project", autoApproveKey: "chat:a", surface: "chat:a", signal: run.signal });
beforeEach(() => {
  run = new AbortController(); environment.project = "/project"; environment.cli = true; runCommand.mockClear();
  useAgentStore.setState({ chats: { a: emptyChat("a"), b: emptyChat("b") }, chatOrder: ["a", "b"], activeChatKey: "a", chatAborts: { a: run }, pending: [], autoApprove: null, runningChats: [], chatQueue: [], compactingChats: [] });
  state().setCodeDevelopment(true, "/project", "a");
});
afterEach(() => {
  for (const owner of new Set(state().pending.map(item => item.runId))) state().rejectAll("cleanup", owner);
});

describe("live chat code permission", () => {
  it("uses the owning chat even when another tab is active; spans turns without consuming batch grants", async () => {
    state().grantCommands("chat:a", run, 2);
    state().activateChat("b");
    expect(await state().requestApproval(command, run, binding())).toMatchObject({ approved: true, auto: true });
    expect(state().autoApprove?.commandLeft).toBe(2);
    run = new AbortController(); useAgentStore.setState({ chatAborts: { a: run } });
    expect(await state().requestApproval(command, run, binding())).toMatchObject({ approved: true, auto: true });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
  it("does not sweep an already visible card when enabled", () => {
    state().setCodeDevelopment(false, "/project", "a");
    void state().requestApproval(command, run, binding());
    state().setCodeDevelopment(true, "/project", "a");
    expect(state().pending).toHaveLength(1); expect(runCommand).not.toHaveBeenCalled();
  });
  it("requires matching run, surface, grant owner and project", () => {
    void state().requestApproval(command, {}, binding());
    void state().requestApproval(command, run, { ...binding(), surface: "panel" });
    void state().requestApproval(command, run, { ...binding(), autoApproveKey: "chat:b", surface: "chat:b" });
    void state().requestApproval(command, run, { ...binding(), projectPath: "/other" });
    void state().requestApproval(command, run, { ...binding(), signal: undefined });
    void state().requestApproval(command, run);
    expect(state().pending).toHaveLength(6); expect(runCommand).not.toHaveBeenCalled();
  });
  it.each(["disable", "project", "parent-project", "flag", "close"])("rechecks %s after async imports and before spawn", async scenario => {
    const result = state().requestApproval(command, run, binding());
    if (scenario === "disable") state().setCodeDevelopment(false, "/project", "a");
    if (scenario === "project") environment.project = "/other";
    if (scenario === "parent-project") {
      environment.project = "/";
      state().setCodeDevelopment(true, "/", "a");
    }
    if (scenario === "flag") environment.cli = false;
    if (scenario === "close") useAgentStore.setState({ chats: { b: emptyChat("b") } });
    await vi.waitFor(() => expect(state().pending).toHaveLength(1));
    expect(state().pending[0].proposal).toMatchObject({ requiresIndividualApproval: true });
    expect(runCommand).not.toHaveBeenCalled();
    state().rejectAll("closed", run);
    expect(await result).toMatchObject({ approved: false });
  });
  it("cancellation during authorization never executes or leaves an orphaned approval", async () => {
    const result = state().requestApproval(command, run, binding()); run.abort();
    expect(await result).toMatchObject({ approved: false });
    expect(runCommand).not.toHaveBeenCalled(); expect(state().pending).toHaveLength(0);
  });
  it("does not authorize SQL, system commands, or runtime-denied reads", () => {
    for (const c of ["psql -c 'select 1'", "sudo npm install", "bash task.sh"]) void state().requestApproval({ ...command, command: c }, run, binding());
    void state().requestApproval({ ...command, requiresIndividualApproval: true }, run, binding());
    expect(state().pending).toHaveLength(4); expect(runCommand).not.toHaveBeenCalled();
  });
  it("new, restored and project-reset chats start disabled", async () => {
    expect(emptyChat("c").codeDevelopment).toBeNull();
    const restored = chatFromSnapshot({ turns: [], history: [], meta: createSessionMeta(), usage: null, taskId: null }, 1, "saved", null);
    expect(restored.codeDevelopment).toBeNull();
    const freshKey = state().newChat();
    expect(state().chats[freshKey].codeDevelopment).toBeNull();
    await state().resetChatForProject(null);
    expect(Object.values(state().chats).every(chat => chat.codeDevelopment === null)).toBe(true);
  });
  it("cannot enable when the CLI capability is disabled", () => {
    state().setCodeDevelopment(false, "/project", "a"); environment.cli = false;
    state().setCodeDevelopment(true, "/project", "a");
    expect(state().chats.a.codeDevelopment).toBeNull();
  });
});
