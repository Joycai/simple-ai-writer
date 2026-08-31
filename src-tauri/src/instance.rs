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
//!     window" button — a new *process*, because the `FsScope` guarding every
//!     `fs_*` command is process-wide managed state (see `scope.rs`), so two
//!     workspaces in one process would share one union of allowed roots;
//!   - **naming the window** (`set_window_title`) and the **live-instance
//!     registry** it feeds — who is running right now, which the per-project
//!     locks cannot answer. Its one reader today is the macOS 「Window」 menu
//!     (`windowmenu.rs`), the list AppKit cannot build here precisely because
//!     each window is a separate process.
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
pub(crate) fn pid_alive(pid: u32) -> bool {
    // Signal 0: no signal delivered, just the existence check. Success means
    // alive. EPERM would also mean alive-but-not-ours, but the lock holder is
    // the same user's editor in practice, and misreading EPERM as dead only
    // skips a warning — it never blocks anything.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
pub(crate) fn pid_alive(pid: u32) -> bool {
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

// ── The live-instance registry ──────────────────────────────────────────────
//
// Who is running right now, so a window can list its siblings. The workspace
// locks cannot answer that: they live inside each project (a window with no
// project has none), and they answer "who holds this folder", not "who is
// open". So each instance publishes one file under the app data dir, named by
// its pid.
//
// Only the macOS window menu reads this today (`windowmenu.rs`), but the
// writing half is cross-platform: `set_window_title` has to run everywhere for
// the taskbar and ⌘-Tab anyway, and a registry that is only true on one
// platform is a registry that will be wrong the day a second reader appears.

/// Directory under the app data dir holding one file per live instance.
const REGISTRY_DIR: &str = "instances";

/// What an instance publishes about itself. Display data plus the port to
/// reach it on; nothing another instance is trusted to act on beyond "raise
/// the window listening there".
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct InstanceInfo {
    pub pid: u32,
    /// The focus-channel port (see the module doc). `None` when this instance
    /// could not bind one — it is then listed but not switchable, which beats
    /// hiding a window the author can plainly see.
    pub port: Option<u16>,
    /// Unix seconds when this instance first announced itself. The list's sort
    /// key, so every instance renders it in the same order.
    pub since: u64,
    /// The label a sibling shows for this window — the project name, or the
    /// app's own name while no project is open.
    pub title: String,
    /// The workspace this window holds, if any. Display-only: the *claim* on a
    /// folder is the lock, never this.
    pub workspace: Option<String>,
}

/// This instance's `since`, fixed at its first announcement — re-announcing on
/// every project switch must not reshuffle the list under the author.
static SINCE: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

fn registry_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(REGISTRY_DIR))
}

fn entry_path(dir: &Path, pid: u32) -> PathBuf {
    dir.join(format!("{pid}.json"))
}

/// Publish (or update) this instance's entry, then rebuild our own window menu
/// so the window that just renamed itself is right immediately.
///
/// Best-effort throughout: a registry that cannot be written costs a menu
/// entry, never the caller — `set_window_title` still sets the title, which is
/// what the Dock, ⌘-Tab and Mission Control read.
pub fn announce_instance<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    title: &str,
    workspace: Option<&str>,
) {
    let Some(dir) = registry_dir(app) else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let info = InstanceInfo {
        pid: std::process::id(),
        port: app.try_state::<FocusPort>().and_then(|p| p.0),
        since: *SINCE.get_or_init(now_secs),
        title: title.to_owned(),
        workspace: workspace.map(str::to_owned),
    };
    let Ok(bytes) = serde_json::to_vec(&info) else {
        return;
    };
    let _ = std::fs::write(entry_path(&dir, info.pid), bytes);
    #[cfg(target_os = "macos")]
    crate::windowmenu::refresh(app);
}

/// Drop this instance's entry — the `RunEvent::Exit` sweep, beside the locks.
/// A crash skips it, which is what the liveness probe in `scan_instances` is
/// for.
pub fn retire_instance<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(dir) = registry_dir(app) {
        let _ = std::fs::remove_file(entry_path(&dir, std::process::id()));
    }
}

/// Every instance still running, oldest first. macOS-only because the window
/// menu is its only reader; `scan_instances` below carries the logic and is
/// tested everywhere.
#[cfg(target_os = "macos")]
pub fn live_instances<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<InstanceInfo> {
    match registry_dir(app) {
        Some(dir) => scan_instances(&dir, std::process::id(), pid_alive),
        None => Vec::new(),
    }
}

/// The registry read, with the pid probe injected so the decisions below are
/// testable without real processes.
///
/// Dead instances' files are deleted on sight — this is the only sweep there
/// is, since the owner of a file is by definition not around to remove it. A
/// file that will not parse is judged by the pid in its *name*: a live owner's
/// is left alone (it may be mid-write), a dead one's is deleted. That fallback
/// is not fussiness — the content that would name the owner is precisely what
/// is unreadable, so without it garbage could never leave the directory.
///
/// A recycled PID can keep an entry alive one moment too long. That is the
/// same false positive the workspace lock accepts, and with less at stake:
/// the click reaches a port that is gone (or someone else's, where a bare
/// connection means nothing), and the failure rebuilds the menu without it.
#[cfg(any(target_os = "macos", test))]
fn scan_instances(dir: &Path, self_pid: u32, alive: impl Fn(u32) -> bool) -> Vec<InstanceInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<InstanceInfo> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let parsed = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<InstanceInfo>(&b).ok());
        let named_pid = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u32>().ok());
        let pid = match (&parsed, named_pid) {
            (Some(info), _) => info.pid,
            (None, Some(pid)) => pid,
            // Unreadable *and* unnamed: nothing to judge it by, so leave it.
            (None, None) => continue,
        };
        if pid != self_pid && !alive(pid) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        if let Some(info) = parsed {
            out.push(info);
        }
    }
    out.sort_by_key(|i| (i.since, i.pid));
    out
}

