/**
 * What the model reads back after a command ran. Pure: takes the Rust
 * result, returns text.
 *
 * Two ceilings, at two places, for two reasons
 * (docs/feature/agent/shell-command-plan.md §1 不变量 8):
 *   - the Rust side keeps at most 1 MB per stream, so a run that prints
 *     without end cannot take the webview with it (`stdoutTruncated`);
 *   - this side hands the model a *head and a tail* of what was kept, because
 *     one `git log` can eat a round's context. The rest is not lost: the
 *     runner writes the whole thing to a log the model pages with read_file.
 */

import { shellLabel, shellSyntax, type ShellInfo } from "./shell";

/** The Rust `CmdResult`, camelCased by serde. */
export interface CmdResult {
  pid: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  killed: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  shell: ShellInfo;
}

/** Characters of a stream the model sees before the cut, and after it. */
export const CLIP_HEAD = 6000;
export const CLIP_TAIL = 2000;

export interface Clipped {
  text: string;
  /** Characters removed from the middle; 0 means nothing was cut. */
  omitted: number;
}

/**
 * Head + tail of a long text, with the cut marked in the model's language.
 * A text within `head + tail` is returned whole — the marker would cost more
 * than it saves, and the tail would repeat the head's end.
 */
export function clipForModel(text: string, head = CLIP_HEAD, tail = CLIP_TAIL): Clipped {
  if (text.length <= head + tail) return { text, omitted: 0 };
  const omitted = text.length - head - tail;
  const marker = `\n…[${omitted} characters omitted]…\n`;
  return { text: text.slice(0, head) + marker + text.slice(text.length - tail), omitted };
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/**
 * The tool result. Everything the model needs to decide its next step comes
 * first, on one line: exit code, time, which shell — the shell because a
 * failed line on the wrong syntax should be *rewritten*, not retried, and
 * that sentence is added only when the run failed (schema costs every round;
 * a result line costs once, when it applies).
 */
export function formatResult(res: CmdResult, opts: { logPath: string | null }): string {
  const label = shellLabel(res.shell);
  const head: string[] = [];
  if (res.killed) head.push("stopped by the author");
  else if (res.timedOut) head.push(`TIMED OUT after ${seconds(res.durationMs)} — the process was killed`);
  else head.push(`exit ${res.exitCode ?? "none (signal)"}`);
  head.push(seconds(res.durationMs), label);

  const out = clipForModel(res.stdout);
  const err = clipForModel(res.stderr);
  const lines: string[] = [head.join(" · ")];
  if (res.stdout.length > 0) lines.push("--- stdout ---", out.text.replace(/\n$/, ""));
  else lines.push("(no stdout)");
  if (res.stderr.length > 0) lines.push("--- stderr ---", err.text.replace(/\n$/, ""));

  const notes: string[] = [];
  if (res.stdoutTruncated || res.stderrTruncated) {
    notes.push("The process printed more than 1 MB on one stream; only the first 1 MB of it was kept.");
  }
  if (out.omitted > 0 || err.omitted > 0) {
    notes.push(
      opts.logPath
        ? `Output was cut here; the full log is at ${opts.logPath} — read it with read_file if the cut part matters.`
        : "Output was cut here.",
    );
  }
  if (!res.killed && !res.timedOut && res.exitCode !== 0) {
    const syntax = shellSyntax(res.shell) === "powershell" ? "PowerShell" : "POSIX shell";
    notes.push(
      `The shell was ${label} (${syntax} syntax). If the line was written for a different shell, rewrite it rather than retrying it.`,
    );
  }
  if (notes.length) lines.push("", ...notes);
  return lines.join("\n");
}
