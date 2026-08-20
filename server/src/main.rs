//! Knowledge-base backup / sync server for Simple AI Writer.
//!
//! Holds named knowledge bases. A client binds one project to one of them and
//! then pushes its whole `.ai-writer/lore/` tree up or pulls it down — one
//! direction at a time, no merging. Each entry (one lore entity: its markdown,
//! its facets, its gallery) travels as a zip identified by a content hash the
//! *client* computes.
//!
//! The server is deliberately ignorant of what is inside those zips: it stores
//! blobs and reports hashes. Nothing here parses markdown, reads frontmatter or
//! knows what a facet is, so the app's knowledge-base format can keep evolving
//! without this binary having to follow.
//!
//! Design and rationale: `docs/remote-knowledge-base-feasibility.md` §13–§18.
//! Deployment and the full API: `server/README.md`.

mod config;
mod error;
mod ids;
mod routes;
mod store;

use std::sync::Arc;

use config::Config;
use routes::AppState;
use store::Store;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "aiw_kb_server=info,tower_http=info".into()),
        )
        .init();

    if let Err(message) = run().await {
        // Reported here rather than by returning an Err from main: the Debug
        // formatting of a returned error prints the message escaped and quoted,
        // which is a poor way to tell an operator their token is too short.
        eprintln!("aiw-kb-server: {message}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let config = Config::from_env()?;

    let store = Store::new(config.data_dir.clone()).map_err(|e| {
        format!(
            "could not open the data directory {:?}: {e}",
            config.data_dir
        )
    })?;

    if config.allow_anonymous {
        tracing::warn!(
            "running without authentication (AIW_KB_ALLOW_ANONYMOUS=1) — \
             anyone who can reach {} can read and overwrite every knowledge base",
            config.bind
        );
    }

    let state = Arc::new(AppState {
        store,
        tokens: config.tokens,
        allow_anonymous: config.allow_anonymous,
    });
    let app = routes::router(state, config.max_entry_bytes);

    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .map_err(|e| format!("could not bind {}: {e}", config.bind))?;
    tracing::info!(
        "listening on {}, data in {:?}",
        config.bind,
        config.data_dir
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|e| format!("server error: {e}"))
}

/// Stop accepting on Ctrl-C or SIGTERM and let in-flight requests finish.
///
/// Matters more than it looks: a write commits by renaming a staged file, and
/// killing the process between the two leaves a stray file in `tmp/` that
/// nothing cleans up. Draining first keeps that to actual crashes.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    tracing::info!("shutting down");
}
