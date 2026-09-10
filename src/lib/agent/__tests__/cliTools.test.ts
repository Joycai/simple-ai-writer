import { beforeEach, describe, expect, it, vi } from "vitest";

const exists = vi.fn(async (_path: string) => true);
vi.mock("../../fs/fileio", () => ({ fileExists: (p: string) => exists(p) }));

const shell = { current: { kind: "zsh", path: "/bin/zsh", version: null } as { kind: string; path: string; version: string | null } | null };
vi.mock("../../cli/shell", async () => {
  const real = await vi.importActual<typeof import("../../cli/shell")>("../../cli/shell");
  return {
    ...real,
    cachedShellInfo: () => shell.current,
    shellInfo: async () => shell.current,
  };
});

const platform = { windows: false };
vi.mock("../../platform", () => ({
  get IS_WINDOWS() { return platform.windows; },
  IS_TAURI: true,
  IS_MAC: false,
}));

import { describeRunCommand, runCommandTool } from "../cliTools";
import type { ApprovalDecision, CommandProposal, Proposal, ToolContext } from "../registry";

const PROJECT = "/p/novel";

function ctxWith(decide: (p: Proposal) => ApprovalDecision): ToolContext & { seen: Proposal[] } {
  const seen: Proposal[] = [];
  return {
    projectPath: PROJECT,
    loreIndex: { entities: [], aliasMap: new Map() } as never,
    multimodal: false,
    requestApproval: async (p) => {
      seen.push(p);
      return decide(p);
    },
    seen,
  };
}

beforeEach(() => {
  exists.mockClear();
  shell.current = { kind: "zsh", path: "/bin/zsh", version: null };
  platform.windows = false;
});

describe("describeRunCommand", () => {
  it("names the machine's shell and its syntax", () => {
    expect(describeRunCommand()).toContain("in zsh, so write POSIX syntax");
    shell.current = { kind: "pwsh", path: "pwsh.exe", version: "7.4.1" };
    expect(describeRunCommand()).toContain("in PowerShell 7.4 (pwsh), so write PowerShell syntax");
  });
  it("guesses by platform before the probe has answered", () => {
    shell.current = null;
    expect(describeRunCommand()).toContain("in the login shell (zsh / bash), so write POSIX syntax");
    platform.windows = true;
    expect(describeRunCommand()).toContain("in PowerShell, so write PowerShell syntax");
  });
});

describe("runCommandTool", () => {
  it("refuses where no card can render, before anything else", async () => {
    const ctx = ctxWith(() => ({ approved: true }));
    ctx.requestApproval = undefined;
    const r = await runCommandTool("c1", { command: "git status" }, ctx);
    expect(r.content).toMatch(/^Error: this surface cannot review a command/);
  });

  it("needs a command", async () => {
    const ctx = ctxWith(() => ({ approved: true }));
    const r = await runCommandTool("c1", { command: "  " }, ctx);
    expect(r.content).toMatch(/^Error: 'command' is required/);
    expect(ctx.seen).toHaveLength(0);
  });

  it("builds the proposal with the three judgements already made, at the project root by default", async () => {
    const ctx = ctxWith(() => ({ approved: true, backupPath: "exit 0 · 0.1s · zsh" }));
    const r = await runCommandTool("c1", { command: "git status; rm -rf x", reason: "看看改了什么" }, ctx);
    expect(ctx.seen).toHaveLength(1);
    const p = ctx.seen[0] as CommandProposal;
    expect(p.kind).toBe("command");
    expect(p.command).toBe("git status; rm -rf x");
    expect(p.path).toBe(PROJECT);
    expect(p.cwdLabel).toBe(".");
    expect(p.program).toBe("git");
    expect(p.compound).toBe(true);
    expect(p.danger).toBe("delete");
    expect(p.timeoutMs).toBe(60_000);
    expect(p.shell.kind).toBe("zsh");
    expect(p.reason).toBe("看看改了什么");
    // The apply step's report comes back as the tool result, verbatim.
    expect(r.content).toBe("exit 0 · 0.1s · zsh");
  });

  it("resolves a project-relative cwd and refuses one outside or under .ai-writer", async () => {
    const ctx = ctxWith(() => ({ approved: true, backupPath: "ok" }));
    await runCommandTool("c1", { command: "ls", cwd: "卷一" }, ctx);
    expect((ctx.seen[0] as CommandProposal).path).toBe(`${PROJECT}/卷一`);
    expect((ctx.seen[0] as CommandProposal).cwdLabel).toBe("卷一");

    const outside = await runCommandTool("c2", { command: "ls", cwd: "../elsewhere" }, ctx);
    expect(outside.content).toMatch(/^Error: 'cwd' must be a folder inside the project/);
    const hidden = await runCommandTool("c3", { command: "ls", cwd: ".ai-writer/lore" }, ctx);
    expect(hidden.content).toMatch(/^Error: 'cwd' must be a folder inside the project/);
    expect(ctx.seen).toHaveLength(1);
  });

  it("checks a named cwd exists before raising a card", async () => {
    exists.mockResolvedValueOnce(false);
    const ctx = ctxWith(() => ({ approved: true }));
    const r = await runCommandTool("c1", { command: "ls", cwd: "missing" }, ctx);
    expect(r.content).toMatch(/^Error: there is no folder at/);
    expect(ctx.seen).toHaveLength(0);
  });

  it("clamps the timeout to [1s, 600s]", async () => {
    const ctx = ctxWith(() => ({ approved: true, backupPath: "ok" }));
    await runCommandTool("c1", { command: "x", timeout_seconds: 0 }, ctx);
    await runCommandTool("c2", { command: "x", timeout_seconds: 5000 }, ctx);
    await runCommandTool("c3", { command: "x", timeout_seconds: 90 }, ctx);
    expect(ctx.seen.map((p) => (p as CommandProposal).timeoutMs)).toEqual([1_000, 600_000, 90_000]);
  });

  it("without a shell there is no card", async () => {
    shell.current = null;
    const ctx = ctxWith(() => ({ approved: true }));
    const r = await runCommandTool("c1", { command: "x" }, ctx);
    expect(r.content).toMatch(/^Error: no shell is available/);
    expect(ctx.seen).toHaveLength(0);
  });

  it("a rejection tells the model not to try a variant", async () => {
    const ctx = ctxWith(() => ({ approved: false, reason: "不要动 git" }));
    const r = await runCommandTool("c1", { command: "git push" }, ctx);
    expect(r.content).toContain("REJECTED");
    expect(r.content).toContain("不要动 git");
    expect(r.content).toContain("Do not run it or a variant of it");
  });
});
