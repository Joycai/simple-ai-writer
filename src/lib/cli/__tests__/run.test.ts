import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const files = new Map<string, string>();
vi.mock("../../fs/fileio", () => ({
  makeDir: vi.fn(async () => {}),
  writeFile: vi.fn(async (p: string, c: string) => void files.set(p, c)),
  removeFile: vi.fn(async (p: string) => void files.delete(p)),
  readDir: vi.fn(async () =>
    [...files.keys()].map((p) => ({ name: p.slice(p.lastIndexOf("/") + 1), path: p, isDirectory: false })),
  ),
}));

import { CLIP_HEAD, CLIP_TAIL, type CmdResult } from "../output";
import { clampTimeout, CMD_LOGS_KEPT, needsLog, runCommand, sweepLogs } from "../run";

function result(over: Partial<CmdResult> = {}): CmdResult {
  return {
    pid: 1, exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 10,
    timedOut: false, killed: false, stdoutTruncated: false, stderrTruncated: false,
    shell: { kind: "zsh", path: "/bin/zsh", version: null },
    ...over,
  };
}

beforeEach(() => {
  invoke.mockReset();
  files.clear();
});

describe("clampTimeout", () => {
  it("缺席＝默认；两端夹住", () => {
    expect(clampTimeout(undefined)).toBe(60_000);
    expect(clampTimeout(NaN)).toBe(60_000);
    expect(clampTimeout(5)).toBe(1_000);
    expect(clampTimeout(9_999_999)).toBe(600_000);
    expect(clampTimeout(120_000)).toBe(120_000);
  });
});

describe("runCommand", () => {
  it("发 cmd_run，短输出不落日志", async () => {
    invoke.mockResolvedValueOnce(result());
    const out = await runCommand({ projectPath: "/p", command: "echo ok", cwd: "/p", timeoutMs: 60_000 });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [name, args] = invoke.mock.calls[0] as [string, { req: Record<string, unknown> }];
    expect(name).toBe("cmd_run");
    expect(args.req).toMatchObject({ command: "echo ok", cwd: "/p", timeoutMs: 60_000 });
    expect(typeof args.req.runId).toBe("string");
    expect(out.logPath).toBeNull();
    expect(out.report).toContain("--- stdout ---\nok");
    expect(files.size).toBe(0);
  });

  it("长输出落日志，报告指向它", async () => {
    invoke.mockResolvedValueOnce(result({ stdout: "y".repeat(CLIP_HEAD + CLIP_TAIL + 1) }));
    const out = await runCommand({ projectPath: "/p", command: "yes", cwd: "/p", timeoutMs: 60_000 });
    expect(out.logPath).toMatch(/^\/p\/\.ai-writer\/tmp\/cmd\/\d{8}-\d{6}-.*\.log$/);
    expect(files.get(out.logPath!)).toContain("$ yes");
    expect(out.report).toContain(`full log is at ${out.logPath}`);
  });

  it("中止 → cmd_kill 带同一个 runId", async () => {
    const controller = new AbortController();
    let resolveRun: (r: CmdResult) => void = () => {};
    invoke.mockImplementation((name: string) => {
      if (name === "cmd_run") return new Promise<CmdResult>((res) => { resolveRun = res; });
      return Promise.resolve();
    });
    const pending = runCommand({ projectPath: "/p", command: "sleep 30", cwd: "/p", timeoutMs: 60_000, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    const runId = (invoke.mock.calls[0][1] as { req: { runId: string } }).req.runId;
    expect(invoke).toHaveBeenCalledWith("cmd_kill", { runId });
    resolveRun(result({ killed: true, exitCode: null }));
    const out = await pending;
    expect(out.report.startsWith("stopped by the author")).toBe(true);
  });

  it("开始前已中止：不发任何 invoke", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCommand({ projectPath: "/p", command: "x", cwd: "/p", timeoutMs: 1000, signal: controller.signal }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("needsLog / sweepLogs", () => {
  it("封顶标记也算需要日志", () => {
    expect(needsLog(result())).toBe(false);
    expect(needsLog(result({ stderrTruncated: true }))).toBe(true);
  });
  it("只留最新的 N 份，按名字（时间戳）排", async () => {
    for (let i = 0; i < CMD_LOGS_KEPT + 3; i++) {
      files.set(`/p/.ai-writer/tmp/cmd/20260910-${String(100000 + i)}-x.log`, "");
    }
    files.set("/p/.ai-writer/tmp/cmd/keep.txt", "");
    await sweepLogs("/p/.ai-writer/tmp/cmd");
    const logs = [...files.keys()].filter((p) => p.endsWith(".log"));
    expect(logs.length).toBe(CMD_LOGS_KEPT);
    expect(logs.some((p) => p.includes("100000-x"))).toBe(false);
    expect(files.has("/p/.ai-writer/tmp/cmd/keep.txt")).toBe(true);
  });
});
