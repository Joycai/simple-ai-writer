//! Running one shell command on the author's machine — the Rust half of the
//! agent's `run_command` tool. Design: docs/feature/agent/shell-command-plan.md.
//!
//! Deliberately not `tauri-plugin-shell` (decision table §2.1 there). The
//! plugin's one safety feature is a static allowlist of programs and argument
//! patterns; a command the model writes at run time can only be admitted as
//! `cmd: pwsh, args: true`, which switches that list off and leaves a spawn.
//! And what this feature actually needs the plugin does not have: a timeout,
//! killing the whole process *tree* (its `kill()` stops the shell alone), an
//! output cap, encoding detection (it takes one fixed encoding), and a `cwd`
//! fence that follows the runtime `FsScope` the way every `fs_*` command does.
//!
//! What this side is responsible for — and what it is not. The approval card
//! is frontend state, like every other L2 tool's; `invoke("cmd_run")` is
//! reachable from the webview whether or not the card was shown. Here live
//! the `cwd` fence, the table `cmd_kill` needs to find a run, the timeout, and
//! the process-group kill. The fence is on the *working directory* only: the
//! command itself can `cd ..`, and the card is what stands between the model
//! and that.
//!
//! Platform shape (the two `#[cfg]` halves below):
//!   - Windows: `pwsh.exe` (PowerShell 7) if it is on PATH, else Windows
//!     PowerShell 5.1 — `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy
//!     Bypass -Command`. `CREATE_NO_WINDOW`, or every command flashes a console.
//!     The command is wrapped so PowerShell speaks UTF-8 (5.1 defaults to the
//!     OEM code page — GBK on a Chinese Windows) and so a native program's
//!     failure becomes the exit code (`-Command` alone reports 0 for it).
//!   - unix: `$SHELL` when it is one we know, else the platform default, run
//!     as `-l -c`. The `-l` is load-bearing: a GUI app launched from the Dock
//!     has `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — Homebrew, pyenv
//!     and nvm all live in the login profile, so without it every tool the
//!     author installed is "not found". Windows keeps PATH in the registry
//!     and needs no profile, hence `-NoProfile` there; the asymmetry is meant.
//!     `process_group(0)` so a timeout can `killpg` the shell and everything
//!     it started.
//!
//! stdin is `/dev/null` on both: a command that wants to talk fails at once
//! instead of parking the whole run on an invisible prompt.

use crate::blocking::blocking;
use crate::commands::decode_text;
use crate::scope::FsScope;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{command, State};

/// Bytes kept per stream. Past this the reader keeps *draining* — a full pipe
/// blocks the child forever — but stops keeping.
const MAX_STREAM_BYTES: usize = 1024 * 1024;
/// How often the wait loop looks at the child.
const POLL: Duration = Duration::from_millis(50);
/// Between the polite signal and the forced one (unix; Windows has only one).
const TERM_GRACE: Duration = Duration::from_secs(2);
/// How long, after the child exited, to wait for its pipes to close. Only a
/// grandchild that survived the group kill (a daemon that `setsid`ed itself)
/// keeps them open past that; its bytes are not worth hanging a run for.
const DRAIN_GRACE: Duration = Duration::from_secs(2);
/// Timeout ceiling. The frontend clamps too; this side is the one that holds.
const MAX_TIMEOUT_MS: u64 = 600_000;
const MIN_TIMEOUT_MS: u64 = 1_000;

/// Environment that keeps a non-interactive run non-interactive: no colour
/// escapes in the transcript, no pager waiting on a keypress, no credential
/// prompt from git.
const ENV: [(&str, &str); 7] = [
    ("NO_COLOR", "1"),
    ("TERM", "dumb"),
    ("PAGER", "cat"),
    ("GIT_PAGER", "cat"),
    ("GIT_TERMINAL_PROMPT", "0"),
    ("PYTHONIOENCODING", "utf-8"),
    ("PYTHONUTF8", "1"),
];

