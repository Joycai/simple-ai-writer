//! Runtime path scoping for the custom `fs_*` / project commands.
//!
//! The custom commands in `commands.rs` would otherwise accept any absolute
//! path, so a compromised webview could read/write/delete arbitrary files.
//! Roots are registered only from trusted sources:
//!   - the native folder picker (`project_open_dialog`),
//!   - an existing project re-opened from the recents list
//!     (`project_register_root`, which requires an `.ai-writer` marker on disk
//!     that the webview cannot create outside an already-allowed root; the
//!     store build additionally restores an OS bookmark before that check),
//!   - the app's own data/log directories, seeded at startup in `lib.rs`.
//!
//! `capabilities/default.json` grants no static `fs:scope` — `tauri-plugin-fs`
//! (used directly by the frontend for a handful of binary image reads; see
//! `src/lib/fs/images.ts`) starts with an empty scope of its own. Freshly
//! dialog-picked paths (lore avatar/gallery imports) are auto-scoped by the
//! dialog plugin for that session; `allow_for_plugin_fs` below additionally
//! extends the plugin's scope to a registered project root, so images already
//! imported into the project keep loading after it's reopened.
//!
//! That second scope is glob-based and does **not** share this one's
//! semantics — most notably it will not let a wildcard match `.ai-writer`, so
//! granting a root is not enough to read anything inside it. See
//! `allow_for_plugin_fs`.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::command;

/// Managed state holding the allowed root directories.
///
/// `Clone` shares the one list (an `Arc`), it does not copy it: the `fs_*`
/// commands run their work on the blocking pool (`crate::blocking`), which
/// needs an owned handle to move into the task, and a root allowed after the
/// clone must still count — the handle is the same scope, not a snapshot.
#[derive(Clone)]
pub struct FsScope {
    roots: Arc<Mutex<Vec<PathBuf>>>,
}

