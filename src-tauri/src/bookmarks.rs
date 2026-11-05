//! App-scoped grants stay local to this installation, never in project/config backups.
//! One atomic file per path avoids lost updates between independent app processes.
//! Leases live for the process: SQL pools, background saves and asset requests can
//! outlive the visible project. Exit releases them after workspace lock cleanup.
use objc2::{rc::Retained, runtime::Bool};
use objc2_foundation::{
    NSData, NSString, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

struct Lease(Retained<NSURL>);
impl Drop for Lease {
    fn drop(&mut self) {
        // Paired only with a successful start on this exact URL.
        unsafe { self.0.stopAccessingSecurityScopedResource() };
    }
}
#[derive(Default)]
pub struct Bookmarks(Mutex<HashMap<PathBuf, Lease>>);

fn key(path: &Path) -> String {
    let digest = Sha256::digest(path.as_os_str().as_encoded_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{hex}.bookmark")
}

/// The restored directory grant cannot authorize a symlink escape beneath it.
fn authorized_child(root: &Path, tail: &Path) -> Result<PathBuf, String> {
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    let child = root.join(tail).canonicalize().map_err(|e| e.to_string())?;
    if !child.starts_with(&canonical) {
        return Err("Project escapes the authorized directory".into());
    }
    Ok(child)
}
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("security-scoped-bookmarks"))
}
fn save(dir: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = dir.join(key(path));
    // Calls within a process are serialized by Bookmarks; other processes use
    // distinct temporary names and atomic replacement of only this one grant.
    let temp = file.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &file).map_err(|e| e.to_string())
}
fn create(url: &NSURL) -> Result<Vec<u8>, String> {
    url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
        NSURLBookmarkCreationOptions::WithSecurityScope,
        None,
        None,
    )
    .map(|data| data.to_vec())
    .map_err(|e| e.to_string())
}
fn resolve(bytes: &[u8]) -> Result<(Lease, bool), String> {
    let mut stale = Bool::NO;
    // Foundation writes to a live stack Bool; the URL is retained until stop.
    let url = unsafe {
        NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
            &NSData::with_bytes(bytes),
            NSURLBookmarkResolutionOptions::WithSecurityScope
                | NSURLBookmarkResolutionOptions::WithoutUI
                | NSURLBookmarkResolutionOptions::WithoutMounting,
            None,
            &mut stale,
        )
    }
    .map_err(|e| e.to_string())?;
    if !unsafe { url.startAccessingSecurityScopedResource() } {
        return Err("Security-scoped access was denied".into());
    }
    Ok((Lease(url), stale.as_bool()))
}
fn path_of(lease: &Lease) -> Result<PathBuf, String> {
    lease
        .0
        .path()
        .map(|p| PathBuf::from(p.to_string()))
        .ok_or("Bookmark has no file path".into())
}

impl Bookmarks {
    /// Only called with a native picker result, never a webview-provided path.
    pub fn selected(&self, app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
        let mut active = self.0.lock().unwrap();
        let url =
            NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&path.to_string_lossy()), true);
        let bytes = create(&url)?;
        let (lease, _) = resolve(&bytes)?;
        save(&directory(app)?, path, &bytes)?;
        active.insert(path.to_owned(), lease);
        Ok(())
    }

    pub fn restore(&self, app: &tauri::AppHandle, requested: &Path) -> Result<PathBuf, String> {
        if !requested.is_absolute()
            || requested
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("Invalid project path".into());
        }
        let mut active = self.0.lock().unwrap();
        let dir = directory(app)?;
        // A backup restored under a selected destination inherits that grant.
        // No filesystem probes outside the container before access starts.
        for ancestor in requested.ancestors() {
            let tail = requested
                .strip_prefix(ancestor)
                .map_err(|e| e.to_string())?;
            if let Some(lease) = active.get(ancestor) {
                return authorized_child(&path_of(lease)?, tail);
            }
            let bytes = match std::fs::read(dir.join(key(ancestor))) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.to_string()),
            };
            let (lease, stale) = resolve(&bytes)?;
            let actual = path_of(&lease)?;
            // Renew stale bookmarks while access is live. Keep the old alias so
            // a pinned/recent old path still resolves after a directory move.
            let bytes = if stale { create(&lease.0)? } else { bytes };
            save(&dir, ancestor, &bytes)?;
            save(&dir, &actual, &bytes)?;
            let result = authorized_child(&actual, tail)?;
            active.insert(ancestor.to_owned(), lease);
            return Ok(result);
        }
        Err("No saved folder authorization".into())
    }

    pub fn release_all(&self) {
        self.0.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restored_parent_cannot_authorize_a_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("child")).unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        assert!(authorized_child(root.path(), Path::new("child")).is_ok());
        assert!(authorized_child(root.path(), Path::new("escape")).is_err());
        assert!(authorized_child(root.path(), Path::new("missing")).is_err());
    }

    #[test]
    fn path_keys_do_not_collide_on_prefixes_or_unicode() {
        assert_ne!(key(Path::new("/书/a")), key(Path::new("/书/ab")));
        assert_ne!(key(Path::new("/书/a")), key(Path::new("/书 /a")));
        assert!(!key(Path::new("/书/a")).contains('/'));
    }

    #[test]
    fn grants_are_atomic_and_independent() {
        let dir = tempfile::tempdir().unwrap();
        let a = Path::new("/中文 /project");
        let b = Path::new("/中文 /project-other");
        save(dir.path(), a, b"first").unwrap();
        save(dir.path(), b, b"other").unwrap();
        save(dir.path(), a, b"renewed").unwrap();
        assert_eq!(std::fs::read(dir.path().join(key(a))).unwrap(), b"renewed");
        assert_eq!(std::fs::read(dir.path().join(key(b))).unwrap(), b"other");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
}
