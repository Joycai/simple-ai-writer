//! Downloaded font files, served to the webviews (docs/feature/downloadable-fonts-plan.md).
//!
//! The font schemes 鸿蒙黑体 / MiSans are not bundled: the frontend downloads
//! their woff2 chunks into `<app_data_dir>/fonts/` (lib/theme/fontPacks.ts) and
//! declares `@font-face` rules whose `src` points here. A URL rather than bytes
//! handed over IPC because the chunks are split by `unicode-range` — the
//! browser fetches only the ones a page actually uses, so an installed pack
//! costs nothing at startup.
//!
//! Three kinds of page load these faces, and all three are cross-origin to
//! this scheme: the main window (`tauri://`), the settings samples (sandboxed
//! `srcdoc` iframes — an opaque origin), and the print window
//! (`ai-writer-print:`). Fonts are CORS-fetched, hence
//! `Access-Control-Allow-Origin: *`; the files are public fonts, so opening
//! them to any origin gives nothing away.
//!
//! Containment is its own, narrower than `FsScope`: only `.woff2`, only under
//! the fonts root, checked on the canonical path so neither `..` nor a symlink
//! planted in the folder can reach outside it.

use crate::protocol::fs_path_from_uri;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::http::{Request, Response};
use tauri::{Manager, Runtime, UriSchemeContext};

pub const SCHEME: &str = "ai-writer-font";

pub fn register_font_protocol<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_uri_scheme_protocol(SCHEME, handle_font_request)
}

/// Why a request was refused — each maps to one status code.
#[derive(Debug, PartialEq, Eq)]
enum Refusal {
    /// Not a `.woff2`, or outside the fonts root.
    Forbidden,
    /// Inside the root and the right kind, but not on disk.
    NotFound,
}

/**
Decide whether `requested` may be served from `root`, returning the canonical
path to read.

The extension is checked first, on the path as asked for, so a request for
anything that is not a font is refused without touching the disk. Then both
paths are canonicalized and the file must sit under the root: that is what
defeats `fonts/../config.db` and a symlink inside the folder pointing out of
it. A missing root (no pack ever downloaded) is simply "not found".
*/
fn resolve_font_path(root: &Path, requested: &Path) -> Result<PathBuf, Refusal> {
    let is_woff2 = requested
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("woff2"));
    if !is_woff2 {
        return Err(Refusal::Forbidden);
    }
    let canonical_root = fs::canonicalize(root).map_err(|_| Refusal::NotFound)?;
    let file = match fs::canonicalize(requested) {
        Ok(p) => p,
        // Can't resolve it — but only say "not found" for a path that would
        // have been inside the root; anything else is refused outright.
        Err(_) => {
            return if lexically_under(requested, root)
                || lexically_under(requested, &canonical_root)
            {
                Err(Refusal::NotFound)
            } else {
                Err(Refusal::Forbidden)
            };
        }
    };
    if !file.starts_with(&canonical_root) || !file.is_file() {
        return Err(Refusal::Forbidden);
    }
    Ok(file)
}

/// `path` is under `root` without any `..` component — the check for a path
/// that doesn't exist, so it can't be canonicalized.
fn lexically_under(path: &Path, root: &Path) -> bool {
    use std::path::Component;
    path.starts_with(root) && !path.components().any(|c| matches!(c, Component::ParentDir))
}

fn handle_font_request<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let requested = fs_path_from_uri(&request.uri().to_string(), SCHEME);
    let root = match ctx.app_handle().path().app_data_dir() {
        Ok(dir) => dir.join("fonts"),
        Err(_) => return status(404, "Not found"),
    };
    match resolve_font_path(&root, &requested)
        .and_then(|p| fs::read(p).map_err(|_| Refusal::NotFound))
    {
        Ok(bytes) => Response::builder()
            .header("Content-Type", "font/woff2")
            .header("Access-Control-Allow-Origin", "*")
            // The path carries the pack's version, so a file never changes
            // under the same URL.
            .header("Cache-Control", "max-age=31536000, immutable")
            .body(bytes)
            .unwrap(),
        Err(Refusal::Forbidden) => status(403, "Forbidden"),
        Err(Refusal::NotFound) => status(404, "Not found"),
    }
}