impl FsScope {
    pub fn new() -> Self {
        Self {
            roots: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Register a directory as an allowed root.
    pub fn allow(&self, root: &Path) {
        let normalized = resolve_symlinks(root);
        let mut roots = self.roots.lock().unwrap();
        if !roots.iter().any(|r| r == &normalized) {
            roots.push(normalized);
        }
    }

    /// `allow`, plus extending `tauri-plugin-fs`'s own runtime scope to cover
    /// `root` — see the module doc comment for why that's needed alongside
    /// this scope. Best-effort: a failure here would only affect the plugin's
    /// `readFile` (image previews), never the custom `fs_*` commands this
    /// scope actually guards.
    pub fn allow_for_plugin_fs<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>, root: &Path) {
        self.allow(root);
        use tauri_plugin_fs::FsExt;
        let scope = app.fs_scope();
        let _ = scope.allow_directory(root, true);
        // `<root>/**` does not cover `<root>/.ai-writer/…`, and that is not a
        // typo: the plugin's *runtime* scope is built from `FsScope::default()`,
        // which on unix means glob matching with `require_literal_leading_dot:
        // true` — a `*` or `**` refuses to match a path component that starts
        // with a dot, so the pattern has to spell `.ai-writer` out. (The
        // `requireLiteralLeadingDot` knob in `tauri.conf.json` cannot help: it
        // only reaches the per-call scope built from static capability entries,
        // never this one.) Everything the frontend reads through
        // `tauri-plugin-fs` lives under that dot-directory — lore galleries and
        // avatars, and the image session's scratch candidates — so without this
        // second grant every one of those reads fails with "forbidden path"
        // while ordinary documents load fine.
        let _ = scope.allow_directory(root.join(".ai-writer"), true);
    }

    /// True when `path` is absolute and inside one of the allowed roots.
    /// `..`/`.` components are resolved lexically first so traversal cannot
    /// escape a root, real symlinks along the way are resolved too (so a
    /// symlink planted inside a root can't point back out of it), and
    /// `Path::starts_with` compares whole components so a sibling like
    /// `/project-evil` never matches the root `/project`.
    pub fn is_allowed(&self, path: &Path) -> bool {
        if !path.is_absolute() {
            return false;
        }
        let normalized = resolve_symlinks(path);
        let roots = self.roots.lock().unwrap();
        roots.iter().any(|root| normalized.starts_with(root))
    }

    /// Command-friendly guard: `Err` with a readable message when out of scope.
    pub fn check(&self, path: &str) -> Result<(), String> {
        if self.is_allowed(Path::new(path)) {
            Ok(())
        } else {
            Err(format!("Path is outside the allowed scope: {path}"))
        }
    }
}

/// Lexically resolve `.` and `..` without touching the filesystem.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // `pop` is a no-op at the root, so `/..` cannot climb above `/`.
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve real symlinks along `path`, in addition to the lexical `.`/`..`
/// resolution `normalize` already does. `normalize` alone lets a symlink that
/// lives *inside* an allowed root but points outside it defeat the
/// containment check: the lexical form still reads as "inside," while the OS
/// follows the link out when the file is actually opened.
///
/// `fs::canonicalize` needs the whole path to exist, which a to-be-created
/// file doesn't — the common case for a write. So this walks up from `path`
/// (after lexical normalization, so no `.`/`..` component ever reaches
/// `canonicalize`) to the nearest ancestor that does exist, resolves *that*
/// through the filesystem, and re-appends the not-yet-existing tail
/// unchanged. `path`'s absoluteness guarantees the walk terminates: the
/// filesystem root always exists and canonicalizes successfully.
fn resolve_symlinks(path: &Path) -> PathBuf {
    let normalized = normalize(path);
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut existing: &Path = &normalized;
    loop {
        match existing.canonicalize() {
            Ok(mut real) => {
                for component in tail.iter().rev() {
                    real.push(component);
                }
                return real;
            }
            Err(_) => match (existing.parent(), existing.file_name()) {
                (Some(parent), Some(name)) => {
                    tail.push(name);
                    existing = parent;
                }
                // Nothing on the path exists (not even the filesystem root —
                // unreachable in practice). Fall back to the lexical form
                // rather than granting access on a resolution failure.
                _ => return normalized,
            },
        }
    }
}

/// Check a project-internal target against this project, not the union of all
/// previously opened roots (which also includes the app's config directory).
#[cfg(any(test, all(target_os = "macos", feature = "app-store")))]
pub(crate) fn check_project_target(root: &Path, target: &Path) -> Result<(), String> {
    let relative = target.strip_prefix(root).map_err(|e| e.to_string())?;
    let mut cursor = root.to_path_buf();
    for part in relative.components() {
        if matches!(part, Component::ParentDir) {
            return Err("Project metadata escapes the authorized folder".into());
        }
        cursor.push(part);
        match std::fs::symlink_metadata(&cursor) {
            // Metadata must be local. Reject dangling links as well: canonicalize
            // cannot resolve them, but a later write would follow their target.
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("PROJECT_ACCESS_UNSAFE_METADATA".into());
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("PROJECT_ACCESS_REQUIRED: {e}")),
        }
    }
    Ok(())
}

#[cfg(all(target_os = "macos", feature = "app-store"))]
fn check_project_metadata(root: &Path) -> Result<(), String> {
    for name in [
        ".ai-writer",
        ".ai-writer/project.db",
        ".ai-writer/project.db-wal",
        ".ai-writer/project.db-shm",
        ".ai-writer/project.db-journal",
        ".ai-writer/window.lock",
    ] {
        check_project_target(root, &root.join(name))?;
    }
    Ok(())
}

