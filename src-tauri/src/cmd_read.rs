//! Pre-spawn checks for built-in automatic reads. This is deliberately not an
//! OS sandbox: installed executables and concurrent filesystem edits are trusted.
//! Uncertain paths, oversized scans, and missing programs fall back to a card.
#[cfg(windows)]
use super::build;
use super::ShellInfo;
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticRead {
    pub project_path: String,
    pub paths: Vec<String>,
    pub programs: Vec<String>,
}

fn denied(reason: impl std::fmt::Display) -> String {
    format!("AUTO_READ_DENIED: {reason}")
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize().map_err(denied)
}

/// Follow directory links only after checking their real destination; the seen
/// set handles internal cycles. No exclusions: ignored files can still be read
/// by grep/find/Get-ChildItem. Fail closed on errors and resource limits.
fn inspect_tree(
    path: &Path,
    root: &Path,
    seen: &mut HashSet<PathBuf>,
    start: Instant,
) -> Result<(), String> {
    let mut pending = vec![path.to_path_buf()];
    while let Some(path) = pending.pop() {
        // Shell globs can turn a filename into an option (sort * with a file
        // named -o, or find * with -exec). Without rebuilding argv, reject such
        // trees conservatively, even when a particular literal use has --.
        if path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with('-'))
        {
            return Err(denied("option-like filename"));
        }
        if start.elapsed() > Duration::from_secs(1) || seen.len() >= 20_000 {
            return Err(denied("path inspection limit exceeded"));
        }
        let real = canonical(&path)?;
        if !real.starts_with(root) {
            return Err(denied("a link leaves the project"));
        }
        if !seen.insert(real.clone()) {
            continue;
        }
        let meta = real.metadata().map_err(denied)?;
        if meta.is_dir() {
            for entry in real.read_dir().map_err(denied)? {
                pending.push(entry.map_err(denied)?.path());
                if pending.len() > 20_000 {
                    return Err(denied("path inspection limit exceeded"));
                }
            }
        } else if !meta.is_file() {
            return Err(denied("special file"));
        }
    }
    Ok(())
}

/// Arguments include patterns and flags. Existing literal operands are checked;
/// a glob inspects its entire containing tree (not just today's matches).
fn inspect_paths(req: &AutomaticRead, cwd: &Path, root: &Path) -> Result<(), String> {
    let start = Instant::now();
    let mut seen = HashSet::new();
    for value in &req.paths {
        #[cfg(windows)]
        let value = value.replace('\\', "/");
        #[cfg(unix)]
        let value = value.clone();
        let wildcard = value.find(['*', '?', '[']);
        let target = match wildcard {
            Some(at) => value[..at]
                .rfind('/')
                .map(|end| &value[..end])
                .unwrap_or("."),
            None => value.as_str(),
        };
        if target.is_empty() {
            continue;
        }
        let path = Path::new(target);
        if path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
        {
            return Err(denied("path outside project"));
        }
        let path = cwd.join(path);
        match std::fs::symlink_metadata(&path) {
            Ok(_) => inspect_tree(&path, root, &mut seen, start)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // A missing descendant can still pass through a link outside.
                let mut ancestor = path.parent();
                while let Some(p) = ancestor {
                    if p.exists() {
                        if !canonical(p)?.starts_with(root) {
                            return Err(denied("path ancestor outside project"));
                        }
                        break;
                    }
                    ancestor = p.parent();
                }
            }
            Err(e) => return Err(denied(e)),
        }
    }
    Ok(())
}

fn search_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    // GUI launches may omit Homebrew. Only existing, absolute directories
    // outside the project qualify; never search '.' or a project bin folder.
    #[cfg(unix)]
    for dir in [
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ] {
        if let Ok(real) = Path::new(dir).canonicalize() {
            if !real.starts_with(root) && !dirs.contains(&real) {
                dirs.push(real);
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if !dir.is_absolute() {
                continue;
            }
            if let Ok(real) = dir.canonicalize() {
                if !real.starts_with(root) && !dirs.contains(&real) {
                    dirs.push(real);
                }
            }
        }
    }
    dirs
}

#[cfg(windows)]
fn is_cmdlet(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "get-acl"
            | "get-childitem"
            | "get-content"
            | "get-filehash"
            | "get-item"
            | "get-location"
            | "get-process"
            | "get-psdrive"
            | "resolve-path"
            | "select-string"
            | "test-path"
            | "cat"
            | "dir"
            | "gc"
            | "gci"
            | "gi"
            | "gl"
            | "ls"
            | "pwd"
            | "sls"
            | "type"
            | "where"
            | "select-object"
            | "measure-object"
            | "sort-object"
            | "get-unique"
    )
}

