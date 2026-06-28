use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::command;

#[derive(Serialize, Deserialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
}

/// Scaffold the .ai-writer directory structure inside a project folder.
#[command]
pub fn scaffold_project(project_path: String) -> Result<(), String> {
    let root = Path::new(&project_path);

    let dirs = [
        root.join("writing"),
        root.join("output"),
        root.join(".ai-writer").join("lore").join("characters"),
        root.join(".ai-writer").join("lore").join("world"),
        root.join(".ai-writer").join("lore").join("factions"),
        root.join(".ai-writer").join("lore").join("items"),
        root.join(".ai-writer").join("lore").join("skills"),
        root.join(".ai-writer").join("lore").join("custom"),
    ];

    for dir in &dirs {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Write raw bytes to a file, creating it if it does not exist.
#[command]
pub fn fs_write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, data).map_err(|e| e.to_string())
}

/// Write UTF-8 text to a file, creating it if it does not exist.
#[command]
pub fn fs_write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Read UTF-8 text from a file.
#[command]
pub fn fs_read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Create a directory and all missing parent directories.
#[command]
pub fn fs_create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// Check whether a path exists.
#[command]
pub fn fs_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

/// Remove a directory and all its contents.
#[command]
pub fn fs_remove_dir(path: String) -> Result<(), String> {
    fs::remove_dir_all(&path).map_err(|e| e.to_string())
}

/// Remove a single file. Missing files are a no-op so callers can be tolerant.
#[command]
pub fn fs_remove_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    fs::remove_file(p).map_err(|e| e.to_string())
}

/// List one level of a directory (name + is_dir). Returns [] if path doesn't exist.
#[command]
pub fn fs_read_dir(path: String) -> Result<Vec<FileNode>, String> {
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
pub fn read_dir_recursive(dir_path: String) -> Result<Vec<FileNode>, String> {
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
