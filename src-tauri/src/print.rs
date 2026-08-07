//! Native document printing.
//!
//! `window.print()` is a silent no-op in Tauri on macOS. WebKit does not print
//! by itself: a JS print request is forwarded to the host application through
//! the `WKUIDelegate` print callback, and wry's delegate implements only four
//! methods (open panel, media capture, new window, window-will-close) — no
//! print — while Tauri adds no delegate of its own. Nothing throws; the call
//! just does nothing, which is why the export menu looked dead.
//!
//! The one path that does work on macOS is the Rust side: `Webview::print()`
//! → `printOperationWithPrintInfo`. It prints *a whole webview*, so the export
//! HTML gets a webview of its own — a print-preview window — and that is what
//! we print. Printing the main window instead would mean fighting the app
//! shell's own layout for pagination.
//!
//! The HTML reaches that window through a custom URI scheme rather than a temp
//! file: nothing to clean up, no widening of the fs scope, and no dependence
//! on `file://` being loadable (wry has no `loadFileURL` path).

use std::sync::Mutex;
use tauri::http::{Request, Response};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, Runtime, UriSchemeContext, WebviewUrl, WebviewWindowBuilder};

/// Label of the print-preview window. Reused, so printing twice replaces the
/// first preview instead of stacking windows the author has to dismiss.
const PRINT_WINDOW: &str = "print";

/// The document waiting for the print window to pick it up.
#[derive(Default)]
pub struct PendingPrint(Mutex<Option<String>>);

pub fn register_print_protocol<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_uri_scheme_protocol("ai-writer-print", handle_print_request)
}

fn handle_print_request<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    _request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    // Taken, not cloned: the document is single-use, so a stale reload of a
    // preview window can't resurrect something the author already printed.
    let html = ctx
        .app_handle()
        .try_state::<PendingPrint>()
        .and_then(|state| state.0.lock().ok().and_then(|mut held| held.take()));

    match html {
        Some(html) => Response::builder()
            .header("Content-Type", "text/html; charset=utf-8")
            .body(html.into_bytes())
            .unwrap(),
        None => Response::builder()
            .status(404)
            .body(b"No document pending".to_vec())
            .unwrap(),
    }
}

/// Render `html` in a print-preview window and open the system print dialog on
/// it. macOS's dialog carries the "PDF ▾ → Save as PDF" menu, which is what
/// makes this the PDF export.
///
/// Async so window creation is dispatched to the event loop rather than
/// blocking the IPC thread that is servicing this call.
#[tauri::command]
pub async fn print_document<R: Runtime>(
    app: tauri::AppHandle<R>,
    html: String,
    title: String,
) -> Result<(), String> {
    if let Some(stale) = app.get_webview_window(PRINT_WINDOW) {
        stale.destroy().map_err(|e| e.to_string())?;
    }

    // Staged before the window exists, because the protocol handler runs as
    // soon as the webview starts loading.
    app.state::<PendingPrint>()
        .0
        .lock()
        .map_err(|_| "print state lock poisoned".to_string())?
        .replace(html);

    let url = "ai-writer-print://localhost/"
        .parse()
        .map_err(|e| format!("bad print url: {e}"))?;

    WebviewWindowBuilder::new(&app, PRINT_WINDOW, WebviewUrl::CustomProtocol(url))
        .title(title)
        // Roughly a portrait page, so the preview matches what gets printed.
        .inner_size(820.0, 1060.0)
        .on_page_load(|window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            // `Finished` is didFinishNavigation — the document is loaded, but
            // the first layout/font pass may not have run, and printing too
            // early yields a blank first page. Hand off to a timer thread
            // rather than sleeping on the event loop; `print()` goes through
            // the runtime dispatcher, so calling it from here is fine.
            let window = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if let Err(e) = window.print() {
                    log_print_error(&e);
                }
            });
        })
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn log_print_error(e: &tauri::Error) {
    eprintln!("print_document: failed to open the print dialog: {e}");
}
