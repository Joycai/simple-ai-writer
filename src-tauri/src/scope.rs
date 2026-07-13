//! Runtime path scoping for the custom `fs_*` / project commands.
//!
//! The plugin-level `fs:scope` in capabilities only covers `tauri-plugin-fs`;
//! the custom commands in `commands.rs` would otherwise accept any absolute
//! path, so a compromised webview could read/write/delete arbitrary files.
//! Roots are registered only from trusted sources:
//!   - the native folder picker (`project_open_dialog`),
//!   - an existing project re-opened from the recents list
//!     (`project_register_root`, which requires an `.ai-writer` marker on disk
//!     that the webview cannot create outside an already-allowed root),
//!   - the app's own data/log directories, seeded at startup in `lib.rs`.

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
            scope.allow(&path);
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

/// Register a previously-created project (re-opened from the recents list).
/// Requires the on-disk `.ai-writer` marker: the webview cannot fabricate it
/// outside an already-allowed root, so arbitrary directories stay off-limits.
#[command]
pub fn project_register_root(path: String, scope: tauri::State<'_, FsScope>) -> Result<(), String> {
    let root = Path::new(&path);
    if !root.is_absolute() || !root.join(".ai-writer").is_dir() {
        return Err("Not an existing project folder (missing .ai-writer)".into());
    }
    scope.allow(root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope_with(root: &str) -> FsScope {
        let s = FsScope::new();
        s.allow(Path::new(root));
        s
    }

    #[test]
    fn allows_paths_inside_a_registered_root() {
        let s = scope_with("/home/user/project");
        assert!(s.is_allowed(Path::new("/home/user/project/writing/ch1.md")));
        assert!(s.is_allowed(Path::new("/home/user/project")));
    }

    #[test]
    fn rejects_paths_outside_any_root() {
        let s = scope_with("/home/user/project");
        assert!(!s.is_allowed(Path::new("/etc/passwd")));
        assert!(!s.is_allowed(Path::new("/home/user/other")));
    }

    #[test]
    fn rejects_sibling_directories_sharing_the_root_as_prefix() {
        let s = scope_with("/home/user/project");
        assert!(!s.is_allowed(Path::new("/home/user/project-evil/x.md")));
    }

    #[test]
    fn rejects_dotdot_traversal_out_of_a_root() {
        let s = scope_with("/home/user/project");
        assert!(!s.is_allowed(Path::new("/home/user/project/../../../etc/passwd")));
        assert!(!s.is_allowed(Path::new("/home/user/project/../other/file.md")));
        // Traversal that stays inside the root is fine.
        assert!(s.is_allowed(Path::new("/home/user/project/writing/../lore/a.md")));
    }

    #[test]
    fn rejects_relative_paths() {
        let s = scope_with("/home/user/project");
        assert!(!s.is_allowed(Path::new("writing/ch1.md")));
        assert!(!s.is_allowed(Path::new("./project")));
    }

    #[test]
    fn normalize_cannot_climb_above_filesystem_root() {
        assert_eq!(normalize(Path::new("/../../etc")), PathBuf::from("/etc"));
    }
}