/// Which shell this machine runs commands with, and on what system. Resolved
/// once per process. The system half is here rather than in a command of its
/// own because it has exactly one reader, the tool description, and that
/// reader needs both at once: `zsh` alone does not say whether `sed -i` wants
/// an argument (BSD) or not (GNU), or whether `open` / `xdg-open` / `brew` /
/// `apt` exist.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    /// `pwsh` / `powershell` / `zsh` / `bash` / `sh` / `fish` / `dash` / `ksh`.
    pub kind: String,
    /// What `Command::new` gets: a bare name on Windows (PATH resolves it),
    /// an absolute path on unix.
    pub path: String,
    /// PowerShell's `$PSVersionTable.PSVersion`; `None` on unix, where the
    /// kind says enough.
    pub version: Option<String>,
    /// `std::env::consts::OS`: `macos` / `windows` / `linux` / …
    pub os: String,
    /// The system's own version string — macOS `15.2`, Windows `10.0.26100.0`,
    /// Linux `/etc/os-release`'s `PRETTY_NAME` (`Ubuntu 24.04.1 LTS`). `None`
    /// when it could not be read; the OS name still goes out.
    pub os_version: Option<String>,
    /// `std::env::consts::ARCH` — the architecture this binary was built for,
    /// which is the machine's except under emulation (an x64 build on ARM
    /// Windows, Rosetta).
    pub arch: String,
}

impl ShellInfo {
    fn new(kind: &str, path: &str, version: Option<String>, os_version: Option<String>) -> Self {
        ShellInfo {
            kind: kind.into(),
            path: path.into(),
            version,
            os: std::env::consts::OS.into(),
            os_version,
            arch: std::env::consts::ARCH.into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdRequest {
    /// Frontend-minted id `cmd_kill` refers to. Unique per call, never reused.
    pub run_id: String,
    pub command: String,
    /// Absolute working directory, inside a registered root.
    pub cwd: String,
    pub timeout_ms: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CmdResult {
    pub pid: u32,
    /// `None` when the process died of a signal (unix) or could not be waited.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    /// The timeout fired and the group was killed.
    pub timed_out: bool,
    /// `cmd_kill` was called for this run and the group was killed.
    pub killed: bool,
    /// The stream exceeded [`MAX_STREAM_BYTES`]; only the head was kept.
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub shell: ShellInfo,
}

/// One live run, as much of it as the kill path needs: the pid (the process
/// group's id on unix) and the flag that turns "it exited" into "the author
/// stopped it".
struct RunEntry {
    killed: AtomicBool,
}

/// The live-run table — managed state, cloned into the blocking task like
/// `FsScope` (an `Arc`, so the clone *is* the table).
#[derive(Default, Clone)]
pub struct Running(Arc<Mutex<HashMap<String, Arc<RunEntry>>>>);

static SHELL: OnceLock<ShellInfo> = OnceLock::new();

/// The machine's shell, resolved on first use. Probing runs a process on
/// Windows, so the first caller pays ~100 ms; every later one reads a static.
fn shell() -> &'static ShellInfo {
    SHELL.get_or_init(resolve_shell)
}

// ── Windows ─────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
}

/// One probe, two lines: the PowerShell version, then the Windows version.
/// No quotes on purpose — Rust's Windows argument quoting and 5.1's command
/// line parser disagree about `\"`.
#[cfg(windows)]
const PS_PROBE: &str =
    "$PSVersionTable.PSVersion.ToString(); [Environment]::OSVersion.Version.ToString()";

/// The probe's stdout → (PowerShell version, Windows version).
#[cfg(any(windows, test))]
fn parse_ps_probe(stdout: &str) -> (Option<String>, Option<String>) {
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    (
        lines.next().map(String::from),
        lines.next().map(String::from),
    )
}

#[cfg(windows)]
fn resolve_shell() -> ShellInfo {
    for (kind, exe) in [("pwsh", "pwsh.exe"), ("powershell", "powershell.exe")] {
        let mut cmd = Command::new(exe);
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            PS_PROBE,
        ]);
        cmd.stdin(Stdio::null());
        no_window(&mut cmd);
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let (version, os_version) = parse_ps_probe(&String::from_utf8_lossy(&out.stdout));
                return ShellInfo::new(kind, exe, version, os_version);
            }
        }
    }
    // Every supported Windows ships 5.1; reaching here means the probe itself
    // failed, and the run will report the real error when it tries.
    ShellInfo::new("powershell", "powershell.exe", None, None)
}

