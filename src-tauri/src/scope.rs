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
        let normalized = normalize(root);
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
    pub fn allow_for_plugin_fs(&self, app: &tauri::AppHandle, root: &Path) {
        self.allow(root);
        use tauri_plugin_fs::FsExt;
        let _ = app.fs_scope().allow_directory(root, true);
    }

    /// True when `path` is absolute and inside one of the allowed roots.
    /// `..`/`.` components are resolved lexically first so traversal cannot
    /// escape a root, and `Path::starts_with` compares whole components so a
    /// sibling like `/project-evil` never matches the root `/project`.
    pub fn is_allowed(&self, path: &Path) -> bool {
        if !path.is_absolute() {
            return false;
        }
        let normalized = normalize(path);
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
}
