//! Standalone HTML preview window (HTML 工件三期 — docs/feature/html-artifact-plan.md).
//!
//! The in-app preview is a sandboxed iframe inside the editor pane — right for
//! iterating, wrong for judging a promo page at its real viewport size. This
//! window gives the document a webview of its own, fed through a custom URI
//! scheme that serves project files straight from disk:
//!
//!   - **Relative links just work.** The document's URL mirrors its filesystem
//!     path, so `assets/pic.png` resolves through the same protocol — no
//!     data-URL inlining pass like the iframe needs.
//!   - **No main-window CSP.** Tauri injects the configured CSP only into its
//!     own `tauri://` assets and `data:` URLs (see manager/webview.rs — custom
//!     protocol handlers pass through untouched), so the page's inline
//!     scripts run here exactly as they would in a browser.
//!   - **Same containment as every other serving path.** Every request —
//!     entry document and subresources alike — passes `FsScope::is_allowed`
//!     plus a MIME allowlist, mirroring `ai-writer-asset` (protocol.rs).
//!   - **No IPC.** `capabilities/default.json` grants permissions to the
//!     `main` window only; this window's label has no capability entry, so
//!     the page can reach no Tauri command.
//!
//! Modelled on print.rs: one reused window label, destroy-then-rebuild.

use crate::protocol::fs_path_from_uri;
use crate::scope::FsScope;
use std::fs;
use std::path::Path;
use tauri::http::{Request, Response};
use tauri::{Manager, Runtime, UriSchemeContext, WebviewUrl, WebviewWindowBuilder};

/// Label of the preview window. Reused so previewing another document replaces
/// the window instead of stacking one per click.
const PREVIEW_WINDOW: &str = "html-preview";

pub fn register_preview_protocol<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_uri_scheme_protocol("ai-writer-preview", handle_preview_request)
}

fn handle_preview_request<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let path = fs_path_from_uri(&request.uri().to_string(), "ai-writer-preview");

    let forbidden = || {
        Response::builder()
            .status(403)
            .body(b"Forbidden".to_vec())
            .unwrap()
    };

    // Allowlisted MIME first: whatever else is in scope (project.db, secrets a
    // project might hold), this protocol refuses to serve it.
    let mime = match mime_for_preview(&path) {
        Some(m) => m,
        None => return forbidden(),
    };

    let in_scope = ctx
        .app_handle()
        .try_state::<FsScope>()
        .is_some_and(|scope| scope.is_allowed(&path));
    if !in_scope {
        return forbidden();
    }

    match fs::read(&path) {
        Ok(bytes) => Response::builder()
            .header("Content-Type", mime)
            .body(bytes)
            .unwrap(),
        Err(_) => Response::builder()
            .status(404)
            .body(b"Not found".to_vec())
            .unwrap(),
    }
}

/// What a previewed page may load: the document itself plus the subresource
/// kinds a self-contained-ish page legitimately reaches for. Everything else —
/// notably the project database and arbitrary dotfiles — stays refusable by
/// extension before the scope check even runs.
fn mime_for_preview(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => Some("text/html; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "json" => Some("application/json; charset=utf-8"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        _ => None,
    }
}

/// Percent-encode an absolute filesystem path into the URL path of the
/// preview scheme. Inverse of `fs_path_from_uri`: backslashes normalise to
/// `/`, a Windows drive-lettered path gains the synthetic leading slash, and
/// everything outside the URL-safe set is `%XX`-encoded per UTF-8 byte —
/// except `/` (path separator) and `:` (drive letter), which the decoder
/// expects verbatim.
fn encode_path_for_url(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let with_slash = if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    };
    let mut out = String::with_capacity(with_slash.len());
    for b in with_slash.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Open (or replace) the standalone preview window on a project .html file.
///
/// Async for the same reason as `print_document`: window creation dispatches
/// to the event loop rather than blocking the IPC thread servicing this call.
#[tauri::command]
pub async fn preview_html_window<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    scope: tauri::State<'_, FsScope>,
) -> Result<(), String> {
    scope.check(&path)?;
    // Only an HTML document earns a window; subresources are reachable through
    // the protocol but are not entry points.
    let is_html = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"));
    if !is_html {
        return Err("Only .html/.htm files can be previewed in a window".into());
    }

    if let Some(stale) = app.get_webview_window(PREVIEW_WINDOW) {
        stale.destroy().map_err(|e| e.to_string())?;
    }

    let title = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Preview".into());

    let url = format!(
        "ai-writer-preview://localhost{}",
        encode_path_for_url(&path)
    )
    .parse()
    .map_err(|e| format!("bad preview url: {e}"))?;

    WebviewWindowBuilder::new(&app, PREVIEW_WINDOW, WebviewUrl::CustomProtocol(url))
        .title(title)
        // A landing page's usual design viewport; resizable for everything else.
        .inner_size(1100.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_allowlist_accepts_page_and_subresource_kinds() {
        assert_eq!(
            mime_for_preview(Path::new("/p/图示.html")),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            mime_for_preview(Path::new("/p/a.CSS")),
            Some("text/css; charset=utf-8")
        );
        assert_eq!(
            mime_for_preview(Path::new("/p/a.svg")),
            Some("image/svg+xml")
        );
        assert_eq!(
            mime_for_preview(Path::new("/p/a.woff2")),
            Some("font/woff2")
        );
    }

    #[test]
    fn mime_allowlist_rejects_everything_else() {
        // The 403 guard depends on these being None — the project database and
        // arbitrary text files must not be servable into the preview window.
        assert_eq!(
            mime_for_preview(Path::new("/p/.ai-writer/project.db")),
            None
        );
        assert_eq!(mime_for_preview(Path::new("/p/第1章.md")), None);
        assert_eq!(mime_for_preview(Path::new("/p/noextension")), None);
    }

    #[test]
    fn encode_decode_round_trips_through_the_protocol_parser() {
        for p in [
            "/Users/dev/项目/图 示/宣传页.html",
            "/plain/page.html",
            "/with space/and&amp.html",
        ] {
            let url = format!("ai-writer-preview://localhost{}", encode_path_for_url(p));
            let back = fs_path_from_uri(&url, "ai-writer-preview");
            assert_eq!(back, Path::new(p), "round-trip failed for {p}");
        }
    }

    #[test]
    fn encode_gives_windows_paths_the_synthetic_leading_slash() {
        let url = format!(
            "ai-writer-preview://localhost{}",
            encode_path_for_url(r"C:\proj\页面.html")
        );
        assert!(url.starts_with("ai-writer-preview://localhost/C:/proj/"));
        // And the parser strips it back off.
        let back = fs_path_from_uri(&url, "ai-writer-preview");
        assert_eq!(back, Path::new("C:/proj/页面.html"));
    }

    #[test]
    fn parser_accepts_the_windows_http_origin_form_and_drops_queries() {
        let p = fs_path_from_uri(
            "http://ai-writer-preview.localhost/D:/proj/page.html?v=1#top",
            "ai-writer-preview",
        );
        assert_eq!(p, Path::new("D:/proj/page.html"));
    }
}