/// The command as PowerShell receives it. Three things around the author's
/// line, each a measured symptom without it:
///   - the two encoding assignments: 5.1 writes the OEM code page, so a
///     Chinese file name in `git status` arrives as mojibake;
///   - the trailing exit logic: with `-Command`, a native program's non-zero
///     exit does not become PowerShell's, so `git foo` reported success;
///     `$LASTEXITCODE` is the native code, `$?` the last statement's success.
#[cfg(windows)]
fn wrap_powershell(command: &str) -> String {
    format!(
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8\n\
         {command}\n\
         if ($LASTEXITCODE) {{ exit $LASTEXITCODE }} elseif (-not $?) {{ exit 1 }}"
    )
}

#[cfg(windows)]
fn build(shell: &ShellInfo, command: &str, cwd: &Path) -> Command {
    let mut cmd = Command::new(&shell.path);
    cmd.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &wrap_powershell(command),
    ]);
    no_window(&mut cmd);
    cmd.current_dir(cwd);
    cmd
}

/// `taskkill /T` is the only tree kill Windows offers without walking the
/// process snapshot ourselves; `/F` because there is no polite signal to
/// send a console-less process anyway.
#[cfg(windows)]
fn terminate_tree(pid: u32) {
    let mut cmd = Command::new("taskkill.exe");
    cmd.args(["/T", "/F", "/PID", &pid.to_string()]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);
    let _ = cmd.status();
}

#[cfg(windows)]
fn force_kill_tree(pid: u32) {
    terminate_tree(pid);
}

// ── unix ────────────────────────────────────────────────────────────────────

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(unix)]
fn resolve_shell() -> ShellInfo {
    let (kind, path) = find_unix_shell();
    ShellInfo::new(&kind, &path, None, os_version())
}

/// (kind, absolute path) of the shell commands run in.
#[cfg(unix)]
fn find_unix_shell() -> (String, String) {
    const KNOWN: [&str; 6] = ["zsh", "bash", "sh", "fish", "dash", "ksh"];
    if let Ok(login) = std::env::var("SHELL") {
        let path = Path::new(&login);
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if KNOWN.contains(&name) && is_executable(path) {
                return (name.into(), login.clone());
            }
        }
    }
    #[cfg(target_os = "macos")]
    const DEFAULTS: [&str; 3] = ["/bin/zsh", "/bin/bash", "/bin/sh"];
    #[cfg(not(target_os = "macos"))]
    const DEFAULTS: [&str; 2] = ["/bin/bash", "/bin/sh"];
    for candidate in DEFAULTS {
        let path = Path::new(candidate);
        if is_executable(path) {
            let kind = path.file_name().and_then(|n| n.to_str()).unwrap_or("sh");
            return (kind.into(), candidate.into());
        }
    }
    ("sh".into(), "/bin/sh".into())
}

/// macOS: read the version file rather than run `sw_vers` — a file read, no
/// process, same answer.
#[cfg(target_os = "macos")]
fn os_version() -> Option<String> {
    let plist = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist").ok()?;
    plist_product_version(&plist)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn os_version() -> Option<String> {
    ["/etc/os-release", "/usr/lib/os-release"]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| os_release_name(&text))
}

