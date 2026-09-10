//! Running synchronous work off the threads that must stay responsive.
//!
//! A Tauri command without `async` runs on the **main thread** — the one that
//! pumps the window's messages. The custom `fs_*` commands used to be exactly
//! that: every `fs_exists` probe of a knowledge-base scan (hundreds of them,
//! one after the other, each canonicalizing its path first) stalled the
//! webview's event loop for its duration. And an `async fn` alone only moves
//! the work onto a tokio worker, of which there are as many as cores; a slow
//! disk or a keychain prompt would hold one of them for as long as it takes.
//!
//! So blocking work goes to the blocking pool, through this one helper — the
//! same rule for a 4 MB write and for a macOS Keychain dialog.

/// Run `work` on the blocking pool and hand its result back.
///
/// A pool task that panicked is reported as an `Err` rather than propagated:
/// the command's caller is the webview, and a string it can show beats a
/// process that is gone.
pub(crate) async fn blocking<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result,
        Err(e) => Err(e.to_string()),
    }
}
