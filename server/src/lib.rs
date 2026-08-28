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
//! Beside the knowledge bases it holds **application-config backups** — the
//! app's providers, models, prompts and preferences, so a second machine can
//! pull a setup down instead of having it re-typed. Those arrive encrypted
//! whenever they carry API keys, with a password this server never sees and
//! cannot recover; here too it stores an opaque blob and reports a hash.
//!
//! It also serves an **admin console** at `/admin` — a small self-contained page
//! that does the things `DEPLOY.md` used to describe as shell commands. That is
//! a second HTTP surface with a second kind of credential (a password, not a
//! token); see `admin` for why the two never meet.
//!
//! This crate builds two binaries over the one library: `aiw-kb-server` (the
//! headless entry point, `src/main.rs`) and `aiw-kb-tray` (a Windows tray
//! launcher, `src/bin/tray.rs`) — which is why the startup skeleton lives here
//! as [`bind`] + [`BoundServer::run`] rather than inline in a `main`. The two
//! steps are separate on purpose: **a bind failure must be an error the caller
//! holds immediately** — stderr for the headless binary, a dialog for the tray —
//! not something fished out of a task handle later.
//!
//! Design and rationale: `docs/feature/knowledge-base/remote-knowledge-base-feasibility.md` §13–§18.
//! Deployment and the full API: `server/README.md`.

pub mod admin;
pub mod audit;
pub mod confedit;
pub mod config;
pub mod error;
pub mod ids;
pub mod maint;
pub mod routes;
pub mod session;
pub mod store;

use std::future::Future;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use audit::AuditLog;
use config::Config;
use routes::AppState;
use session::SessionStore;
use store::Store;

/// A server that has opened its data directory and bound its port, but is not
/// yet accepting connections. Everything that can fail at startup has already
/// failed by the time one of these exists.
pub struct BoundServer {
    listener: tokio::net::TcpListener,
    app: axum::Router,
    state: Arc<AppState>,
}

/// Open the store, assemble the router and bind the listen address.
///
/// `argv` is kept on [`AppState`] because the admin console's "reload config"
/// re-runs `Config::load` with the same arguments the process started with.
pub async fn bind(config: Config, argv: Vec<String>) -> Result<BoundServer, String> {
    let store = Store::new(config.server.data_dir.clone()).map_err(|e| {
        format!(
            "could not open the data directory {:?}: {e}",
            config.server.data_dir
        )
    })?;
    let audit = AuditLog::open(&config.server.data_dir);

    let bind_addr = config.server.bind;
    let max_entry_bytes = config.max_entry_bytes();
    let max_config_bytes = config.max_config_bytes();

    let state = Arc::new(AppState {
        store,
        config: RwLock::new(config),
        argv,
        sessions: SessionStore::default(),
        audit,
        started_at_ms: now_ms(),
    });
    let app = routes::router(Arc::clone(&state), max_entry_bytes, max_config_bytes);

    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|e| format!("could not bind {bind_addr}: {e}"))?;

    Ok(BoundServer {
        listener,
        app,
        state,
    })
}

impl BoundServer {
    /// The shared state, for callers that want to inspect it before serving.
    pub fn state(&self) -> &Arc<AppState> {
        &self.state
    }

    /// Serve until `shutdown` resolves, then drain in-flight requests.
    ///
    /// Draining matters more than it looks: a write commits by renaming a
    /// staged file, and killing the process between the two leaves a stray
    /// file in `tmp/` that nothing cleans up. Draining first keeps that to
    /// actual crashes.
    pub async fn run(
        self,
        shutdown: impl Future<Output = ()> + Send + 'static,
    ) -> Result<(), String> {
        axum::serve(self.listener, self.app)
            .with_graceful_shutdown(shutdown)
            .await
            .map_err(|e| format!("server error: {e}"))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