/// Name this window — for the OS, and for every other instance's window menu.
///
/// One call site in the frontend (`useWindowTitle`) covers both, because they
/// are the same fact: the title is what the Dock, ⌘-Tab and Mission Control
/// read, and `windowmenu::announce` is what puts it in a sibling's 「Window」
/// menu. `workspace` is display-only; the claim on a folder is the lock, not
/// this.
#[command]
pub fn set_window_title(
    window: tauri::WebviewWindow,
    title: String,
    workspace: Option<String>,
) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())?;
    announce_instance(window.app_handle(), &title, workspace.as_deref());
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

    // ── The instance registry (real fs, scratch dirs) ────────────────────────

    fn reg(tag: &str) -> PathBuf {
        let dir = scratch(&format!("registry-{tag}"));
        dir.join("instances")
    }

    fn instance(pid: u32, since: u64, title: &str) -> InstanceInfo {
        InstanceInfo {
            pid,
            port: Some(4000 + pid as u16),
            since,
            title: title.to_owned(),
            workspace: None,
        }
    }

    fn put(dir: &Path, info: &InstanceInfo) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(entry_path(dir, info.pid), serde_json::to_vec(info).unwrap()).unwrap();
    }

    #[test]
    fn listed_oldest_first_regardless_of_pid() {
        // The order is the whole reason `since` is stored: every instance has
        // to render the same list in the same order, so the author's second
        // window is in the same place in all of them.
        let dir = reg("order");
        put(&dir, &instance(300, 20, "later, lower pid"));
        put(&dir, &instance(400, 10, "earlier, higher pid"));
        let listed = scan_instances(&dir, 999, |_| true);
        assert_eq!(
            listed.iter().map(|i| i.pid).collect::<Vec<_>>(),
            vec![400, 300]
        );
    }

    #[test]
    fn ties_on_since_break_by_pid() {
        // Two windows opened in the same second still need *an* order, and it
        // has to be the same one everywhere.
        let dir = reg("tie");
        put(&dir, &instance(500, 7, "b"));
        put(&dir, &instance(200, 7, "a"));
        let listed = scan_instances(&dir, 999, |_| true);
        assert_eq!(
            listed.iter().map(|i| i.pid).collect::<Vec<_>>(),
            vec![200, 500]
        );
    }

    #[test]
    fn dead_instance_is_dropped_and_its_file_swept() {
        // A crashed instance leaves its file behind; reading the list is the
        // only sweep there is.
        let dir = reg("dead");
        put(&dir, &instance(100, 1, "alive"));
        put(&dir, &instance(200, 2, "crashed"));
        let listed = scan_instances(&dir, 999, |pid| pid == 100);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].pid, 100);
        assert!(!entry_path(&dir, 200).exists());
    }

    #[test]
    fn our_own_entry_is_never_probed() {
        // The probe would say "alive" anyway, but a self-check that ever
        // answered wrong would delete the current window from its own menu.
        let dir = reg("self");
        put(&dir, &instance(100, 1, "us"));
        let listed = scan_instances(&dir, 100, |_| panic!("must not probe ourselves"));
        assert_eq!(listed.len(), 1);
    }

    #[test]
    fn unparsable_file_is_swept_by_the_pid_in_its_name() {
        // The content that would name the owner is exactly what is unreadable,
        // so without the filename fallback garbage could never leave.
        let dir = reg("garbage-dead");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(entry_path(&dir, 200), b"{truncated").unwrap();
        assert!(scan_instances(&dir, 999, |_| false).is_empty());
        assert!(!entry_path(&dir, 200).exists());
    }

    #[test]
    fn unparsable_file_of_a_live_owner_is_left_alone() {
        // A half-written file is the normal case here: it is being announced
        // right now. Deleting it would race the writer.
        let dir = reg("garbage-live");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(entry_path(&dir, 200), b"{truncated").unwrap();
        assert!(scan_instances(&dir, 999, |_| true).is_empty());
        assert!(entry_path(&dir, 200).exists());
    }

    #[test]
    fn unrelated_files_are_ignored() {
        let dir = reg("noise");
        put(&dir, &instance(100, 1, "us"));
        std::fs::write(dir.join("notes.txt"), b"hello").unwrap();
        std::fs::write(dir.join("cache.json.tmp"), b"hello").unwrap();
        let listed = scan_instances(&dir, 999, |_| true);
        assert_eq!(listed.len(), 1);
        assert!(dir.join("notes.txt").exists());
    }

    #[test]
    fn missing_registry_dir_lists_nothing() {
        // First launch on a machine: the directory does not exist yet, and
        // that must be an empty menu rather than a panic.
        let dir = reg("absent").join("nope");
        assert!(scan_instances(&dir, 999, |_| true).is_empty());
    }

    #[test]
    fn round_trips_through_the_file() {
        // The one thing another *version* of the app could break: an entry
        // written by a build with more fields must still read here.
        let dir = reg("roundtrip");
        let info = InstanceInfo {
            pid: 100,
            port: Some(51234),
            since: 42,
            title: "第三卷".to_owned(),
            workspace: Some("/tmp/book".to_owned()),
        };
        put(&dir, &info);
        assert_eq!(scan_instances(&dir, 999, |_| true), vec![info]);
    }
}
