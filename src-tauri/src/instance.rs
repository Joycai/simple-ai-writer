//! Multi-instance coordination.
//!
//! The app deliberately has **no** single-instance plugin: running several
//! processes, each on its own workspace (VS Code-style), is supported. What
//! that support actually requires from the Rust side is small and lives here:
//!
//!   - an **advisory per-workspace lock** (`.ai-writer/window.lock`), so two
//!     windows opening the *same* folder — the one genuinely dangerous case,
//!     two editors autosaving over each other — resolve the VS Code way: the
//!     window that already has the folder is brought forward (see the focus
//!     channel below) and the second open backs out; only when the holder
//!     cannot be reached does it degrade to an "open anyway?" dialog.
//!     Advisory on purpose: the lock never blocks, the author can always
//!     answer "open anyway" on that fallback, and any failure to read or
//!     write it degrades to no warning rather than no project;
//!   - the **command-line workspace argument** (`simple-ai-writer <folder>`),
//!     which is how a second instance starts on a different workspace without
//!     clicking through the picker;
//!   - **spawning a sibling instance** (`spawn_new_instance`), the "new
//!     window" button — a new *process*, because every store in the frontend
//!     (and `lib/profile/active`) is a module singleton sized to one project.
//!
//! Cross-process preference tolerance is the frontend's half — see
//! `src/lib/prefs.ts` (`refreshPrefs` / `writePrefMerged`).
//!
//! ## The lock's shape
//!
//! One JSON object, `{pid, since, port}`. Liveness is judged by asking the OS
//! about the PID rather than by heartbeat timestamps: a heartbeat needs a
//! timer in every healthy instance forever, while a PID probe costs one
//! syscall at the moment of opening. The probe's false-positive (a recycled
//! PID after a crash) produces one spurious, overridable warning — and
//! answering "open anyway" rewrites the lock, which is also how stale files
//! self-heal. A lock on a network drive shared between machines can name a
//! foreign PID; that collapses to the same overridable warning, so it is
//! accepted rather than encoding a machine identity nobody can verify.
//!
//! ## The focus channel
//!
//! `port` is a loopback TCP listener each instance opens at startup
//! (`spawn_focus_listener`): a **connection is the whole message** — accept,
//! bring the main window forward, drop. No protocol, no payload, and nothing
//! read, because the only capability granted is "focus yourself", which any
//! local process already has through ordinary OS APIs; a stray port scan at
//! worst raises the window. This is what lets a second open of an
//! already-open folder behave like VS Code — the existing window comes to the
//! front and the second open quietly backs out — instead of interrogating the
//! author. An old-format lock without a port, a dead listener, or a foreign
//! machine's lock all fall through to the dialog.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{command, Manager};

use crate::scope::FsScope;

const LOCK_FILE: &str = "window.lock";

/// What `window.lock` stores.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockInfo {
    pub pid: u32,
    /// Unix seconds when the lock was taken — shown to the author, never
    /// used for staleness (PID liveness is; see the module doc).
    pub since: u64,
    /// The holder's focus-channel port (see the module doc). `default` so a
    /// lock written by a build before the channel existed still parses.
    #[serde(default)]
    pub port: Option<u16>,
}

/// The answer `project_lock_acquire` gives the frontend.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum LockStatus {
    Acquired,
    Held { pid: u32, since: u64 },
}

/// Workspace roots this process has locked, so exit can release them all.
/// Managed state; `project_lock_acquire`/`release` keep it current.
#[derive(Default)]
pub struct HeldLocks(Mutex<HashSet<PathBuf>>);

/// This instance's focus-channel port, written into every lock it takes.
/// `None` when the listener could not bind — the handoff then degrades to
/// the dialog in *other* instances, and this one loses nothing.
pub struct FocusPort(pub Option<u16>);

/// Open the loopback listener whose incoming connections mean "bring your
/// window forward". Factored so the accept loop is testable with a plain
/// closure; `start_focus_server` below binds it to the real window.
pub fn spawn_focus_listener(on_focus: impl Fn() + Send + 'static) -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    std::thread::spawn(move || {
        // The connection is the message (see the module doc): nothing is read
        // and the stream is dropped immediately. Errors on individual accepts
        // are skipped — one bad handshake must not end the channel.
        for stream in listener.incoming() {
            if stream.is_ok() {
                on_focus();
            }
        }
    });
    Ok(port)
}

