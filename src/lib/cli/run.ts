/**
 * Run one command and bring back what the model reads — the orchestration
 * over `cmd_run` / `cmd_kill` (src-tauri/src/cmd.rs). Called from the
 * approval's apply step (agentStore.settleApproval, PR 2), never from the
 * tool handler directly: nothing here may run before the author approved.
 *
 * Owns three things the Rust side does not:
 *   - the run id and the abort wiring — the author's 停止 becomes `cmd_kill`
 *     with that id, and the Rust wait loop does the killing so the result
 *     itself says `killed`;
 *   - the log — when the model's copy is cut (`clipForModel`), the whole
 *     output lands in `.ai-writer/tmp/cmd/` for read_file to page. Only then:
 *     a short result needs no second copy on disk, and `tmp/` is excluded from
 *     backups and sync already (transfer.rs);
 *   - the tick — a once-a-second callback for the tool row's progress label,
 *     because a 40-second command with no movement reads as a hang.
 */

import { invoke } from "@tauri-apps/api/core";
import { makeDir, readDir, removeFile, writeFile } from "../fs/fileio";
import { joinPath } from "../paths";
import { CLIP_HEAD, CLIP_TAIL, formatResult, type CmdResult } from "./output";

export const CMD_LOG_DIR = ".ai-writer/tmp/cmd";
/** Logs kept in that folder; older ones are removed after each write. */
export const CMD_LOGS_KEPT = 50;

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

/** The timeout as sent — the Rust side clamps to the same bounds. */
export function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(ms)));
}

export interface RunCommandRequest {
  projectPath: string;
  command: string;
  /** Absolute working directory, already checked to be inside the project. */
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Once a second while the command runs, with the elapsed time. */
  onTick?: (elapsedMs: number) => void;
}

export interface RunCommandOutcome {
  result: CmdResult;
  /** Where the full output went, when the model's copy was cut. */
  logPath: string | null;
  /** The tool result text. */
  report: string;
}

/** Does the model's copy of either stream lose characters? */
export function needsLog(res: CmdResult): boolean {
  const cap = CLIP_HEAD + CLIP_TAIL;
  return res.stdout.length > cap || res.stderr.length > cap || res.stdoutTruncated || res.stderrTruncated;
}

function newRunId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

/** `20260910-143021` — sorts by time as a file name. */
function stamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export async function runCommand(req: RunCommandRequest): Promise<RunCommandOutcome> {
  if (req.signal?.aborted) throw new Error("Stopped by the author before the command started");
  const runId = newRunId();
  const started = Date.now();
  const onAbort = () => {
    void invoke("cmd_kill", { runId }).catch(() => {});
  };
  req.signal?.addEventListener("abort", onAbort, { once: true });
  const ticker = req.onTick
    ? setInterval(() => req.onTick?.(Date.now() - started), 1000)
    : null;
  let result: CmdResult;
  try {
    result = await invoke<CmdResult>("cmd_run", {
      req: { runId, command: req.command, cwd: req.cwd, timeoutMs: clampTimeout(req.timeoutMs) },
    });
  } finally {
    if (ticker) clearInterval(ticker);
    req.signal?.removeEventListener("abort", onAbort);
  }
  const logPath = needsLog(result) ? await writeLog(req.projectPath, runId, req.command, result) : null;
  return { result, logPath, report: formatResult(result, { logPath }) };
}

/** The whole output to disk, then trim the folder. Best-effort: a log that
 *  failed to write leaves the result without a pointer, not the run broken. */
async function writeLog(projectPath: string, runId: string, command: string, res: CmdResult): Promise<string | null> {
  const dir = joinPath(projectPath, CMD_LOG_DIR);
  const path = joinPath(dir, `${stamp()}-${runId}.log`);
  try {
    await makeDir(dir);
    await writeFile(
      path,
      [`$ ${command}`, `exit ${res.exitCode ?? "none"} · ${res.durationMs}ms`, "", "--- stdout ---", res.stdout, "--- stderr ---", res.stderr].join("\n"),
    );
    await sweepLogs(dir);
    return path;
  } catch {
    return null;
  }
}

/** Keep the newest {@link CMD_LOGS_KEPT}; names sort by their time stamp. */
export async function sweepLogs(dir: string): Promise<void> {
  try {
    const entries = (await readDir(dir))
      .filter((e) => !e.isDirectory && e.name.endsWith(".log"))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const stale = entries.slice(0, Math.max(0, entries.length - CMD_LOGS_KEPT));
    await Promise.all(stale.map((e) => removeFile(e.path).catch(() => {})));
  } catch {
    // A folder that cannot be listed is not this run's problem.
  }
}
