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

type ShellKind = "pwsh" | "powershell" | "zsh" | "bash" | "sh" | "fish" | "dash" | "ksh";

export interface ShellInfo {
  kind: ShellKind;
  /** What the Rust side hands to `Command::new`. */
  path: string;
  /** PowerShell's `$PSVersionTable.PSVersion`; null on unix. */
  version: string | null;
  /** Rust's `std::env::consts::OS`: `macos` / `windows` / `linux` / … */
  os: string;
  /** macOS `15.2`, Windows `10.0.26100.0`, Linux os-release `PRETTY_NAME`; null if unread. */
  osVersion: string | null;
  /** Rust's `std::env::consts::ARCH`: `aarch64` / `x86_64` / … */
  arch: string;
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

/**
 * The system the shell runs on, as the model and the author both read it:
 * "macOS 15.2 · arm64", "Windows 10.0.26100 · x86_64", "Ubuntu 24.04.1 LTS ·
 * x86_64". The shell alone doesn't say whether the userland is BSD or GNU, or
 * which of `open` / `xdg-open` / `brew` / `apt` exists — the OS does.
 */
export function systemLabel(info: ShellInfo): string {
  const v = info.osVersion?.trim() || null;
  let name: string;
  switch (info.os) {
    case "macos":
      name = v ? `macOS ${v}` : "macOS";
      break;
    case "windows":
      // `10.0.26100.0` — the revision is always 0 and only costs a token.
      name = v ? `Windows ${v.replace(/\.0$/, "")}` : "Windows";
      break;
    case "linux":
      // PRETTY_NAME usually names the distribution without saying "Linux".
      name = v ? (/linux/i.test(v) ? v : `${v} (Linux)`) : "Linux";
      break;
    default:
      name = v ? `${info.os} ${v}` : info.os;
  }
  const arch = info.arch === "aarch64" ? "arm64" : info.arch;
  return arch ? `${name} · ${arch}` : name;
}