fn status(code: u16, text: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .header("Access-Control-Allow-Origin", "*")
        .body(text.as_bytes().to_vec())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("fonts");
        fs::create_dir_all(root.join("misans/5.0.0")).unwrap();
        fs::write(
            root.join("misans/5.0.0/MiSans-Regular.abc.0.woff2"),
            b"wOF2",
        )
        .unwrap();
        fs::write(root.join("misans/5.0.0/faces.css"), b"@font-face{}").unwrap();
        fs::write(dir.path().join("config.woff2"), b"secret").unwrap();
        (dir, root)
    }

    #[test]
    fn serves_a_woff2_inside_the_root() {
        let (_d, root) = setup();
        let got = resolve_font_path(&root, &root.join("misans/5.0.0/MiSans-Regular.abc.0.woff2"))
            .unwrap();
        assert!(got.ends_with("MiSans-Regular.abc.0.woff2"));
    }

    #[test]
    fn the_extension_is_case_insensitive() {
        let (_d, root) = setup();
        fs::write(root.join("misans/5.0.0/X.WOFF2"), b"wOF2").unwrap();
        assert!(resolve_font_path(&root, &root.join("misans/5.0.0/X.WOFF2")).is_ok());
    }

    #[test]
    fn refuses_anything_that_is_not_a_woff2() {
        let (_d, root) = setup();
        for name in [
            "misans/5.0.0/faces.css",
            "misans/installed.json",
            "misans/5.0.0/noext",
            "misans",
        ] {
            assert_eq!(
                resolve_font_path(&root, &root.join(name)),
                Err(Refusal::Forbidden),
                "{name}"
            );
        }
    }

    #[test]
    fn refuses_dot_dot_out_of_the_root() {
        let (_d, root) = setup();
        // Exists, is a .woff2, and is one level above the root.
        assert_eq!(
            resolve_font_path(&root, &root.join("../config.woff2")),
            Err(Refusal::Forbidden)
        );
        // Doesn't exist, and would be outside: still refused, not "not found".
        assert_eq!(
            resolve_font_path(&root, &root.join("../nope.woff2")),
            Err(Refusal::Forbidden)
        );
    }

    #[test]
    fn refuses_an_absolute_path_elsewhere() {
        let (d, root) = setup();
        assert_eq!(
            resolve_font_path(&root, &d.path().join("config.woff2")),
            Err(Refusal::Forbidden)
        );
        assert_eq!(
            resolve_font_path(&root, Path::new("/etc/passwd.woff2")),
            Err(Refusal::Forbidden)
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_pointing_out_of_the_root() {
        let (d, root) = setup();
        std::os::unix::fs::symlink(
            d.path().join("config.woff2"),
            root.join("misans/5.0.0/leak.woff2"),
        )
        .unwrap();
        assert_eq!(
            resolve_font_path(&root, &root.join("misans/5.0.0/leak.woff2")),
            Err(Refusal::Forbidden)
        );
    }

    #[test]
    fn a_missing_file_inside_the_root_is_not_found() {
        let (_d, root) = setup();
        assert_eq!(
            resolve_font_path(&root, &root.join("misans/5.0.0/gone.woff2")),
            Err(Refusal::NotFound)
        );
    }

    #[test]
    fn no_root_yet_is_not_found() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("fonts");
        assert_eq!(
            resolve_font_path(&root, &root.join("misans/a.woff2")),
            Err(Refusal::NotFound)
        );
    }

    #[test]
    fn both_url_shapes_parse_to_the_same_path() {
        let mac = fs_path_from_uri(
            "ai-writer-font://localhost/Users/a/fonts/misans/5.0.0/x.woff2",
            SCHEME,
        );
        let win = fs_path_from_uri(
            "http://ai-writer-font.localhost/Users/a/fonts/misans/5.0.0/x.woff2",
            SCHEME,
        );
        assert_eq!(mac, win);
        assert_eq!(mac, PathBuf::from("/Users/a/fonts/misans/5.0.0/x.woff2"));
        let drive = fs_path_from_uri(
            "http://ai-writer-font.localhost/C:/Users/a/fonts/x.woff2",
            SCHEME,
        );
        assert_eq!(drive, PathBuf::from("C:/Users/a/fonts/x.woff2"));
    }
}