fn check_program(name: &str, dirs: &[PathBuf], root: &Path) -> Result<Option<PathBuf>, String> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.'))
    {
        return Err(denied("invalid executable"));
    }
    #[cfg(windows)]
    if is_cmdlet(name) {
        return Ok(None);
    }
    #[cfg(windows)]
    let file = if name.to_ascii_lowercase().ends_with(".exe") {
        name.to_string()
    } else {
        format!("{name}.exe")
    };
    #[cfg(unix)]
    let file = name.to_string();
    for dir in dirs {
        let path = dir.join(&file);
        if path.is_file() {
            if canonical(&path)?.starts_with(root) {
                return Err(denied("executable points into project"));
            }
            #[cfg(unix)]
            if !super::is_executable(&path) {
                continue;
            }
            return Ok(Some(canonical(&path)?));
        }
    }
    Err(denied(format!("no trusted executable for {name}")))
}

fn check_git(cwd: &Path, root: &Path) -> Result<(), String> {
    // Linked worktrees, alternates and config includes can reach other trees.
    // They require explicit approval instead of pretending argv fences them.
    let mut dir = cwd;
    loop {
        let git = dir.join(".git");
        if git.exists() {
            if !git.is_dir() || !canonical(&git)?.starts_with(root) {
                return Err(denied("external Git directory"));
            }
            inspect_tree(&git, root, &mut HashSet::new(), Instant::now())?;
            for file in ["objects/info/alternates", "commondir"] {
                if git.join(file).exists() {
                    return Err(denied("external Git storage"));
                }
            }
            for file in ["config", "config.worktree"] {
                let config = git.join(file);
                if config.exists() {
                    let text = std::fs::read_to_string(&config)
                        .map_err(denied)?
                        .to_ascii_lowercase();
                    let compact: String =
                        text.chars().filter(|c| !c.is_ascii_whitespace()).collect();
                    // Also reject partial clones: older Git versions ignore
                    // GIT_NO_LAZY_FETCH and may contact a remote during a read.
                    // Clean/process filters also execute during status/diff hashing.
                    if [
                        "[include",
                        "[filter",
                        "worktree",
                        "promisor",
                        "partialclone",
                    ]
                    .iter()
                    .any(|key| compact.contains(key))
                    {
                        return Err(denied("Git config redirects repository inputs"));
                    }
                }
            }
            return Ok(());
        }
        if dir == root {
            return Err(denied("no Git repository inside project"));
        }
        dir = dir.parent().ok_or_else(|| denied("no Git repository"))?;
    }
}