/// Pick on the native side: only this trusted result may mint a bookmark.
async fn pick_root(
    app: tauri::AppHandle,
    scope: FsScope,
    expected: Option<String>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut dialog = app.dialog().file();
    if let Some(title) = title {
        dialog = dialog.set_title(title);
    }
    if let Some(path) = &expected {
        dialog = dialog.set_directory(path);
    }
    dialog.pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    crate::blocking::blocking(move || {
        let Some(file_path) = rx.recv().map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        let path = file_path.into_path().map_err(|e| e.to_string())?;
        if let Some(expected) = expected {
            // Reauthorization never silently switches to or scaffolds another
            // folder. Canonicalize only after Powerbox has granted access.
            if resolve_symlinks(&path) != resolve_symlinks(Path::new(&expected)) {
                return Err("PROJECT_ACCESS_WRONG_FOLDER".into());
            }
            if !path.join(".ai-writer").is_dir() {
                return Err("PROJECT_ACCESS_MISSING_PROJECT".into());
            }
        }
        #[cfg(all(target_os = "macos", feature = "app-store"))]
        {
            use tauri::Manager;
            check_project_metadata(&path)?;
            app.state::<crate::bookmarks::Bookmarks>()
                .selected(&app, &path)
                .map_err(|e| format!("PROJECT_ACCESS_REQUIRED: {e}"))?;
        }
        scope.allow_for_plugin_fs(&app, &path);
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

#[command]
pub async fn project_open_dialog(
    app: tauri::AppHandle,
    scope: tauri::State<'_, FsScope>,
) -> Result<Option<String>, String> {
    pick_root(app, scope.inner().clone(), None, None).await
}

#[command]
pub async fn project_reauthorize(
    path: String,
    title: String,
    app: tauri::AppHandle,
    scope: tauri::State<'_, FsScope>,
) -> Result<Option<String>, String> {
    pick_root(app, scope.inner().clone(), Some(path), Some(title)).await
}

/// Restore the OS grant BEFORE probing the project marker or allowing any I/O.
/// Direct distribution retains its existing marker-based registration.
#[command]
pub async fn project_register_root(
    path: String,
    app: tauri::AppHandle,
    scope: tauri::State<'_, FsScope>,
) -> Result<String, String> {
    let scope = scope.inner().clone();
    crate::blocking::blocking(move || {
        let root = PathBuf::from(&path);
        #[cfg(all(target_os = "macos", feature = "app-store"))]
        let root = {
            use tauri::Manager;
            app.state::<crate::bookmarks::Bookmarks>()
                .restore(&app, &root)
                .map_err(|e| format!("PROJECT_ACCESS_REQUIRED: {e}"))?
        };
        if !root.is_absolute() || !root.join(".ai-writer").is_dir() {
            #[cfg(all(target_os = "macos", feature = "app-store"))]
            return Err("PROJECT_ACCESS_REQUIRED: Project is missing or inaccessible".into());
            #[cfg(not(all(target_os = "macos", feature = "app-store")))]
            return Err("Not an existing project folder (missing .ai-writer)".into());
        }
        #[cfg(all(target_os = "macos", feature = "app-store"))]
        check_project_metadata(&root)?;
        scope.allow_for_plugin_fs(&app, &root);
        Ok(root.to_string_lossy().into_owned())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    // `is_allowed` rejects anything non-absolute, and absoluteness is
    // platform-specific: on Windows `/home/user/project` has no drive letter
    // and is *not* absolute, so the fixtures below are chosen per platform.
    // Suffixes use `/`, which both platforms parse as a separator.
    #[cfg(windows)]
    const ROOT: &str = r"C:\Users\dev\project";
    #[cfg(unix)]
    const ROOT: &str = "/home/user/project";

    /// An absolute path that is nowhere near `ROOT`.
    #[cfg(windows)]
    const UNRELATED: &str = r"C:\Windows\System32\config";
    #[cfg(unix)]
    const UNRELATED: &str = "/etc/passwd";

    fn scope_at_root() -> FsScope {
        let s = FsScope::new();
        s.allow(Path::new(ROOT));
        s
    }

    /// `ROOT/<suffix>` — the separator is added for you.
    fn under(suffix: &str) -> PathBuf {
        Path::new(ROOT).join(suffix)
    }

    /// A path next to `ROOT` under the same parent, e.g. `other`.
    fn sibling(name: &str) -> PathBuf {
        Path::new(ROOT).parent().unwrap().join(name)
    }

    #[cfg(unix)]
    #[test]
    fn project_metadata_cannot_escape_into_another_allowed_root() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        symlink(other.path(), root.path().join(".ai-writer")).unwrap();
        assert!(
            check_project_target(root.path(), &root.path().join(".ai-writer/project.db")).is_err()
        );
        assert!(check_project_target(root.path(), &root.path().join("new/file.md")).is_ok());
        symlink(
            other.path().join("not-created"),
            root.path().join("dangling"),
        )
        .unwrap();
        assert!(check_project_target(root.path(), &root.path().join("dangling")).is_err());
    }

    #[test]
    fn allows_paths_inside_a_registered_root() {
        let s = scope_at_root();
        assert!(s.is_allowed(&under("writing/ch1.md")));
        assert!(s.is_allowed(Path::new(ROOT)));
    }

    #[test]
    fn rejects_paths_outside_any_root() {
        let s = scope_at_root();
        assert!(!s.is_allowed(Path::new(UNRELATED)));
        assert!(!s.is_allowed(&sibling("other")));
    }

    #[test]
    fn rejects_sibling_directories_sharing_the_root_as_prefix() {
        let s = scope_at_root();
        assert!(!s.is_allowed(&PathBuf::from(format!("{ROOT}-evil")).join("x.md")));
    }

    #[test]
    fn rejects_dotdot_traversal_out_of_a_root() {
        let s = scope_at_root();
        assert!(!s.is_allowed(&under("../../../etc/passwd")));
        assert!(!s.is_allowed(&under("../other/file.md")));
        // Traversal that stays inside the root is fine.
        assert!(s.is_allowed(&under("writing/../lore/a.md")));
    }

    #[test]
    fn rejects_relative_paths() {
        let s = scope_at_root();
        assert!(!s.is_allowed(Path::new("writing/ch1.md")));
        assert!(!s.is_allowed(Path::new("./project")));
    }

    #[test]
    fn normalize_cannot_climb_above_filesystem_root() {
        #[cfg(windows)]
        assert_eq!(
            normalize(Path::new(r"C:\..\..\Windows")),
            PathBuf::from(r"C:\Windows")
        );
        #[cfg(unix)]
        assert_eq!(normalize(Path::new("/../../etc")), PathBuf::from("/etc"));
    }

    /// Unique scratch dir under the OS temp dir, for the symlink tests below
    /// (which need real filesystem entries — `canonicalize` requires it).
    /// Mirrors `transfer::tests::scratch`.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("saw-scope-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // Symlink APIs (and CI) are Unix-only today — see docs/reference/ci.md, the Rust CI
    // job runs on ubuntu-latest — so these are gated rather than also reached
    // for on Windows via `std::os::windows::fs::symlink_dir`, which needs
    // elevated privileges to create.
    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_planted_inside_a_root_that_points_outside_it() {
        use std::os::unix::fs::symlink;

        let root = scratch("escape-root");
        let outside = scratch("escape-outside");
        std::fs::create_dir_all(root.join("writing")).unwrap();

        // e.g. a maliciously crafted imported bundle, or an attacker with
        // some existing foothold inside the project folder.
        symlink(&outside, root.join("writing/escape")).unwrap();

        let s = FsScope::new();
        s.allow(&root);

        assert!(s.is_allowed(&root.join("writing/normal.md")));
        assert!(!s.is_allowed(&root.join("writing/escape/secret.md")));
    }

    /// The other scope: `tauri-plugin-fs`'s, which guards the frontend's direct
    /// binary image reads and matches with globs rather than components. On
    /// unix its runtime scope uses `require_literal_leading_dot: true`, so
    /// granting a project root does **not** reach anything under
    /// `<root>/.ai-writer/` — every generated picture the app renders. That
    /// asymmetry is invisible in our own code, so assert it against the real
    /// plugin rather than trusting the comment in `allow_for_plugin_fs`.
    #[test]
    fn plugin_fs_scope_reaches_into_the_dot_ai_writer_directory() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_fs::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");

        let root = scratch("plugin-fs-scope");
        std::fs::create_dir_all(root.join(".ai-writer/tmp/imagegen/sess")).unwrap();
        std::fs::create_dir_all(root.join("writing")).unwrap();
        let picture = root.join(".ai-writer/tmp/imagegen/sess/cand-0.png");
        let document = root.join("writing/ch1.md");
        for f in [&picture, &document] {
            std::fs::write(f, b"x").unwrap();
        }

        let scope = FsScope::new();
        scope.allow_for_plugin_fs(app.handle(), &root);

        use tauri_plugin_fs::FsExt;
        let plugin = app.fs_scope();
        // The plain document is what `allow_directory(root, true)` already
        // covered; the picture is what needs the second, dot-literal grant.
        assert!(plugin.is_allowed(&document));
        assert!(plugin.is_allowed(&picture));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn allows_a_registered_root_that_is_itself_a_symlink() {
        use std::os::unix::fs::symlink;

        let real = scratch("root-real");
        let link = scratch("root-link-parent").join("project");
        symlink(&real, &link).unwrap();

        let s = FsScope::new();
        s.allow(&link);

        // Queried through the symlink or the resolved real path, both must
        // agree — otherwise a project whose picked folder sits behind a
        // symlink (common on macOS: /tmp -> /private/tmp) would have every
        // one of its own files rejected as "outside scope".
        assert!(s.is_allowed(&link.join("writing/ch1.md")));
        assert!(s.is_allowed(&real.join("writing/ch1.md")));
    }
}