/// The production wiring: focus requests raise the main window. Unminimize
/// first — `set_focus` alone does not restore a minimized window everywhere.
pub fn start_focus_server(app: &tauri::AppHandle) -> Option<u16> {
    let handle = app.clone();
    match spawn_focus_listener(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }) {
        Ok(port) => Some(port),
        Err(e) => {
            eprintln!("[instance] focus channel unavailable: {e}");
            None
        }
    }
}

/// The folder handed on the command line, if any — consumed exactly once by
/// `launch_project_path` (React's StrictMode double-runs effects in dev, and
/// the second read must not open the project twice).
pub struct LaunchProject(Mutex<Option<PathBuf>>);

impl LaunchProject {
    /// Parse `argv[1]` as a workspace to open. Only a directory that already
    /// carries the `.ai-writer` marker qualifies — the same trust rule as
    /// `project_register_root`, so the argument cannot become a way to point
    /// the app (and its fs scope) at an arbitrary directory.
    pub fn from_args() -> Self {
        let path = std::env::args_os()
            .nth(1)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() && p.join(".ai-writer").is_dir());
        Self(Mutex::new(path))
    }
}

fn lock_path(root: &Path) -> PathBuf {
    root.join(".ai-writer").join(LOCK_FILE)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read a lock file; unreadable or unparsable means "no lock" — a garbage
/// file must degrade to a missing warning, never to an unopenable project.
fn read_lock(root: &Path) -> Option<LockInfo> {
    let bytes = std::fs::read(lock_path(root)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// What an existing lock means to this process. Pure — the PID probe comes in
/// as a function so the decision table is testable without real processes.
#[derive(Debug, PartialEq, Eq)]
enum Claim {
    /// No lock, our own, or a dead holder's — take it.
    Free,
    /// A live *other* process holds it.
    Held(LockInfo),
}

fn judge(existing: Option<LockInfo>, self_pid: u32, pid_alive: impl Fn(u32) -> bool) -> Claim {
    match existing {
        Some(info) if info.pid != self_pid && pid_alive(info.pid) => Claim::Held(info),
        _ => Claim::Free,
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // Signal 0: no signal delivered, just the existence check. Success means
    // alive. EPERM would also mean alive-but-not-ours, but the lock holder is
    // the same user's editor in practice, and misreading EPERM as dead only
    // skips a warning — it never blocks anything.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    unsafe { CloseHandle(handle) };
    true
}

/// The command bodies, on plain paths — commands add scope + bookkeeping.
/// `force` is the author's "open anyway": overwrite whatever is there.
fn acquire_at(
    root: &Path,
    self_pid: u32,
    force: bool,
    port: Option<u16>,
) -> Result<LockStatus, String> {
    if !force {
        if let Claim::Held(info) = judge(read_lock(root), self_pid, pid_alive) {
            return Ok(LockStatus::Held {
                pid: info.pid,
                since: info.since,
            });
        }
    }
    // A freshly dialog-picked folder has no `.ai-writer` yet (the scaffold
    // runs later in the open flow); the lock must not depend on that ordering.
    let dir = root.join(".ai-writer");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let info = LockInfo {
        pid: self_pid,
        since: now_secs(),
        port,
    };
    std::fs::write(lock_path(root), serde_json::to_vec(&info).unwrap())
        .map_err(|e| e.to_string())?;
    Ok(LockStatus::Acquired)
}

/// Remove the lock only if it is ours: releasing must never delete another
/// live instance's claim (e.g. after this window lost the "open anyway" race).
fn release_at(root: &Path, self_pid: u32) {
    if matches!(read_lock(root), Some(info) if info.pid == self_pid) {
        let _ = std::fs::remove_file(lock_path(root));
    }
}

/// Try to claim the workspace at `path` for this window.
///
/// Scope-checked like every path off the webview — the open flow registers
/// the root (dialog or `project_register_root`) before calling this, so a
/// path that fails here is one the author never picked.
#[command]
pub fn project_lock_acquire(
    path: String,
    force: bool,
    scope: tauri::State<'_, FsScope>,
    held: tauri::State<'_, HeldLocks>,
    focus: tauri::State<'_, FocusPort>,
) -> Result<LockStatus, String> {
    scope.check(&path)?;
    let root = PathBuf::from(&path);
    let status = acquire_at(&root, std::process::id(), force, focus.0)?;
    if matches!(status, LockStatus::Acquired) {
        held.0.lock().unwrap().insert(root);
    }
    Ok(status)
}

/// Ask the instance holding `path` to bring its window forward — the VS Code
/// resolution for "this folder is already open". True only when a live other
/// holder was actually reached; every failure answers false so the frontend
/// falls back to its dialog rather than silently doing nothing.
#[command]
pub fn project_focus_existing(
    path: String,
    scope: tauri::State<'_, FsScope>,
) -> Result<bool, String> {
    scope.check(&path)?;
    let root = PathBuf::from(&path);
    let Some(info) = read_lock(&root) else {
        return Ok(false);
    };
    if info.pid == std::process::id() || !pid_alive(info.pid) {
        return Ok(false);
    }
    let Some(port) = info.port else {
        return Ok(false);
    };
    // Connecting is the whole request (see the module doc). Bounded, because
    // this sits on the open-project path: a wedged holder must cost half a
    // second and a dialog, not a hang.
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    Ok(std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500)).is_ok())
}

/// Release this window's claim on `path` (project switch or close).
#[command]
pub fn project_lock_release(
    path: String,
    scope: tauri::State<'_, FsScope>,
    held: tauri::State<'_, HeldLocks>,
) -> Result<(), String> {
    scope.check(&path)?;
    let root = PathBuf::from(&path);
    release_at(&root, std::process::id());
    held.0.lock().unwrap().remove(&root);
    Ok(())
}

/// Exit-time sweep, called from the `RunEvent::Exit` handler in `lib.rs` —
/// the one release the frontend cannot be trusted to reach (killed process,
/// `window.destroy()`). A crash skips even this; the PID check makes that
/// lock stale rather than sticky.
pub fn release_all_locks(app: &tauri::AppHandle) {
    let held = app.state::<HeldLocks>();
    let roots: Vec<PathBuf> = held.0.lock().unwrap().drain().collect();
    for root in roots {
        release_at(&root, std::process::id());
    }
}

/// The workspace handed on the command line, once. The frontend feeds it to
/// its normal `openProject(path)` flow, whose `project_register_root` re-does
/// the `.ai-writer` validation — this command grants nothing by itself.
#[command]
pub fn launch_project_path(state: tauri::State<'_, LaunchProject>) -> Option<String> {
    state
        .0
        .lock()
        .unwrap()
        .take()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Launch a sibling instance of this executable — the "new window" button.
/// With a path, the new process starts on that workspace (subject to its own
/// validation); without one it starts on the picker. Marker-checked like the
/// argument parser, so the webview cannot use this to aim a new instance at a
/// directory that isn't a project.
#[command]
pub fn spawn_new_instance(project_path: Option<String>) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(exe);
    if let Some(path) = project_path {
        let root = PathBuf::from(&path);
        if !root.is_absolute() || !root.join(".ai-writer").is_dir() {
            return Err("Not an existing project folder (missing .ai-writer)".into());
        }
        cmd.arg(root);
    }
    // Spawn-and-forget: the child owns its own lifetime (closing this window
    // must not close the sibling), so the handle is deliberately dropped.
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(pid: u32) -> LockInfo {
        LockInfo {
            pid,
            since: 1,
            port: None,
        }
    }

    // ── The decision table (pure) ────────────────────────────────────────────

    #[test]
    fn no_lock_is_free() {
        assert_eq!(judge(None, 100, |_| true), Claim::Free);
    }

    #[test]
    fn own_lock_is_free_even_while_alive() {
        // Re-opening the same project in the same window must not warn.
        assert_eq!(judge(Some(info(100)), 100, |_| true), Claim::Free);
    }

    #[test]
    fn other_live_holder_is_held() {
        assert_eq!(
            judge(Some(info(200)), 100, |_| true),
            Claim::Held(info(200))
        );
    }

    #[test]
    fn dead_holder_is_free() {
        // The crash-recovery path: a lock left by a killed instance must not
        // cost the author anything.
        assert_eq!(judge(Some(info(200)), 100, |_| false), Claim::Free);
    }

    // ── The file (real fs, scratch dirs) ─────────────────────────────────────

    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("saw-instance-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn acquire_creates_the_dot_dir_and_writes_our_pid() {
        // No `.ai-writer` yet — the freshly-picked-folder case.
        let root = scratch("fresh");
        assert!(matches!(
            acquire_at(&root, std::process::id(), false, None).unwrap(),
            LockStatus::Acquired
        ));
        assert_eq!(read_lock(&root).unwrap().pid, std::process::id());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn garbage_lock_file_reads_as_no_lock() {
        let root = scratch("garbage");
        std::fs::create_dir_all(root.join(".ai-writer")).unwrap();
        std::fs::write(lock_path(&root), b"{not json").unwrap();
        assert_eq!(read_lock(&root), None);
        // …and acquiring over it succeeds rather than erroring.
        assert!(matches!(
            acquire_at(&root, std::process::id(), false, None).unwrap(),
            LockStatus::Acquired
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn force_overwrites_a_live_holder() {
        let root = scratch("force");
        std::fs::create_dir_all(root.join(".ai-writer")).unwrap();
        // Our own PID under a *different* identity plays "another live
        // process" — the one PID guaranteed alive for the probe.
        let other = LockInfo {
            pid: std::process::id(),
            since: 7,
            port: None,
        };
        std::fs::write(lock_path(&root), serde_json::to_vec(&other).unwrap()).unwrap();

        let me = std::process::id() + 1; // pretend to be someone else
        match acquire_at(&root, me, false, None).unwrap() {
            LockStatus::Held { pid, since } => {
                assert_eq!(pid, std::process::id());
                assert_eq!(since, 7);
            }
            LockStatus::Acquired => panic!("a live holder must be reported, not clobbered"),
        }
        assert!(matches!(
            acquire_at(&root, me, true, None).unwrap(),
            LockStatus::Acquired
        ));
        assert_eq!(read_lock(&root).unwrap().pid, me);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn release_removes_only_our_own_lock() {
        let root = scratch("release");
        std::fs::create_dir_all(root.join(".ai-writer")).unwrap();

        // Someone else's lock survives our release…
        std::fs::write(lock_path(&root), serde_json::to_vec(&info(424242)).unwrap()).unwrap();
        release_at(&root, std::process::id());
        assert!(lock_path(&root).exists());

        // …our own does not.
        acquire_at(&root, std::process::id(), true, None).unwrap();
        release_at(&root, std::process::id());
        assert!(!lock_path(&root).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn our_own_pid_is_alive() {
        assert!(pid_alive(std::process::id()));
    }

    // ── The focus channel ────────────────────────────────────────────────────

    #[test]
    fn a_pre_port_lock_still_parses() {
        // Written by a build before the focus channel existed; it must read
        // as a lock (dialog fallback), not as garbage (silent takeover).
        let parsed: LockInfo = serde_json::from_str(r#"{"pid":42,"since":7}"#).unwrap();
        assert_eq!(
            parsed,
            LockInfo {
                pid: 42,
                since: 7,
                port: None
            }
        );
    }

    #[test]
    fn a_connection_to_the_focus_listener_is_a_focus_request() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let port = spawn_focus_listener(move || {
            let _ = tx.send(());
        })
        .unwrap();

        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        // Nothing written, nothing read — connecting is the whole request.
        let _stream =
            std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(2)).unwrap();
        rx.recv_timeout(std::time::Duration::from_secs(2))
            .expect("the accept loop should have fired the focus callback");
    }

    #[test]
    fn acquire_records_the_focus_port_in_the_lock() {
        let root = scratch("port");
        acquire_at(&root, std::process::id(), false, Some(45678)).unwrap();
        assert_eq!(read_lock(&root).unwrap().port, Some(45678));
        let _ = std::fs::remove_dir_all(&root);
    }
}
