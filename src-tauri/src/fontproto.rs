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
//! the fonts root. The path is judged **lexically first** — absolute, under
//! the root, no `..` — before anything touches the disk: on Windows a
//! webview-controlled `//host/share/x.woff2` handed straight to `canonicalize`
//! would open an SMB connection (leaking the user's NTLM hash) and could hang
//! on its timeout. Only then is it canonicalized and re-checked, so a symlink
//! planted in the folder can't reach outside it either.
//!
//! Served off the main thread (the asynchronous protocol form): a Chinese page
//! can ask for dozens of `unicode-range` chunks at once, and every other file
//! read in this app is kept off the UI thread too (blocking.rs).

use crate::protocol::fs_path_from_uri;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::http::{Request, Response};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "ai-writer-font";

pub fn register_font_protocol<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(SCHEME, handle_font_request)
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

Nothing here touches the disk until the path has passed on its text alone:
it must be a `.woff2`, absolute, under `root` and free of `..`. (`root` is
`app_data_dir()/fonts` as the app computes it — the same string the frontend
builds its URLs from, so a legitimate request always matches it lexically.)
Only then is it canonicalized and checked again against the canonical root,
which is what defeats a symlink inside the folder pointing out of it. A
missing root (no pack ever downloaded) or file is "not found".
*/
fn resolve_font_path(root: &Path, requested: &Path) -> Result<PathBuf, Refusal> {
    let is_woff2 = requested
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("woff2"));
    if !is_woff2 || !requested.is_absolute() || !lexically_under(requested, root) {
        return Err(Refusal::Forbidden);
    }
    let canonical_root = fs::canonicalize(root).map_err(|_| Refusal::NotFound)?;
    let file = fs::canonicalize(requested).map_err(|_| Refusal::NotFound)?;
    if !file.starts_with(&canonical_root) || !file.is_file() {
        return Err(Refusal::Forbidden);
    }
    Ok(file)
}

/// `path` is under `root` without any `..` component — judged on the text alone.
fn lexically_under(path: &Path, root: &Path) -> bool {
    use std::path::Component;
    path.starts_with(root) && !path.components().any(|c| matches!(c, Component::ParentDir))
}

fn handle_font_request<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let uri = request.uri().to_string();
    let root = ctx
        .app_handle()
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("fonts"));
    std::thread::spawn(move || {
        responder.respond(match root {
            Some(root) => respond(&root, &uri),
            None => status(404, "Not found"),
        })
    });
}

/// The whole answer to one request, given the fonts root — separate from the
/// handler so the headers are testable without an app.
fn respond(root: &Path, uri: &str) -> Response<Vec<u8>> {
    let requested = fs_path_from_uri(uri, SCHEME);
    match resolve_font_path(root, &requested)
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
    fn refuses_unc_like_and_relative_paths_before_touching_the_disk() {
        let (_d, root) = setup();
        for p in [
            "//server/share/x.woff2",
            "/\\\\server\\share\\x.woff2",
            "foo/x.woff2",
            "x.woff2",
        ] {
            assert_eq!(
                resolve_font_path(&root, Path::new(p)),
                Err(Refusal::Forbidden),
                "{p}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_directory_symlink_pointing_out_of_the_root() {
        let (d, root) = setup();
        let outside = d.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("x.woff2"), b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("misans/link")).unwrap();
        assert_eq!(
            resolve_font_path(&root, &root.join("misans/link/x.woff2")),
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

    fn url_for(p: &Path) -> String {
        format!(
            "ai-writer-font://localhost{}",
            p.to_string_lossy().replace(' ', "%20")
        )
    }

    #[test]
    fn a_served_font_carries_its_type_cors_and_cache_headers() {
        let (_d, root) = setup();
        let res = respond(
            &root,
            &url_for(&root.join("misans/5.0.0/MiSans-Regular.abc.0.woff2")),
        );
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["Content-Type"], "font/woff2");
        assert_eq!(res.headers()["Access-Control-Allow-Origin"], "*");
        assert!(res.headers()["Cache-Control"]
            .to_str()
            .unwrap()
            .contains("immutable"));
        assert_eq!(res.body(), b"wOF2");
    }

    #[test]
    fn refusals_carry_their_status_through_the_url_layer() {
        let (_d, root) = setup();
        let traversal = format!("{}/%2e%2e/config.woff2", url_for(&root));
        assert_eq!(respond(&root, &traversal).status(), 403);
        assert_eq!(
            respond(&root, &url_for(&root.join("misans/5.0.0/faces.css"))).status(),
            403
        );
        assert_eq!(
            respond(&root, &url_for(&root.join("misans/5.0.0/gone.woff2"))).status(),
            404
        );
        // query / fragment are URL furniture, not part of the file name
        let q = format!(
            "{}?v=1#x",
            url_for(&root.join("misans/5.0.0/MiSans-Regular.abc.0.woff2"))
        );
        assert_eq!(respond(&root, &q).status(), 200);
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