pub fn prepare(
    req: &AutomaticRead,
    cwd: &Path,
    shell: &ShellInfo,
    command: &str,
) -> Result<Command, String> {
    let root = canonical(Path::new(&req.project_path))?;
    let cwd = canonical(cwd)?;
    if !cwd.starts_with(&root) {
        return Err(denied("working directory outside project"));
    }
    inspect_paths(req, &cwd, &root)?;
    let dirs = search_dirs(&root);
    #[cfg(windows)]
    let mut native_wrappers = String::new();
    for name in &req.programs {
        let executable = check_program(name, &dirs, &root)?;
        #[cfg(windows)]
        if let Some(path) = executable {
            // PowerShell also discovers scripts on PATH. Bind native names to
            // the verified .exe explicitly, so a same-name .ps1/.cmd cannot win.
            let quoted = path.to_string_lossy().replace('\'', "''");
            native_wrappers.push_str(&format!("function {name} {{ & '{quoted}' @args }}; "));
        }
        #[cfg(unix)]
        let _ = executable;
    }
    if req
        .programs
        .iter()
        .any(|n| n.eq_ignore_ascii_case("git") || n.eq_ignore_ascii_case("git.exe"))
    {
        check_git(&cwd, &root)?;
    }
    #[cfg(unix)]
    let mut cmd = {
        use std::os::unix::process::CommandExt;
        let _ = shell;
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(command)
            .current_dir(&cwd)
            .process_group(0);
        cmd
    };
    #[cfg(windows)]
    let mut cmd = {
        let script = format!("$PSModuleAutoLoadingPreference='None'; Import-Module ($PSHOME + '/Modules/Microsoft.PowerShell.Management') -ErrorAction Stop; Import-Module ($PSHOME + '/Modules/Microsoft.PowerShell.Utility') -ErrorAction Stop; {native_wrappers}{command}");
        let mut trusted_shell = shell.clone();
        let shell_path = Path::new(&shell.path);
        let executable = if shell_path.is_absolute() {
            canonical(shell_path)?
        } else {
            dirs.iter()
                .map(|d| d.join(shell_path))
                .find(|p| p.is_file())
                .ok_or_else(|| denied("no trusted PowerShell executable"))?
        };
        if canonical(&executable)?.starts_with(&root) {
            return Err(denied("PowerShell inside project"));
        }
        trusted_shell.path = executable.to_string_lossy().into_owned();
        build(&trusted_shell, &script, &cwd)
    };
    cmd.env_clear();
    // Keep only OS essentials; no BASH_ENV, exported functions, preload hooks,
    // RIPGREP_CONFIG_PATH, Git config injection or user PSModulePath.
    for key in [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    cmd.env("PATHEXT", ".EXE");
    cmd.env("PATH", std::env::join_paths(&dirs).map_err(denied)?);
    cmd.env("GIT_CONFIG_NOSYSTEM", "1").env(
        "GIT_CONFIG_GLOBAL",
        if cfg!(windows) { "NUL" } else { "/dev/null" },
    );
    cmd.env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    let config = [
        (
            "core.attributesFile",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        ),
        (
            "core.excludesFile",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        ),
        (
            "mailmap.file",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        ),
        ("mailmap.blob", ""),
        ("blame.ignoreRevsFile", ""),
        ("core.fsmonitor", "false"),
        (
            "core.hooksPath",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        ),
        ("log.showSignature", "false"),
        ("gpg.program", ""),
        ("gpg.openpgp.program", ""),
        ("gpg.ssh.program", ""),
        ("gpg.x509.program", ""),
        ("submodule.recurse", "false"),
        ("status.submoduleSummary", "false"),
        ("diff.ignoreSubmodules", "all"),
    ];
    // Same quoting Git uses to forward -c to children; also understood by
    // versions older than GIT_CONFIG_COUNT. Values here are fixed constants.
    cmd.env(
        "GIT_CONFIG_PARAMETERS",
        config
            .iter()
            .map(|(k, v)| format!("'{k}={v}'"))
            .collect::<Vec<_>>()
            .join(" "),
    );
    cmd.env("GIT_CONFIG_COUNT", config.len().to_string());
    for (i, (key, value)) in config.into_iter().enumerate() {
        cmd.env(format!("GIT_CONFIG_KEY_{i}"), key)
            .env(format!("GIT_CONFIG_VALUE_{i}"), value);
    }
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn request(root: &Path, paths: &[&str], programs: &[&str]) -> AutomaticRead {
        AutomaticRead {
            project_path: root.to_string_lossy().into_owned(),
            paths: paths.iter().map(|s| s.to_string()).collect(),
            programs: programs.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn ordinary_files_globs_and_missing_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("docs/note.md"), "text").unwrap();
        let req = request(
            &root,
            &["docs/*.md", "-n", "pattern", "docs/missing.md"],
            &["cat"],
        );
        assert!(inspect_paths(&req, &root, &root).is_ok());
        let req = request(&root, &["../secret"], &["cat"]);
        assert!(inspect_paths(&req, &root, &root)
            .unwrap_err()
            .starts_with("AUTO_READ_DENIED:"));
    }

    #[test]
    fn glob_expansion_cannot_inject_output_or_execution_options() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        for name in ["-o", "--pre=helper", "-exec"] {
            fs::write(root.join(name), "").unwrap();
            assert!(inspect_paths(&request(&root, &["*"], &["sort"]), &root, &root).is_err());
            fs::remove_file(root.join(name)).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn links_globs_and_option_looking_filenames_cannot_escape() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        fs::write(outside.path().join("secret"), "secret").unwrap();
        symlink(outside.path(), root.join("linked")).unwrap();
        symlink(outside.path().join("secret"), root.join("-secret")).unwrap();
        symlink(outside.path().join("secret"), root.join("literal\\name.md")).unwrap();
        for path in [
            "linked/secret",
            "linked/missing",
            "linked/*",
            "*",
            ".",
            "-secret",
            "literal\\name.md",
        ] {
            let req = request(&root, &[path], &["cat"]);
            assert!(inspect_paths(&req, &root, &root).is_err(), "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn internal_link_cycles_terminate_and_special_files_are_refused() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        symlink(&root, root.join("cycle")).unwrap();
        assert!(inspect_paths(&request(&root, &["."], &["ls"]), &root, &root).is_ok());
        assert!(Command::new("mkfifo")
            .arg(root.join("fifo"))
            .status()
            .unwrap()
            .success());
        assert!(inspect_paths(&request(&root, &["."], &["ls"]), &root, &root).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_cannot_leave_project() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        let link = dir.path().join("junction");
        // Junction creation, unlike symlinks, does not require developer mode.
        let status = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(status.status.success());
        let req = request(&root, &["junction", "junction/*"], &["Get-ChildItem"]);
        assert!(inspect_paths(&req, &root, &root).is_err());
        fs::remove_dir(link).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn powershell_read_pipeline_uses_only_builtin_modules() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        fs::write(root.join("note.md"), "first\nsecond\n").unwrap();
        let req = request(&root, &["note.md"], &["Get-Content", "Select-Object"]);
        let cmd = prepare(
            &req,
            &root,
            super::super::shell(),
            "Get-Content note.md | Select-Object -First 1",
        )
        .unwrap();
        let result = super::super::execute_built(
            super::super::shell(),
            &super::super::Running::default(),
            "safe-ps",
            cmd,
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
        assert_eq!(result.stdout.trim(), "first");
    }

    #[cfg(windows)]
    #[test]
    fn native_powershell_wrapper_preserves_exit_status() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        let req = request(&root, &[], &["where.exe"]);
        let cmd = prepare(
            &req,
            &root,
            super::super::shell(),
            "where.exe ai_writer_missing_executable_23981",
        )
        .unwrap();
        let result = super::super::execute_built(
            super::super::shell(),
            &super::super::Running::default(),
            "safe-native",
            cmd,
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(result.exit_code, Some(1), "{}", result.stderr);
    }

    #[test]
    fn git_redirects_require_approval() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        for config in [
            "[include]\npath=outside",
            "[IncludeIf \"gitdir:x\"]\npath=x",
            "[core]\n WorkTree = ../other",
            "[filter \"custom\"]\nclean=touch marker",
        ] {
            fs::write(root.join(".git/config"), config).unwrap();
            assert!(check_git(&root, &root).is_err());
        }
        fs::write(root.join(".git/config"), "[core]\n bare=false").unwrap();
        assert!(check_git(&root, &root).is_ok());
        fs::write(root.join(".git/commondir"), "../other").unwrap();
        assert!(check_git(&root, &root).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn automatic_runner_uses_clean_non_login_shell() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        let req = request(&root, &["note.md"], &["cat"]);
        let cmd = prepare(&req, &root, super::super::shell(), "cat note.md").unwrap();
        assert_eq!(cmd.get_program(), "/bin/sh");
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), ["-c", "cat note.md"]);
        let env: std::collections::HashMap<_, _> = cmd.get_envs().collect();
        for key in [
            "RIPGREP_CONFIG_PATH",
            "BASH_ENV",
            "ENV",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "GIT_EXTERNAL_DIFF",
        ] {
            assert!(!env.contains_key(std::ffi::OsStr::new(key)));
        }
        assert_eq!(
            env[std::ffi::OsStr::new("GIT_OPTIONAL_LOCKS")],
            Some(std::ffi::OsStr::new("0"))
        );
        assert!(!search_dirs(&root)
            .iter()
            .any(|d| !d.is_absolute() || d.starts_with(&root)));
    }

    #[cfg(unix)]
    #[test]
    fn child_does_not_inherit_home_or_project_executable() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let project = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let root = canonical(project.path()).unwrap();
        fs::write(root.join("cat"), "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(root.join("cat"), fs::Permissions::from_mode(0o755)).unwrap();
        symlink(root.join("cat"), bin.path().join("cat")).unwrap();
        assert!(check_program("cat", &[bin.path().to_path_buf()], &root).is_err());
        let req = request(&root, &[], &["cat"]);
        let mut cmd = prepare(&req, &root, super::super::shell(), "test -z \"${HOME+x}\"").unwrap();
        assert!(cmd.status().unwrap().success());
        assert!(inspect_tree(
            &root,
            &root,
            &mut HashSet::new(),
            Instant::now() - Duration::from_secs(2)
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn configured_git_helpers_do_not_execute() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        let git = |args: &[&str]| {
            let result = Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        };
        git(&["init", "-q"]);
        fs::write(root.join("note.md"), "before\n").unwrap();
        git(&["add", "note.md"]);
        fs::write(root.join("note.md"), "after\n").unwrap();
        fs::write(root.join(".gitattributes"), "*.md diff=custom\n").unwrap();
        git(&["config", "diff.custom.textconv", "touch marker-textconv"]);
        git(&["config", "diff.external", "touch marker-diff"]);
        git(&["config", "core.fsmonitor", "touch marker-monitor"]);
        let req = request(&root, &["."], &["git"]);
        for line in ["git diff --no-textconv --no-ext-diff", "git status --short"] {
            let cmd = prepare(&req, &root, super::super::shell(), line).unwrap();
            let result = super::super::execute_built(
                super::super::shell(),
                &super::super::Running::default(),
                "safe-read",
                cmd,
                Duration::from_secs(10),
            )
            .unwrap();
            assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
        }
        git(&["config", "filter.custom.clean", "touch marker-clean"]);
        fs::write(root.join(".gitattributes"), "*.md filter=custom\n").unwrap();
        for line in ["git status --short", "git diff --no-textconv --no-ext-diff"] {
            assert!(prepare(&req, &root, super::super::shell(), line).is_err());
        }
        assert!(!root.join("marker-clean").exists());
        for path in ["marker-textconv", "marker-diff", "marker-monitor"] {
            assert!(!root.join(path).exists());
        }
    }
}
