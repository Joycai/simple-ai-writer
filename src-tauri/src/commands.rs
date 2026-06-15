use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};
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
            // skip hidden files except .ai-writer root
            let name = e.file_name();
            let name_str = name.to_string_lossy();
            !name_str.starts_with('.') || name_str == ".ai-writer"
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
            FileNode { name, path: full_path, is_dir, children }
        })
        .collect();

    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        }
    });

    Ok(entries)
}