/// `<key>ProductVersion</key><string>15.2</string>` → `15.2`. The file is an
/// XML plist Apple has kept that shape for twenty years; a plist crate for one
/// string is not worth the dependency.
#[cfg(any(target_os = "macos", test))]
fn plist_product_version(plist: &str) -> Option<String> {
    let after_key = &plist[plist.find("<key>ProductVersion</key>")? + 25..];
    let start = after_key.find("<string>")? + 8;
    let end = after_key[start..].find("</string>")? + start;
    let v = after_key[start..end].trim();
    (!v.is_empty()).then(|| v.to_string())
}

/// os-release's `PRETTY_NAME`, else `NAME VERSION_ID`.
#[cfg(any(all(unix, not(target_os = "macos")), test))]
fn os_release_name(text: &str) -> Option<String> {
    let field = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(key)?.strip_prefix('='))
            .map(|v| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
            .filter(|v| !v.is_empty())
    };
    field("PRETTY_NAME").or_else(|| {
        let name = field("NAME")?;
        Some(match field("VERSION_ID") {
            Some(v) => format!("{name} {v}"),
            None => name,
        })
    })
}

#[cfg(unix)]
fn build(shell: &ShellInfo, command: &str, cwd: &Path) -> Command {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new(&shell.path);
    cmd.arg("-l").arg("-c").arg(command);
    // Its own group, so the kill below reaches what the shell started.
    cmd.process_group(0);
    cmd.current_dir(cwd);
    cmd
}

/// The group's id is the shell's pid (`process_group(0)`).
#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) {
    // SAFETY: killpg with a pid we spawned and still own; a stale pid returns
    // ESRCH, which is ignored.
    unsafe {
        libc::killpg(pid as libc::pid_t, signal);
    }
}

#[cfg(unix)]
fn terminate_tree(pid: u32) {
    signal_group(pid, libc::SIGTERM);
}

#[cfg(unix)]
fn force_kill_tree(pid: u32) {
    signal_group(pid, libc::SIGKILL);
}

// ── shared ──────────────────────────────────────────────────────────────────

/// What a reader thread fills while the child runs. Shared rather than
/// returned through `join` so the waiter can give up on a pipe a survivor
/// holds open (see [`DRAIN_GRACE`]) and still take what arrived.
#[derive(Default)]
struct Sink {
    buf: Mutex<(Vec<u8>, bool)>,
    done: AtomicBool,
}

fn drain<R: Read + Send + 'static>(stream: Option<R>) -> Arc<Sink> {
    let sink = Arc::new(Sink::default());
    let worker = sink.clone();
    thread::spawn(move || {
        if let Some(mut reader) = stream {
            let mut chunk = [0u8; 8192];
            loop {
                let n = match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut kept = worker.buf.lock().unwrap();
                let room = MAX_STREAM_BYTES.saturating_sub(kept.0.len());
                let take = n.min(room);
                kept.0.extend_from_slice(&chunk[..take]);
                if take < n {
                    kept.1 = true;
                }
            }
        }
        worker.done.store(true, Ordering::SeqCst);
    });
    sink
}

impl Sink {
    /// Wait up to `grace` for EOF, then take whatever is there.
    fn take(&self, grace: Duration) -> (Vec<u8>, bool) {
        let until = Instant::now() + grace;
        while !self.done.load(Ordering::SeqCst) && Instant::now() < until {
            thread::sleep(POLL);
        }
        let mut kept = self.buf.lock().unwrap();
        (std::mem::take(&mut kept.0), kept.1)
    }
}

/// Bytes → text the way `fs_read_text_file` does it (BOM → UTF-8 → guess),
/// because the programs a shell runs speak whatever code page they like.
/// Output with NUL bytes is not a text file, but it is still output: lossy.
fn decode_output(bytes: Vec<u8>) -> String {
    let text = match decode_text(bytes.clone()) {
        Ok(text) => text,
        Err(_) => String::from_utf8_lossy(&bytes).into_owned(),
    };
    text.replace("\r\n", "\n")
}

