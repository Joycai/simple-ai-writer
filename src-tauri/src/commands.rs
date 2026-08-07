use crate::scope::FsScope;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
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
///
/// `data` is **base64**, not a JSON array of numbers. The IPC payload is JSON
/// either way, and a 4 MB PNG as `[137,80,78,71,...]` is roughly 15 million
/// characters for serde to parse element by element; the same image as base64
/// is about 5.5 million and decodes in one pass. A session of conversational
/// image editing writes every candidate of every round, so this is the hot
/// path it looks like it isn't.
#[command]
pub fn fs_write_binary_file(
    path: String,
    data: String,
    scope: State<'_, FsScope>,
) -> Result<(), String> {
    scope.check(&path)?;
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("not valid base64: {e}"))?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, bytes).map_err(|e| e.to_string())
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

/// True when `target` is `base` itself or lives inside it, compared on whole
/// path components after normalization.
///
/// Copying a directory into its own subtree would otherwise recurse forever,
/// writing until the disk fills. The frontend refuses such a drop too, but this
/// is the side that has to hold: `fs_copy` takes two arbitrary paths.
fn is_within(base: &Path, target: &Path) -> bool {
    let b: Vec<_> = base.components().collect();
    let t: Vec<_> = target.components().collect();
    t.len() >= b.len() && t[..b.len()] == b[..]
}

/// Copy a file, or a directory with everything under it. The destination must
/// not already exist — the caller picks a free name (see `resolveCopyTarget` in
/// `src/lib/fs/moveCopy.ts`), so silently merging into or overwriting an
/// existing entry is never what was meant.
#[command]
pub fn fs_copy(from: String, to: String, scope: State<'_, FsScope>) -> Result<(), String> {
    scope.check(&from)?;
    scope.check(&to)?;
    let src = Path::new(&from);
    let dst = Path::new(&to);

    if !src.exists() {
        return Err(format!("Source does not exist: {from}"));
    }
    if dst.exists() {
        return Err(format!("Destination already exists: {to}"));
    }
    if src.is_dir() && is_within(src, dst) {
        return Err("Cannot copy a folder into itself.".to_string());
    }

    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if src.is_dir() {
        copy_dir_all(src, dst)
    } else {
        fs::copy(src, dst).map(|_| ()).map_err(|e| e.to_string())
    }
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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
    use super::{is_within, valid_category};
    use std::path::Path;

    #[test]
    fn is_within_matches_on_whole_components() {
        let base = Path::new("/project/writing/卷一");
        assert!(is_within(base, base), "a path contains itself");
        assert!(is_within(base, Path::new("/project/writing/卷一/第1章.md")));
        assert!(is_within(
            base,
            Path::new("/project/writing/卷一/子卷/深处")
        ));
        // The prefix-string trap: a sibling that merely starts with the name.
        assert!(!is_within(base, Path::new("/project/writing/卷一-备份")));
        assert!(!is_within(base, Path::new("/project/writing/卷二")));
        assert!(!is_within(base, Path::new("/project/writing")));
    }

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
