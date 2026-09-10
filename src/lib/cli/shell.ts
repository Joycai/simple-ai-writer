/**
 * Which shell this machine runs commands with — the frontend's view of
 * `cmd_shell_info` (src-tauri/src/cmd.rs), plus the words for it.
 *
 * Cached after the first answer: the Rust side resolves it once per process
 * anyway, and two readers need it *synchronously* — the tool description is
 * built inside `getToolDefinitions`, which cannot await, and the settings row
 * renders before any effect runs. So `shellInfo()` fetches, `cachedShellInfo()`
 * reads, and whoever renders first triggers the fetch for everyone after.
 */

import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "../platform";

export type ShellKind = "pwsh" | "powershell" | "zsh" | "bash" | "sh" | "fish" | "dash" | "ksh";

export interface ShellInfo {
  kind: ShellKind;
  /** What the Rust side hands to `Command::new`. */
  path: string;
  /** PowerShell's `$PSVersionTable.PSVersion`; null on unix. */
  version: string | null;
}

let cached: ShellInfo | null = null;
let inflight: Promise<ShellInfo | null> | null = null;

/**
 * The machine's shell, or null outside Tauri (the browser dev server has no
 * shell and, by routing, no tool) and on a failed probe.
 */
export async function shellInfo(): Promise<ShellInfo | null> {
  if (cached) return cached;
  if (!IS_TAURI) return null;
  if (!inflight) {
    inflight = invoke<ShellInfo>("cmd_shell_info")
      .then((info) => {
        cached = info;
        return info;
      })
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** What {@link shellInfo} last answered, without asking. */
export function cachedShellInfo(): ShellInfo | null {
  return cached;
}

/** Test seam. */
export function resetShellInfoForTests(): void {
  cached = null;
  inflight = null;
}

/** Whether commands for this shell are written in PowerShell or POSIX syntax. */
export function shellSyntax(info: ShellInfo): "powershell" | "posix" {
  return info.kind === "pwsh" || info.kind === "powershell" ? "powershell" : "posix";
}

/**
 * The shell's name as the author reads it: "PowerShell 7.4 (pwsh)",
 * "Windows PowerShell 5.1", "zsh". Two version digits — the patch level is
 * noise on a settings row, and the major is what decides UTF-8 by default.
 */
export function shellLabel(info: ShellInfo): string {
  const short = info.version?.split(".").slice(0, 2).join(".") ?? null;
  switch (info.kind) {
    case "pwsh":
      return short ? `PowerShell ${short} (pwsh)` : "PowerShell (pwsh)";
    case "powershell":
      return short ? `Windows PowerShell ${short}` : "Windows PowerShell";
    default:
      return info.kind;
  }
}
