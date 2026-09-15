/**
 * `run_command` —— 助手在这台电脑上跑一条命令的**唯一**接口
 * （docs/feature/agent/shell-command-plan.md §3.3）。
 *
 * 可证明只读的命令直接由这里调用 runner；其余形态照 `transcribe_audio`
 *（lib/asr/tool.ts）：卡在**动作之前**——提案时什么都没跑，作者在卡上看到的是
 * 命令原文；批准后由 `agentStore.settleApproval` 的 `case "command"` 调
 * `lib/cli/run`，结果文本原样回给模型。
 *
 * 这里判的只有三件事，都在建卡之前：`cwd` 在项目内（不变量 9 的 TS 那一半——
 * 围栏挡的是参数，命令本身能 `cd ..`，那是卡的事）、超时夹在范围内、这台机器
 * 有 shell 可用。`commandAccess` 决定要不要建卡；建卡时 `command.ts` 的两个判断
 *（复合 / 危险形状）**算好挂在提案上**，卡只读不算：卡和连批命中判定要看同一份答案。
 */

import { fileExists } from "../fs/fileio";
import { projectRelative, resolveWorkspacePath } from "../paths";
import { IS_WINDOWS } from "../platform";
import i18n from "../../i18n";
import type { CommandProposal, ToolContext } from "./registry";
import type { ToolResult } from "./tools";
import { commandAccess, isCompound, looksDangerous } from "../cli/command";
import { clampTimeout, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "../cli/run";
import { cachedShellInfo, shellInfo, shellLabel, shellSyntax } from "../cli/shell";

let proposalCounter = 0;

interface RunCommandArgs {
  command?: string;
  /** Project-relative working directory; absent = the project root. */
  cwd?: string;
  timeout_seconds?: number;
  reason?: string;
}

/**
 * The tool's description, built when the definitions are handed to the model
 * rather than at import: it names the shell this computer actually runs, so a
 * model on Windows writes `Get-ChildItem` and not `ls -la | grep` (不变量 11).
 * Before the probe has answered (or outside Tauri) it falls back to the
 * platform's likely shell — a guess, but the right guess far more often than
 * a description that names none.
 */
export function describeRunCommand(): string {
  const info = cachedShellInfo();
  const shell = info ? shellLabel(info) : IS_WINDOWS ? "PowerShell" : "the login shell (zsh / bash)";
  const syntax = (info ? shellSyntax(info) === "powershell" : IS_WINDOWS) ? "PowerShell" : "POSIX";
  return (
    `Run ONE shell command on the author's computer — in ${shell}, so write ${syntax} syntax. ` +
    "Known read-only commands (for example ls/cat/grep/rg or PowerShell Get-ChildItem/Get-Content/Select-String) run without approval. Every other command is shown verbatim on a card FIRST; the author can approve it once or grant a small counted batch. Commands run with their account's full permissions, stdin closed, in the project folder (or `cwd`), and return the exit code, stdout and stderr (long output is cut, with the full log's path for read_file). " +
    "Use it for what no other tool does: git, converters and scripts the author has installed, counting and listing beyond list_files / search_text. " +
    "Prefer built-in read/edit tools for project text. One thing per call; do not chain unrelated commands."
  );
}

/** The common runner path for approval-free reads. Approved writes take the
 * same route from agentStore so there remains one process/log implementation. */
async function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  ctx: ToolContext,
): Promise<string> {
  const { runCommand } = await import("../cli/run");
  const outcome = await runCommand({
    projectPath: ctx.projectPath,
    command,
    cwd,
    timeoutMs,
    signal: ctx.signal,
    onTick: (ms) =>
      ctx.onProgress?.({
        label: i18n.t("ai.approval.commandRunning", {
          s: Math.round(ms / 1000),
          defaultValue: "运行中 · {{s}} 秒",
        }),
      }),
  });
  return outcome.report;
}

export async function runCommandTool(
  toolCallId: string,
  args: RunCommandArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.requestApproval) {
    return {
      toolCallId,
      content: "Error: this surface cannot review a command — do not call this tool here.",
    };
  }
  const command = args.command?.trim();
  if (!command) {
    return { toolCallId, content: "Error: 'command' is required — the line to run." };
  }

  // The working directory: the project root unless the model named a folder
  // inside it. `resolveWorkspacePath` keeps `.ai-writer/` out and refuses
  // `..` climbs — a command that must run elsewhere can `cd` there itself,
  // and the card will show that it does.
  const rawCwd = args.cwd?.trim().replace(/^\.\/?$/, "") ?? "";
  const cwd = rawCwd ? resolveWorkspacePath(ctx.projectPath, rawCwd) : ctx.projectPath;
  if (!cwd) {
    return {
      toolCallId,
      content: "Error: 'cwd' must be a folder inside the project (the app's .ai-writer data is off-limits). Omit it to run in the project root.",
    };
  }
  if (rawCwd && !(await fileExists(cwd))) {
    return { toolCallId, content: `Error: there is no folder at ${cwd}. Check the path with list_files.` };
  }

  const shell = cachedShellInfo() ?? (await shellInfo());
  if (!shell) {
    return { toolCallId, content: "Error: no shell is available in this environment, so commands cannot run here." };
  }

  const seconds = typeof args.timeout_seconds === "number" ? args.timeout_seconds : DEFAULT_TIMEOUT_MS / 1000;
  const timeoutMs = clampTimeout(Math.min(seconds * 1000, MAX_TIMEOUT_MS));

  // The closed allowlist is the approval boundary. Unknown, composed or
  // argument-sensitive commands fall through to the proposal below.
  if (commandAccess(command, shellSyntax(shell)) === "read") {
    return { toolCallId, content: await executeCommand(command, cwd, timeoutMs, ctx) };
  }

  const proposal: CommandProposal = {
    kind: "command",
    id: `command-${++proposalCounter}`,
    path: cwd,
    command,
    cwdLabel: projectRelative(ctx.projectPath, cwd) || ".",
    timeoutMs,
    shell,
    compound: isCompound(command),
    danger: looksDangerous(command),
    reason: args.reason?.trim() || undefined,
  };

  const decision = await ctx.requestApproval(proposal, ctx.onProgress);
  if (!decision.approved) {
    return {
      toolCallId,
      content: `The author REJECTED this command${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not run it or a variant of it; if the task cannot proceed without it, say so and ask what they would prefer.`,
    };
  }
  // `backupPath` carries the apply step's report — the exit code, output and
  // shell line from lib/cli/output — the way every other kind's does.
  return { toolCallId, content: decision.backupPath ?? "The command ran, but its output was not captured." };
}
