//! Runtime path scoping for the custom `fs_*` / project commands.
//!
//! The custom commands in `commands.rs` would otherwise accept any absolute
//! path, so a compromised webview could read/write/delete arbitrary files.
//! Roots are registered only from trusted sources:
//!   - the native folder picker (`project_open_dialog`),
//!   - an existing project re-opened from the recents list
//!     (`project_register_root`, which requires an `.ai-writer` marker on disk
//!     that the webview cannot create outside an already-allowed root),
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
use std::sync::Mutex;
use tauri::command;

/// Managed state holding the allowed root directories.
pub struct FsScope {
    roots: Mutex<Vec<PathBuf>>,
}

impl FsScope {
    pub fn new() -> Self {
        Self {
            roots: Mutex::new(Vec::new()),
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

/// Open the native folder picker and register the selection as an allowed
/// root. Doing the pick on the Rust side is what makes the scope trustworthy:
/// the webview can only ever get a root the user explicitly chose.
#[command]
pub async fn project_open_dialog(
    app: tauri::AppHandle,
    scope: tauri::State<'_, FsScope>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    match picked {
        Some(file_path) => {
            let path = file_path.into_path().map_err(|e| e.to_string())?;
            scope.allow_for_plugin_fs(&app, &path);
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

/// Register a previously-created project (re-opened from the recents list).
/// Requires the on-disk `.ai-writer` marker: the webview cannot fabricate it
/// outside an already-allowed root, so arbitrary directories stay off-limits.
#[command]
pub fn project_register_root(
    path: String,
    app: tauri::AppHandle,
    scope: tauri::State<'_, FsScope>,
) -> Result<(), String> {
    let root = Path::new(&path);
    if !root.is_absolute() || !root.join(".ai-writer").is_dir() {
        return Err("Not an existing project folder (missing .ai-writer)".into());
    }
    scope.allow_for_plugin_fs(&app, root);
    Ok(())
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

    // Symlink APIs (and CI) are Unix-only today — see docs/ci.md, the Rust CI
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
