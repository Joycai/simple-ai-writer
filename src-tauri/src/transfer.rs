//! Import/export transfer commands: zip bundles (lore) and JSON text files
//! (config backup). All dialogs run on the Rust side, following the pattern
//! established in `scope.rs`: the webview never supplies an arbitrary
//! destination path, it only receives paths the user explicitly picked in a
//! native dialog. Source/destination *directories* (project lore dir, staging
//! dir) still go through the `FsScope` check.

use crate::scope::FsScope;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::{command, AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// Hard cap on a manifest / imported text file. A config backup or bundle
/// manifest is kilobytes; anything beyond this is not a file we produced.
const MAX_TEXT_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// A bundle prefix must be one plain path component ("lore"), otherwise entry
/// names could be steered outside the intended zip subtree.
fn valid_prefix(prefix: &str) -> bool {
    !prefix.is_empty()
        && prefix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// ─── Dialog helpers ──────────────────────────────────────────────────────────

/// Run the native save-file dialog and hand back the picked path (None = cancel).
async fn pick_save_path(
    app: &AppHandle,
    filter_name: &str,
    extensions: &[&str],
    default_file_name: &str,
) -> Result<Option<PathBuf>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter(filter_name, extensions)
        .set_file_name(default_file_name)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    match picked {
        Some(p) => Ok(Some(p.into_path().map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

/// Run the native open-file dialog and hand back the picked path (None = cancel).
async fn pick_open_path(
    app: &AppHandle,
    filter_name: &str,
    extensions: &[&str],
) -> Result<Option<PathBuf>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter(filter_name, extensions)
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    match picked {
        Some(p) => Ok(Some(p.into_path().map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

// ─── Zip core (dialog-free, unit-tested) ─────────────────────────────────────

/// A path relative to the archive root, forward-slashed, as it appears both in
/// an exclusion rule and in the entry name written to the zip.
fn rel_path(base: &Path, path: &Path) -> Result<String, String> {
    Ok(path
        .strip_prefix(base)
        .map_err(|e| e.to_string())?
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/"))
}

/// True when `rel` is one of the excluded paths or lives under one.
///
/// Matched on whole path components, the same rule `is_within` uses next door
/// in commands.rs: a rule of `.ai-writer/tmp` must not also swallow a sibling
/// called `.ai-writer/tmpl`. An empty rule is ignored rather than treated as
/// "the root", which would silently produce an empty archive.
fn is_excluded(rel: &str, excludes: &[String]) -> bool {
    excludes.iter().any(|raw| {
        let ex = raw.trim_matches('/');
        !ex.is_empty() && (rel == ex || rel.starts_with(&format!("{ex}/")))
    })
}

/// Zip every file under `src_dir` into `dest`, stored as `<prefix>/<relpath>`
/// (forward slashes), skipping anything matching `excludes` (paths relative to
/// `src_dir`). When `manifest` is given it is written as a root-level
/// `manifest.json` entry. Returns the number of files archived.
fn zip_dir(
    src_dir: &Path,
    dest: &Path,
    prefix: &str,
    manifest: Option<&str>,
    excludes: &[String],
) -> Result<usize, String> {
    let file = File::create(dest).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    if let Some(m) = manifest {
        zip.start_file("manifest.json", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(m.as_bytes()).map_err(|e| e.to_string())?;
    }

    let mut count = 0usize;
    add_dir_entries(
        &mut zip, src_dir, src_dir, prefix, options, excludes, &mut count,
    )?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(count)
}

#[allow(clippy::too_many_arguments)]
fn add_dir_entries(
    zip: &mut ZipWriter<File>,
    base: &Path,
    dir: &Path,
    prefix: &str,
    options: SimpleFileOptions,
    excludes: &[String],
    count: &mut usize,
) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        // Source dir may not exist yet (project without lore) — empty bundle.
        Err(_) => return Ok(()),
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let rel = rel_path(base, &path)?;
        // Pruned at the directory, not per file: a backup skipping the whole
        // `.ai-writer/backups` tree should not walk it to reject each entry.
        if is_excluded(&rel, excludes) {
            continue;
        }
        if path.is_dir() {
            add_dir_entries(zip, base, &path, prefix, options, excludes, count)?;
        } else {
            let mut f = File::open(&path).map_err(|e| e.to_string())?;
            zip.start_file(format!("{prefix}/{rel}"), options)
                .map_err(|e| e.to_string())?;
            std::io::copy(&mut f, zip).map_err(|e| e.to_string())?;
            *count += 1;
        }
    }
    Ok(())
}

/// Read the archive's root `manifest.json`, if it has one.
fn read_manifest(archive: &mut ZipArchive<File>) -> Result<Option<String>, String> {
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(safe_rel) = entry.enclosed_name() else {
            continue;
        };
        if safe_rel != Path::new("manifest.json") {
            continue;
        }
        if entry.size() > MAX_TEXT_FILE_BYTES {
            return Err("Manifest is unreasonably large".into());
        }
        let mut s = String::new();
        entry.read_to_string(&mut s).map_err(|e| e.to_string())?;
        return Ok(Some(s));
    }
    Ok(None)
}

/// The `kind` field of a bundle manifest, when it parses and has one.
fn manifest_kind(manifest: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(manifest)
        .ok()?
        .get("kind")?
        .as_str()
        .map(str::to_owned)
}

/// Extract the `<prefix>/` subtree of the archive at `zip_path` into
/// `dest_dir`, and return `(manifest.json content, files extracted)`.
///
/// Entry paths go through `enclosed_name()` (rejects `..`, absolute paths and
/// drive letters — the zip-slip guard) and the prefix is stripped as a whole
/// path component, so a crafted archive cannot write outside `dest_dir`.
///
/// `require_kind` gates extraction on the manifest declaring that bundle kind.
/// The check runs over a first pass and returns before a single file is
/// written, because the caller that needs it is restoring into a folder the
/// user picked: "wrong file, nothing happened" has to stay literally true, not
/// "wrong file, and here is half of it unpacked in your folder". Callers that
/// pass `None` (the lore bundle, which deliberately accepts a hand-built tree
/// with no manifest at all) are unaffected.
fn unzip_into(
    zip_path: &Path,
    dest_dir: &Path,
    prefix: &str,
    require_kind: Option<&str>,
) -> Result<(Option<String>, usize), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    let manifest = read_manifest(&mut archive)?;
    if let Some(expected) = require_kind {
        let actual = manifest.as_deref().and_then(manifest_kind);
        if actual.as_deref() != Some(expected) {
            return Err(format!("Not a {expected} file"));
        }
    }

    let mut count = 0usize;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(safe_rel) = entry.enclosed_name() else {
            continue; // unsafe entry name — skip, never extract
        };

        if safe_rel == Path::new("manifest.json") {
            continue; // already read above
        }

        // Only entries under `<prefix>/` belong to the bundle payload.
        let mut components = safe_rel.components();
        match components.next() {
            Some(Component::Normal(first)) if first == std::ffi::OsStr::new(prefix) => {}
            _ => continue,
        }
        let rest: PathBuf = components.collect();
        if rest.as_os_str().is_empty() {
            continue;
        }

        let target = dest_dir.join(&rest);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        count += 1;
    }

    Ok((manifest, count))
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Ask where to save a zip bundle, then archive `src_dir` (stored under
/// `<prefix>/`, plus an optional root `manifest.json`), skipping any path in
/// `excludes` (relative to `src_dir`). Returns the saved path, or None when
/// the user cancelled the dialog.
#[command]
pub async fn zip_export_dialog(
    app: AppHandle,
    scope: State<'_, FsScope>,
    src_dir: String,
    prefix: String,
    manifest: Option<String>,
    default_file_name: String,
    excludes: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    scope.check(&src_dir)?;
    if !valid_prefix(&prefix) {
        return Err(format!("Invalid bundle prefix: {prefix}"));
    }
    let Some(dest) = pick_save_path(&app, "Zip", &["zip"], &default_file_name).await? else {
        return Ok(None);
    };
    zip_dir(
        Path::new(&src_dir),
        &dest,
        &prefix,
        manifest.as_deref(),
        &excludes.unwrap_or_default(),
    )?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

#[derive(Serialize)]
pub struct ZipImportResult {
    pub zip_path: String,
    pub manifest: Option<String>,
    pub file_count: usize,
}

/// Ask for a zip bundle, then extract its `<prefix>/` subtree into `dest_dir`
/// (a staging directory inside the project, so it must pass the fs scope).
/// When `require_manifest_kind` is given, an archive whose manifest does not
/// declare that kind is rejected before anything is written. Returns None when
/// the user cancelled the dialog.
#[command]
pub async fn zip_import_dialog(
    app: AppHandle,
    scope: State<'_, FsScope>,
    dest_dir: String,
    prefix: String,
    require_manifest_kind: Option<String>,
) -> Result<Option<ZipImportResult>, String> {
    scope.check(&dest_dir)?;
    if !valid_prefix(&prefix) {
        return Err(format!("Invalid bundle prefix: {prefix}"));
    }
    let Some(zip_path) = pick_open_path(&app, "Zip", &["zip"]).await? else {
        return Ok(None);
    };
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let (manifest, file_count) = unzip_into(
        &zip_path,
        Path::new(&dest_dir),
        &prefix,
        require_manifest_kind.as_deref(),
    )?;
    Ok(Some(ZipImportResult {
        zip_path: zip_path.to_string_lossy().into_owned(),
        manifest,
        file_count,
    }))
}

/// Ask where to save a text file (e.g. a JSON config backup) and write it.
/// Returns the saved path, or None when the user cancelled.
#[command]
pub async fn save_text_file_dialog(
    app: AppHandle,
    content: String,
    default_file_name: String,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<String>, String> {
    let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let Some(dest) = pick_save_path(&app, &filter_name, &exts, &default_file_name).await? else {
        return Ok(None);
    };
    fs::write(&dest, content).map_err(|e| e.to_string())?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

#[derive(Serialize)]
pub struct OpenedTextFile {
    pub path: String,
    pub content: String,
}

/// Ask for a text file (e.g. a JSON config backup) and return its content.
/// Returns None when the user cancelled.
#[command]
pub async fn open_text_file_dialog(
    app: AppHandle,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<OpenedTextFile>, String> {
    let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let Some(path) = pick_open_path(&app, &filter_name, &exts).await? else {
        return Ok(None);
    };
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_TEXT_FILE_BYTES {
        return Err("File is too large to import".into());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(OpenedTextFile {
        path: path.to_string_lossy().into_owned(),
        content,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique scratch dir under the OS temp dir; removed by each test's end.
    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("saw-transfer-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn zip_roundtrip_preserves_tree_and_manifest() {
        let root = scratch("roundtrip");
        let src = root.join("src");
        fs::create_dir_all(src.join("characters/hero")).unwrap();
        fs::write(src.join("characters/hero/index.md"), "# hero").unwrap();
        fs::write(src.join("characters/hero/avatar.png"), [1u8, 2, 3]).unwrap();
        fs::create_dir_all(src.join("world/city")).unwrap();
        fs::write(src.join("world/city/index.md"), "# city").unwrap();

        let bundle = root.join("bundle.zip");
        let count = zip_dir(&src, &bundle, "lore", Some(r#"{"kind":"test"}"#), &[]).unwrap();
        assert_eq!(count, 3);

        let out = root.join("out");
        let (manifest, extracted) = unzip_into(&bundle, &out, "lore", None).unwrap();
        assert_eq!(manifest.as_deref(), Some(r#"{"kind":"test"}"#));
        assert_eq!(extracted, 3);
        assert_eq!(
            fs::read_to_string(out.join("characters/hero/index.md")).unwrap(),
            "# hero"
        );
        assert_eq!(
            fs::read(out.join("characters/hero/avatar.png")).unwrap(),
            [1, 2, 3]
        );
        assert!(out.join("world/city/index.md").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn unzip_ignores_entries_outside_the_prefix_and_traversal_names() {
        let root = scratch("slip");
        let bundle = root.join("evil.zip");
        {
            let file = File::create(&bundle).unwrap();
            let mut zip = ZipWriter::new(file);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            // Legit payload entry.
            zip.start_file("lore/characters/a/index.md", options)
                .unwrap();
            zip.write_all(b"ok").unwrap();
            // Outside the prefix — must be ignored.
            zip.start_file("other/stray.md", options).unwrap();
            zip.write_all(b"stray").unwrap();
            // Traversal attempts — must never be written.
            zip.start_file("lore/../../escape.md", options).unwrap();
            zip.write_all(b"bad").unwrap();
            zip.finish().unwrap();
        }

        let out = root.join("out");
        let (_, extracted) = unzip_into(&bundle, &out, "lore", None).unwrap();
        assert_eq!(extracted, 1);
        assert!(out.join("characters/a/index.md").exists());
        assert!(!out.join("stray.md").exists());
        assert!(!root.join("escape.md").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn zip_of_missing_dir_yields_empty_bundle() {
        let root = scratch("missing");
        let bundle = root.join("empty.zip");
        let count = zip_dir(&root.join("does-not-exist"), &bundle, "lore", None, &[]).unwrap();
        assert_eq!(count, 0);
        let (manifest, extracted) = unzip_into(&bundle, &root.join("out"), "lore", None).unwrap();
        assert!(manifest.is_none());
        assert_eq!(extracted, 0);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn excluded_subtrees_never_reach_the_archive() {
        let root = scratch("excludes");
        let src = root.join("proj");
        fs::create_dir_all(src.join("writing")).unwrap();
        fs::write(src.join("writing/ch1.md"), "keep").unwrap();
        fs::create_dir_all(src.join(".ai-writer/backups/old")).unwrap();
        fs::write(src.join(".ai-writer/backups/old/ch1.md"), "drop").unwrap();
        fs::create_dir_all(src.join(".ai-writer/tmp/imagegen")).unwrap();
        fs::write(src.join(".ai-writer/tmp/imagegen/a.png"), [0u8]).unwrap();
        // The prefix trap: a sibling whose name merely starts with an excluded
        // one must survive.
        fs::create_dir_all(src.join(".ai-writer/tmpl")).unwrap();
        fs::write(src.join(".ai-writer/tmpl/keep.md"), "keep").unwrap();
        fs::write(src.join(".ai-writer/project.db"), [1u8, 2]).unwrap();
        fs::write(src.join(".ai-writer/project.db-wal"), [3u8]).unwrap();

        let excludes = vec![
            ".ai-writer/backups".to_string(),
            ".ai-writer/tmp".to_string(),
            ".ai-writer/project.db-wal".to_string(),
        ];
        let bundle = root.join("proj.zip");
        let count = zip_dir(&src, &bundle, "project", None, &excludes).unwrap();
        assert_eq!(count, 3, "ch1.md, tmpl/keep.md and project.db only");

        let out = root.join("out");
        unzip_into(&bundle, &out, "project", None).unwrap();
        assert!(out.join("writing/ch1.md").exists());
        assert!(out.join(".ai-writer/tmpl/keep.md").exists());
        assert!(out.join(".ai-writer/project.db").exists());
        assert!(!out.join(".ai-writer/backups").exists());
        assert!(!out.join(".ai-writer/tmp").exists());
        assert!(!out.join(".ai-writer/project.db-wal").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn is_excluded_matches_whole_components_only() {
        let rules = vec![".ai-writer/tmp".to_string(), "node_modules".to_string()];
        assert!(is_excluded(".ai-writer/tmp", &rules));
        assert!(is_excluded(".ai-writer/tmp/imagegen/a.png", &rules));
        assert!(is_excluded("node_modules", &rules));
        assert!(!is_excluded(".ai-writer/tmpl", &rules));
        assert!(!is_excluded(".ai-writer/tmpl/keep.md", &rules));
        assert!(!is_excluded("node_modules_backup/x", &rules));
        assert!(!is_excluded("writing/tmp.md", &rules));
        // An empty rule must not be read as "the root".
        assert!(!is_excluded(
            "writing/ch1.md",
            &["".to_string(), "/".to_string()]
        ));
    }

    #[test]
    fn a_required_manifest_kind_rejects_before_writing_anything() {
        let root = scratch("kind");
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.md"), "payload").unwrap();

        // Right shape, wrong kind — the lore bundle a user picked by mistake.
        let bundle = root.join("lore.zip");
        zip_dir(
            &src,
            &bundle,
            "project",
            Some(r#"{"kind":"ai-writer-lore-bundle","version":1}"#),
            &[],
        )
        .unwrap();

        let out = root.join("out");
        let err =
            unzip_into(&bundle, &out, "project", Some("ai-writer-project-bundle")).unwrap_err();
        assert!(err.contains("ai-writer-project-bundle"), "{err}");
        assert!(
            !out.join("a.md").exists(),
            "a rejected bundle must leave nothing behind"
        );

        // The matching kind still extracts.
        let good = root.join("good.zip");
        zip_dir(
            &src,
            &good,
            "project",
            Some(r#"{"kind":"ai-writer-project-bundle","version":1}"#),
            &[],
        )
        .unwrap();
        let (_, extracted) =
            unzip_into(&good, &out, "project", Some("ai-writer-project-bundle")).unwrap();
        assert_eq!(extracted, 1);
        assert!(out.join("a.md").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_required_kind_rejects_a_manifest_that_is_missing_or_unparseable() {
        let root = scratch("kind-missing");
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.md"), "payload").unwrap();

        for manifest in [None, Some("not json at all"), Some(r#"{"version":1}"#)] {
            let bundle = root.join("b.zip");
            zip_dir(&src, &bundle, "project", manifest, &[]).unwrap();
            let out = root.join("out");
            assert!(
                unzip_into(&bundle, &out, "project", Some("ai-writer-project-bundle")).is_err(),
                "manifest {manifest:?} should be rejected"
            );
            assert!(!out.join("a.md").exists());
        }

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prefix_validation_rejects_path_like_prefixes() {
        for bad in ["", "a/b", "..", r"a\b", "a b"] {
            assert!(!valid_prefix(bad), "{bad:?} should be rejected");
        }
        assert!(valid_prefix("lore"));
        assert!(valid_prefix("bundle-1"));
    }
}