/// Spawn, wait with the timeout and the kill flag, collect.
///
/// Free of Tauri so the tests can call it. `running` is the table the run
/// registers itself in for the duration — `cmd_kill` looks it up there.
fn execute(
    shell: &ShellInfo,
    running: &Running,
    run_id: &str,
    command: &str,
    cwd: &Path,
    timeout: Duration,
) -> Result<CmdResult, String> {
    let start = Instant::now();
    let mut cmd = build(shell, command, cwd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in ENV {
        cmd.env(key, value);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", shell.path))?;
    let pid = child.id();
    let entry = Arc::new(RunEntry {
        killed: AtomicBool::new(false),
    });
    running
        .0
        .lock()
        .unwrap()
        .insert(run_id.to_string(), entry.clone());

    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());

    let mut timed_out = false;
    let mut killed = false;
    let mut term_sent_at: Option<Instant> = None;
    let mut forced = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if !killed && entry.killed.load(Ordering::SeqCst) {
            killed = true;
        }
        if !timed_out && !killed && start.elapsed() >= timeout {
            timed_out = true;
        }
        if timed_out || killed {
            match term_sent_at {
                None => {
                    terminate_tree(pid);
                    term_sent_at = Some(Instant::now());
                }
                Some(at) if !forced && at.elapsed() >= TERM_GRACE => {
                    force_kill_tree(pid);
                    let _ = child.kill();
                    forced = true;
                }
                _ => {}
            }
        }
        thread::sleep(POLL);
    };
    running.0.lock().unwrap().remove(run_id);

    let (stdout, stdout_truncated) = out.take(DRAIN_GRACE);
    let (stderr, stderr_truncated) = err.take(DRAIN_GRACE);

    Ok(CmdResult {
        pid,
        exit_code: status.and_then(|s| s.code()),
        stdout: decode_output(stdout),
        stderr: decode_output(stderr),
        duration_ms: start.elapsed().as_millis() as u64,
        timed_out,
        killed,
        stdout_truncated,
        stderr_truncated,
        shell: shell.clone(),
    })
}

// ── commands ────────────────────────────────────────────────────────────────

/// Which shell commands run with here — for the settings row and the card.
#[command]
pub async fn cmd_shell_info() -> Result<ShellInfo, String> {
    // On Windows the first call probes with a real process; keep it off the
    // main thread like everything else that can take a moment.
    blocking(|| Ok(shell().clone())).await
}

/// Run one command. Blocks until it exits, times out, or is killed.
#[command]
pub async fn cmd_run(
    req: CmdRequest,
    scope: State<'_, FsScope>,
    running: State<'_, Running>,
) -> Result<CmdResult, String> {
    let scope = scope.inner().clone();
    let running = running.inner().clone();
    blocking(move || {
        scope.check(&req.cwd)?;
        // The host's own spelling for the child's working directory — same
        // reason as `open_with_default_app`: the frontend speaks forward
        // slashes, and `Get-Location` would echo them back into the model's
        // next command.
        let cwd: PathBuf = Path::new(&req.cwd).components().collect();
        if !cwd.is_dir() {
            return Err(format!("Working directory does not exist: {}", req.cwd));
        }
        if req.command.trim().is_empty() {
            return Err("Empty command".into());
        }
        if req.run_id.is_empty() {
            return Err("Missing run id".into());
        }
        let timeout = Duration::from_millis(req.timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS));
        execute(shell(), &running, &req.run_id, &req.command, &cwd, timeout)
    })
    .await
}

