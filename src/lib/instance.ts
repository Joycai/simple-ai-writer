/**
 * Multi-instance coordination — the frontend half of `src-tauri/src/instance.rs`.
 *
 * The app supports running several processes at once, each on its own
 * workspace. This module wraps the three pieces the Rust side provides: the
 * advisory per-workspace lock (`.ai-writer/window.lock` — a warning against
 * opening the *same* folder twice, never a block), the workspace argv[1] a
 * second instance was launched with, and spawning a sibling instance (the
 * "new window" buttons). The other half of multi-instance tolerance — the
 * shared `config.db` preference cache — lives in `lib/prefs`
 * (`refreshPrefs` / `writePrefMerged`).
 *
 * Every function here degrades to a no-op outside Tauri (vitest, browser
 * dev), and the lock calls additionally swallow their own failures: the lock
 * exists to *warn*, and a workspace on a read-only or odd filesystem must
 * still open — just without the warning.
 */
import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./platform";
import { toPosixPath } from "./paths";

export type LockStatus =
  | { status: "acquired" }
  | { status: "held"; pid: number; since: number };

/**
 * Try to claim `path` for this window. `"held"` means a live *other* process
 * has it — the caller decides whether to ask the author and retry with
 * `force`. Failures count as acquired: no warning beats no project.
 */
export async function acquireProjectLock(path: string, force = false): Promise<LockStatus> {
  if (!IS_TAURI) return { status: "acquired" };
  try {
    return await invoke<LockStatus>("project_lock_acquire", { path, force });
  } catch (e) {
    console.warn("[instance] could not take the workspace lock:", e);
    return { status: "acquired" };
  }
}

/**
 * Ask the instance already holding `path` to bring its window forward — the
 * VS Code resolution for opening a folder that is open elsewhere. True only
 * when a live holder was actually reached; false (including on any error)
 * sends the caller to its dialog fallback.
 */
export async function focusExistingInstance(path: string): Promise<boolean> {
  if (!IS_TAURI) return false;
  try {
    return await invoke<boolean>("project_focus_existing", { path });
  } catch (e) {
    console.warn("[instance] could not reach the holding window:", e);
    return false;
  }
}

/** Release this window's claim (project switch/close). Best-effort — a lock
 *  that outlives us is exactly what the PID staleness check is for. */
export async function releaseProjectLock(path: string): Promise<void> {
  if (!IS_TAURI) return;
  try {
    await invoke("project_lock_release", { path });
  } catch (e) {
    console.warn("[instance] could not release the workspace lock:", e);
  }
}

/**
 * The workspace this instance was launched with (`simple-ai-writer <folder>`),
 * consumed exactly once — the Rust side `take()`s it, so StrictMode's doubled
 * effect run gets `null` the second time. Normalised here because the value
 * becomes `projectPath` verbatim: one of the doors a host-spelled path enters
 * through (see `docs/feature/path-spelling-plan.md`).
 */
export async function launchProjectPath(): Promise<string | null> {
  if (!IS_TAURI) return null;
  try {
    const path = await invoke<string | null>("launch_project_path");
    return path === null ? null : toPosixPath(path);
  } catch (e) {
    console.warn("[instance] could not read the launch argument:", e);
    return null;
  }
}

/**
 * Launch a sibling instance — with a path, straight onto that workspace; bare,
 * onto the picker/recents. A new *process* rather than a second window in this
 * one: the stores and `lib/profile/active` are module singletons sized to one
 * project. Errors surface to the caller — a button that silently does nothing
 * is worse than one that reports why.
 */
export async function openInNewWindow(projectPath?: string): Promise<void> {
  if (!IS_TAURI) return;
  await invoke("spawn_new_instance", { projectPath: projectPath ?? null });
}
