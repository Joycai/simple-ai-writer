use crate::scope::FsScope;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::{command, State};

#[derive(Serialize, Deserialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
}

/// Categories a project is scaffolded with when the frontend passes none —
/// the built-in "novel" profile, kept in sync with `NOVEL_PROFILE` in
/// `src/lib/profile/model.ts`. Only reached by an older frontend calling
/// without the argument; the app always sends the active profile's list.
const DEFAULT_LORE_CATEGORIES: [&str; 7] = [
    "characters",
    "world",
    "factions",
    "items",
    "skills",
    "style",
    "custom",
];

/// A lore category id is a single directory name, so it must be one path
/// component of `[A-Za-z0-9][A-Za-z0-9_-]*`, at most 40 characters.
///
/// The frontend validates this too (`parseProfile`), but that check is
/// convenience: `profile.json` is hand-editable and reaches us through the
/// webview, so a name like `..` or `a/b` would otherwise let a crafted profile
/// create directories outside `.ai-writer/lore`. Validate here as well — this
/// side is the boundary that has to hold.
///
/// The rule is deliberately identical to `CATEGORY_ID_RE` in
/// `src/lib/profile/model.ts`, down to requiring an alphanumeric first
/// character. Being *looser* here is not a safety hole, but it does create a
/// folder the frontend then silently drops from the profile — so a category the
/// author wrote by hand would exist on disk and never appear in the app.
fn valid_category(name: &str) -> bool {
    let mut chars = name.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    name.len() <= 40 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Scaffold the .ai-writer directory structure inside a project folder.
///
/// `categories` comes from the project's workspace profile (see
/// `src/lib/profile`) and decides the `.ai-writer/lore/<category>` folders. It
/// is additive: switching a project's profile creates the new profile's folders
/// and leaves the old ones (and the entities in them) untouched on disk.
#[command]
pub fn scaffold_project(
    project_path: String,
    categories: Option<Vec<String>>,
    scope: State<'_, FsScope>,
) -> Result<(), String> {
    scope.check(&project_path)?;
    let root = Path::new(&project_path);

    let categories = categories.filter(|c| !c.is_empty()).unwrap_or_else(|| {
        DEFAULT_LORE_CATEGORIES
            .iter()
            .map(|s| s.to_string())
            .collect()
    });

    if let Some(bad) = categories.iter().find(|c| !valid_category(c)) {
        return Err(format!("Invalid lore category name: {bad}"));
    }

    let lore_root = root.join(".ai-writer").join("lore");
    let mut dirs = vec![root.join("writing"), root.join("output")];
    dirs.extend(categories.iter().map(|c| lore_root.join(c)));

    for dir in &dirs {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Write raw bytes to a file, creating it if it does not exist.
#[command]
pub fn fs_write_binary_file(
    path: String,
    data: Vec<u8>,
    scope: State<'_, FsScope>,
) -> Result<(), String> {
    scope.check(&path)?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, data).map_err(|e| e.to_string())
}

/// Write UTF-8 text to a file, creating it if it does not exist.
#[command]
pub fn fs_write_text_file(
    path: String,
    content: String,
    scope: State<'_, FsScope>,
) -> Result<(), String> {
    scope.check(&path)?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Read UTF-8 text from a file.
#[command]
pub fn fs_read_text_file(path: String, scope: State<'_, FsScope>) -> Result<String, String> {
    scope.check(&path)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Append UTF-8 text to a file, creating it (and parent dirs) if missing.
#[command]
pub fn fs_append_text_file(
    path: String,
    content: String,
    scope: State<'_, FsScope>,
) -> Result<(), String> {
    use std::io::Write;
    scope.check(&path)?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())
}

/// Create a directory and all missing parent directories.
#[command]
pub fn fs_create_dir(path: String, scope: State<'_, FsScope>) -> Result<(), String> {
    scope.check(&path)?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// Check whether a path exists.
#[command]
pub fn fs_exists(path: String, scope: State<'_, FsScope>) -> Result<bool, String> {
    scope.check(&path)?;
    Ok(Path::new(&path).exists())
}

/// Remove a directory and all its contents.
#[command]
pub fn fs_remove_dir(path: String, scope: State<'_, FsScope>) -> Result<(), String> {
    scope.check(&path)?;
    fs::remove_dir_all(&path).map_err(|e| e.to_string())
}

/// Rename / move a file or directory. Missing parent dirs of the target are
/// created so callers can move entities into not-yet-scaffolded folders.
#[command]
pub fn fs_rename(from: String, to: String, scope: State<'_, FsScope>) -> Result<(), String> {
    scope.check(&from)?;
    scope.check(&to)?;
    if let Some(parent) = Path::new(&to).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Remove a single file. Missing files are a no-op so callers can be tolerant.
#[command]
pub fn fs_remove_file(path: String, scope: State<'_, FsScope>) -> Result<(), String> {
    scope.check(&path)?;
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    fs::remove_file(p).map_err(|e| e.to_string())
}

/// List one level of a directory (name + is_dir). Returns [] if path doesn't exist.
#[command]
pub fn fs_read_dir(path: String, scope: State<'_, FsScope>) -> Result<Vec<FileNode>, String> {
    scope.check(&path)?;
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(vec![]);
    }
    let mut entries: Vec<FileNode> = fs::read_dir(p)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let name = e.file_name().to_string_lossy().to_string();
            let full_path = e.path().to_string_lossy().to_string();
            FileNode {
                name,
                path: full_path,
                is_dir,
                children: None,
            }
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// Recursively list files under a directory (max depth 5).
#[command]
pub fn read_dir_recursive(
    dir_path: String,
    scope: State<'_, FsScope>,
) -> Result<Vec<FileNode>, String> {
    scope.check(&dir_path)?;
    read_dir_inner(Path::new(&dir_path), 0)
}

fn read_dir_inner(path: &Path, depth: u8) -> Result<Vec<FileNode>, String> {
    if depth > 5 {
        return Ok(vec![]);
    }

    let mut entries: Vec<FileNode> = fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            // skip all hidden files/dirs (dotfiles)
            let name = e.file_name();
            !name.to_string_lossy().starts_with('.')
        })
        .map(|e| {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let name = e.file_name().to_string_lossy().to_string();
            let full_path = e.path().to_string_lossy().to_string();
            let children = if is_dir {
                read_dir_inner(&e.path(), depth + 1).ok()
            } else {
                None
            };
            FileNode {
                name,
                path: full_path,
                is_dir,
                children,
            }
        })
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::valid_category;

    #[test]
    fn accepts_plain_category_names() {
        for name in ["characters", "npcs", "world_2", "side-quests", "a"] {
            assert!(valid_category(name), "{name} should be accepted");
        }
    }

    #[test]
    fn rejects_names_that_are_not_a_single_path_component() {
        // The whole point of the check: a crafted profile.json must not be able
        // to steer directory creation out of .ai-writer/lore.
        for name in ["", "..", ".", "a/b", r"a\b", "../../etc", "C:", "a b", "él"] {
            assert!(!valid_category(name), "{name:?} should be rejected");
        }
    }

    #[test]
    fn rejects_absurdly_long_names() {
        assert!(!valid_category(&"a".repeat(41)));
        assert!(valid_category(&"a".repeat(40)));
    }

    #[test]
    fn requires_an_alphanumeric_first_character() {
        // Matches CATEGORY_ID_RE on the frontend. Accepting these would create a
        // folder that `parseProfile` then drops, leaving a category on disk that
        // the app never shows.
        for name in ["_scratch", "-npcs", "__", "-"] {
            assert!(!valid_category(name), "{name:?} should be rejected");
        }
        assert!(valid_category("npcs_2"));
        assert!(valid_category("side-quests"));
    }
}
