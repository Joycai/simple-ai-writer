//! Content hashing for knowledge-base entries.
//!
//! One lore entity is a *directory* (`index.md`, its facet files, `images.md`,
//! an avatar, gallery pictures). Syncing it to the backup server needs a single
//! value that changes when any of that changes and does not change otherwise —
//! that is what `hash_entry_dir` produces, and it is the identity the server
//! stores and the client's three-way comparison runs on
//! (`docs/remote-knowledge-base-feasibility.md` §14.2, §15).
//!
//! ## The hash is a wire format
//!
//! Two machines must compute the same value for the same content, and a value
//! computed by an older build must still match one from a newer build — a
//! change here silently reports every entry as modified on every client. So the
//! rules are fixed:
//!
//! - **sha256, lowercase hex.** The server validates that shape.
//! - **Files are sorted by relative path**, compared as UTF-8 bytes. Directory
//!   order from the filesystem is not stable across platforms.
//! - **Content is length-prefixed.** Without it, `a.md`+`b.md` holding `"xy"`
//!   and `""` would hash the same as `""` and `"xy"`.
//! - **Only the contents count, never the entity's own directory name.**
//!   Renaming an entry moves it to a different path; it does not make it a
//!   different entry, and the path travels separately in the manifest.
//! - **mtime, permissions and file order are not hashed.** They differ across
//!   machines and survive no round trip through a zip.
//! - **Dotfiles are skipped, at every level.** macOS writes `.DS_Store` into
//!   folders the author merely looked at; hashing it would report an entry as
//!   changed because someone opened Finder. The zip built for upload skips them
//!   on the same rule, so what is hashed is exactly what is transmitted — if
//!   the two lists ever diverge, a pulled entry would hash differently than the
//!   one that was pushed and every sync would show it as conflicted.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::command;

use crate::scope::FsScope;

/// Paths inside an entry directory that are never part of its content.
/// Matched on the file name, so the rule applies at every depth.
fn is_ignored(name: &str) -> bool {
    name.starts_with('.')
}

/// Collect `(relative path, absolute path)` for every file under `dir`, sorted
/// by relative path. Unreadable subdirectories are skipped rather than fatal:
/// a hash of what can be read is still a stable description of it, and the
/// upload zip skips exactly the same files.
fn collect_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored(&name) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            walk(base, &path, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            let rel = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push((rel, path));
        }
    }
}

/// The content hash of one entry directory. See the module docs for the rules.
pub fn hash_entry_dir(dir: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    for (rel, path) in collect_files(dir) {
        let bytes =
            fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
        hasher.update(rel.as_bytes());
        hasher.update([0u8]);
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Serialize)]
pub struct EntryHash {
    pub category: String,
    pub id: String,
    pub hash: String,
}

/// Hash every entry under a lore root (`<project>/.ai-writer/lore`), in one
/// call.
///
/// Batched deliberately: a project can hold hundreds of entries, and one IPC
/// hop per entry would make opening the sync screen visibly slow for no reason.
/// Every `<category>/<entity>` directory is reported; deciding which category
/// ids are real is the frontend's job, because that rule lives in the workspace
/// profile (`CATEGORY_ID_RE` and the enabled packs) and duplicating it here
/// would give the app two answers that can drift apart.
#[command]
pub fn lore_tree_hashes(
    path: String,
    scope: tauri::State<'_, FsScope>,
) -> Result<Vec<EntryHash>, String> {
    scope.check(&path)?;
    let root = Path::new(&path);
    let mut out = Vec::new();

    let Ok(categories) = fs::read_dir(root) else {
        // No lore directory yet — a project with no knowledge base at all.
        return Ok(out);
    };
    for category in categories.flatten() {
        if !category.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let cat_name = category.file_name().to_string_lossy().into_owned();
        if is_ignored(&cat_name) {
            continue;
        }
        let Ok(entities) = fs::read_dir(category.path()) else {
            continue;
        };
        for entity in entities.flatten() {
            if !entity.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let id = entity.file_name().to_string_lossy().into_owned();
            if is_ignored(&id) {
                continue;
            }
            out.push(EntryHash {
                category: cat_name.clone(),
                id,
                hash: hash_entry_dir(&entity.path())?,
            });
        }
    }

    out.sort_by(|a, b| {
        (a.category.as_str(), a.id.as_str()).cmp(&(b.category.as_str(), b.id.as_str()))
    });
    Ok(out)
}