/// Stop a run the author cancelled. Sets the flag the wait loop reads; the
/// loop does the killing, so the run's own result reports `killed`. Unknown
/// id = already finished, which is not an error.
#[command]
pub fn cmd_kill(run_id: String, running: State<'_, Running>) -> Result<(), String> {
    if let Some(entry) = running.0.lock().unwrap().get(&run_id) {
        entry.killed.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_info_names_this_system() {
        let info = shell();
        assert_eq!(info.os, std::env::consts::OS);
        assert_eq!(info.arch, std::env::consts::ARCH);
        #[cfg(target_os = "macos")]
        assert!(info.os_version.as_deref().is_some_and(|v| v
            .chars()
            .next()
            .unwrap()
            .is_ascii_digit()));
    }

    #[test]
    fn plist_version_is_read_from_its_key() {
        let plist = "<dict>\n\t<key>ProductName</key>\n\t<string>macOS</string>\n\t<key>ProductVersion</key>\n\t<string>15.2</string>\n</dict>";
        assert_eq!(plist_product_version(plist).as_deref(), Some("15.2"));
        assert_eq!(plist_product_version("<dict></dict>"), None);
    }

    #[test]
    fn os_release_prefers_pretty_name() {
        let text = "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n";
        assert_eq!(os_release_name(text).as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(
            os_release_name("NAME=Arch Linux\n").as_deref(),
            Some("Arch Linux")
        );
        assert_eq!(
            os_release_name("NAME=Debian\nVERSION_ID=12\n").as_deref(),
            Some("Debian 12")
        );
        assert_eq!(os_release_name("ID=x\n"), None);
    }

    #[test]
    fn ps_probe_splits_into_two_versions() {
        let (ps, os) = parse_ps_probe("7.4.1\r\n10.0.26100.0\r\n");
        assert_eq!(ps.as_deref(), Some("7.4.1"));
        assert_eq!(os.as_deref(), Some("10.0.26100.0"));
        assert_eq!(parse_ps_probe(""), (None, None));
    }

    fn run_in(running: &Running, id: &str, cmd: &str, timeout_ms: u64) -> CmdResult {
        let dir = tempfile::tempdir().unwrap();
        execute(
            shell(),
            running,
            id,
            cmd,
            dir.path(),
            Duration::from_millis(timeout_ms),
        )
        .unwrap()
    }

    fn run(cmd: &str, timeout_ms: u64) -> CmdResult {
        run_in(&Running::default(), "t", cmd, timeout_ms)
    }

    #[test]
    fn echo_lands_in_stdout_with_exit_zero() {
        let r = run("echo hi", 10_000);
        assert_eq!(r.exit_code, Some(0));
        assert_eq!(r.stdout.trim(), "hi");
        assert!(!r.timed_out && !r.killed);
        assert!(!r.stdout_truncated && !r.stderr_truncated);
    }

    #[test]
    fn exit_code_is_reported() {
        let r = run("exit 3", 10_000);
        assert_eq!(r.exit_code, Some(3));
    }

    #[test]
    fn stderr_is_kept_apart_from_stdout() {
        #[cfg(unix)]
        let cmd = ">&2 echo oops";
        #[cfg(windows)]
        let cmd = "[Console]::Error.WriteLine('oops')";
        let r = run(cmd, 10_000);
        assert!(r.stderr.contains("oops"), "{r:?}");
        assert_eq!(r.stdout.trim(), "");
    }

    /// The reason for the cap: a run that prints without end must not take
    /// the webview with it, and must still *finish* — a reader that stopped
    /// reading would leave the child blocked on a full pipe forever.
    #[test]
    fn output_past_the_cap_is_marked_and_the_child_still_exits() {
        #[cfg(unix)]
        let cmd = "head -c 3000000 /dev/zero | tr '\\0' a";
        #[cfg(windows)]
        let cmd = "[Console]::Out.Write('a' * 3000000)";
        let r = run(cmd, 30_000);
        assert_eq!(r.exit_code, Some(0), "{:?}", r.stderr);
        assert!(r.stdout_truncated);
        assert_eq!(r.stdout.len(), MAX_STREAM_BYTES);
    }

    /// The wall clock below is read against the command's own 30s sleep, not
    /// against a budget: `timed_out` alone can't tell "the timeout tore the
    /// child down" from "the run sat there until the sleep ended by itself",
    /// so the bound has to stay — but it's half the sleep, not a few seconds.
    /// Nothing here is a performance claim; a tight bound would be measuring
    /// the runner's spawn latency instead (see the note on
    /// `a_command_that_reads_stdin_fails_fast`).
    #[test]
    fn timeout_kills_the_run() {
        #[cfg(unix)]
        let cmd = "sleep 30";
        #[cfg(windows)]
        let cmd = "Start-Sleep 30";
        let started = Instant::now();
        let r = run(cmd, 300);
        assert!(r.timed_out, "{r:?}");
        assert!(!r.killed);
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "took {:?} — the timeout never ended the child, the sleep did",
            started.elapsed()
        );
    }

    /// The whole group, not just the shell: `sleep` is the shell's child, and
    /// after the timeout nothing in the group may answer signal 0.
    #[cfg(unix)]
    #[test]
    fn timeout_takes_the_grandchildren_with_it() {
        let r = run("sleep 30", 300);
        assert!(r.timed_out);
        thread::sleep(Duration::from_millis(200));
        // SAFETY: signal 0 probes existence only.
        let alive = unsafe { libc::killpg(r.pid as libc::pid_t, 0) } == 0;
        assert!(!alive, "process group {} survived the timeout", r.pid);
    }

    #[test]
    fn the_kill_flag_ends_the_run_as_killed_not_timed_out() {
        #[cfg(unix)]
        let cmd = "sleep 30";
        #[cfg(windows)]
        let cmd = "Start-Sleep 30";
        let running = Running::default();
        let table = running.clone();
        let worker = thread::spawn(move || run_in(&table, "k", cmd, 30_000));
        // Wait for the run to register, then do what `cmd_kill` does. The
        // deadline only breaks the loop if the worker died before registering
        // — registration follows the spawn, which a loaded runner can stall
        // for seconds, so it is generous rather than tight on purpose.
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(entry) = running.0.lock().unwrap().get("k") {
                entry.killed.store(true, Ordering::SeqCst);
                break;
            }
            assert!(Instant::now() < deadline, "run never registered");
            thread::sleep(POLL);
        }
        let r = worker.join().unwrap();
        assert!(r.killed, "{r:?}");
        assert!(!r.timed_out);
        assert!(
            running.0.lock().unwrap().is_empty(),
            "entry left in the table"
        );
    }

    /// stdin is closed, so a command that wants input gets EOF and fails at
    /// once instead of parking the run on a prompt nobody can see.
    ///
    /// `!r.timed_out` is the whole assertion: a prompt nobody can answer would
    /// sit there until the ceiling, so coming back inside it means the child
    /// exited on its own. This used to also bound the wall clock at 5s, which
    /// measured process-spawn latency rather than any of that and failed on a
    /// loaded CI runner (6.5s for a test that takes milliseconds locally, with
    /// no Rust source changed in the PR). It is not a performance test, so it
    /// no longer times anything, and the ceiling is loose enough that spawn
    /// latency can't reach it either.
    #[cfg(unix)]
    #[test]
    fn a_command_that_reads_stdin_fails_fast() {
        let r = run("read x", 30_000);
        assert_ne!(r.exit_code, Some(0));
        assert!(!r.timed_out, "{r:?}");
    }

    /// The `-Command` wrapper's whole reason: a native program's failure must
    /// surface as the exit code.
    #[cfg(windows)]
    #[test]
    fn a_native_failure_becomes_the_exit_code_on_powershell() {
        let r = run("cmd /c exit 7", 10_000);
        assert_eq!(r.exit_code, Some(7), "{r:?}");
    }

    #[test]
    fn crlf_is_normalised_and_the_shell_is_named() {
        let r = run("echo one", 10_000);
        assert!(!r.stdout.contains('\r'));
        assert!(!r.shell.kind.is_empty());
        assert!(!r.shell.path.is_empty());
    }
}
