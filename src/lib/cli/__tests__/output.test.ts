import { describe, expect, it } from "vitest";
import { CLIP_HEAD, CLIP_TAIL, clipForModel, formatResult, type CmdResult } from "../output";
import { shellLabel } from "../shell";

const zsh = { kind: "zsh" as const, path: "/bin/zsh", version: null };
const pwsh = { kind: "pwsh" as const, path: "pwsh.exe", version: "7.4.1" };

function result(over: Partial<CmdResult> = {}): CmdResult {
  return {
    pid: 1,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1234,
    timedOut: false,
    killed: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    shell: zsh,
    ...over,
  };
}

describe("clipForModel", () => {
  it("短于上限不动，正好上限不动", () => {
    const short = "a".repeat(100);
    expect(clipForModel(short)).toEqual({ text: short, omitted: 0 });
    const exact = "b".repeat(CLIP_HEAD + CLIP_TAIL);
    expect(clipForModel(exact)).toEqual({ text: exact, omitted: 0 });
  });
  it("超一字就截：头 + 标记 + 尾，标记里写省略数", () => {
    const text = "h".repeat(CLIP_HEAD) + "X" + "t".repeat(CLIP_TAIL);
    const out = clipForModel(text);
    expect(out.omitted).toBe(1);
    expect(out.text.startsWith("h".repeat(CLIP_HEAD))).toBe(true);
    expect(out.text.endsWith("t".repeat(CLIP_TAIL))).toBe(true);
    expect(out.text).toContain("[1 characters omitted]");
    expect(out.text).not.toContain("X");
  });
});

describe("shellLabel", () => {
  it("两位版本号；unix 只有名字", () => {
    expect(shellLabel(pwsh)).toBe("PowerShell 7.4 (pwsh)");
    expect(shellLabel({ kind: "powershell", path: "powershell.exe", version: "5.1.26100.1" })).toBe("Windows PowerShell 5.1");
    expect(shellLabel({ kind: "pwsh", path: "pwsh.exe", version: null })).toBe("PowerShell (pwsh)");
    expect(shellLabel(zsh)).toBe("zsh");
  });
});

describe("formatResult", () => {
  it("成功：一行头 + stdout，没有改口句", () => {
    const text = formatResult(result({ stdout: "hi\n" }), { logPath: null });
    expect(text.split("\n")[0]).toBe("exit 0 · 1.2s · zsh");
    expect(text).toContain("--- stdout ---\nhi");
    expect(text).not.toContain("--- stderr ---");
    expect(text).not.toContain("rewrite it");
  });
  it("失败：stderr 分开，且点名 shell 与语法", () => {
    const text = formatResult(result({ exitCode: 128, stderr: "fatal: x\n", shell: pwsh }), { logPath: null });
    expect(text.startsWith("exit 128 · 1.2s · PowerShell 7.4 (pwsh)")).toBe(true);
    expect(text).toContain("(no stdout)");
    expect(text).toContain("--- stderr ---\nfatal: x");
    expect(text).toContain("The shell was PowerShell 7.4 (pwsh) (PowerShell syntax)");
  });
  it("超时与中止各自成句，且不带改口句", () => {
    expect(formatResult(result({ timedOut: true, exitCode: null, durationMs: 60_000 }), { logPath: null }))
      .toMatch(/^TIMED OUT after 60s — the process was killed · 60s · zsh/);
    const killed = formatResult(result({ killed: true, exitCode: null }), { logPath: null });
    expect(killed.startsWith("stopped by the author")).toBe(true);
    expect(killed).not.toContain("rewrite it");
  });
  it("被截时指向日志；Rust 侧封顶另有一句", () => {
    const long = "x".repeat(CLIP_HEAD + CLIP_TAIL + 5);
    const text = formatResult(result({ stdout: long, stdoutTruncated: true }), { logPath: "/p/.ai-writer/tmp/cmd/a.log" });
    expect(text).toContain("full log is at /p/.ai-writer/tmp/cmd/a.log");
    expect(text).toContain("more than 1 MB");
    expect(formatResult(result({ stdout: long }), { logPath: null })).toContain("Output was cut here.");
  });
});