/// The content hash of one entry directory, for verifying a single entry after
/// it was written (a pull unpacks a zip and must confirm what landed matches
/// what the server said it was sending).
#[command]
pub fn lore_entry_hash(path: String, scope: tauri::State<'_, FsScope>) -> Result<String, String> {
    scope.check(&path)?;
    hash_entry_dir(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, rel: &str, content: &[u8]) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn identical_content_hashes_identically() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        for dir in [a.path(), b.path()] {
            write(dir, "index.md", b"---\nname: Alice\n---\n");
            write(dir, "outfit-armor.md", b"steel");
        }
        assert_eq!(
            hash_entry_dir(a.path()).unwrap(),
            hash_entry_dir(b.path()).unwrap()
        );
    }

    #[test]
    fn the_entity_directory_name_is_not_part_of_the_hash() {
        // Renaming an entry moves it; it does not change what it says.
        let parent = tempfile::tempdir().unwrap();
        let alice = parent.path().join("alice");
        let renamed = parent.path().join("alice-feng");
        fs::create_dir_all(&alice).unwrap();
        write(&alice, "index.md", b"body");
        let before = hash_entry_dir(&alice).unwrap();
        fs::rename(&alice, &renamed).unwrap();
        assert_eq!(hash_entry_dir(&renamed).unwrap(), before);
    }

    #[test]
    fn any_content_change_moves_the_hash() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "index.md", b"one");
        let base = hash_entry_dir(dir.path()).unwrap();

        write(dir.path(), "index.md", b"two");
        assert_ne!(hash_entry_dir(dir.path()).unwrap(), base);

        write(dir.path(), "index.md", b"one");
        assert_eq!(hash_entry_dir(dir.path()).unwrap(), base);

        write(dir.path(), "extra.md", b"");
        assert_ne!(
            hash_entry_dir(dir.path()).unwrap(),
            base,
            "adding an empty file is still a change"
        );
    }

    #[test]
    fn content_is_length_prefixed_so_boundaries_cannot_be_confused() {
        // Without the length prefix these two directories would feed the hasher
        // the same byte stream.
        let a = tempfile::tempdir().unwrap();
        write(a.path(), "a.md", b"xy");
        write(a.path(), "b.md", b"");

        let b = tempfile::tempdir().unwrap();
        write(b.path(), "a.md", b"");
        write(b.path(), "b.md", b"xy");

        assert_ne!(
            hash_entry_dir(a.path()).unwrap(),
            hash_entry_dir(b.path()).unwrap()
        );
    }

    #[test]
    fn dotfiles_are_ignored_at_every_level() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "index.md", b"body");
        let base = hash_entry_dir(dir.path()).unwrap();

        // What macOS drops into a folder the author merely opened.
        write(dir.path(), ".DS_Store", b"junk");
        write(dir.path(), "sub/.DS_Store", b"junk");
        assert_eq!(hash_entry_dir(dir.path()).unwrap(), base);
    }

    #[test]
    fn nested_files_count_and_are_ordered_by_path() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "index.md", b"i");
        write(dir.path(), "gallery/one.png", b"\x89PNG");
        let with_nested = hash_entry_dir(dir.path()).unwrap();

        let flat = tempfile::tempdir().unwrap();
        write(flat.path(), "index.md", b"i");
        // Same bytes, different location — a different entry.
        write(flat.path(), "one.png", b"\x89PNG");
        assert_ne!(hash_entry_dir(flat.path()).unwrap(), with_nested);
    }

    #[test]
    fn an_empty_or_missing_directory_hashes_to_the_empty_digest() {
        let dir = tempfile::tempdir().unwrap();
        let empty = hash_entry_dir(dir.path()).unwrap();
        assert_eq!(
            empty,
            hash_entry_dir(&dir.path().join("does-not-exist")).unwrap(),
            "an unreadable directory must not be a different kind of answer"
        );
        assert_eq!(empty.len(), 64);
    }
}
