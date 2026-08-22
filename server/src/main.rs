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
//! It also serves an **admin console** at `/admin` — a small self-contained page
//! that does the things `DEPLOY.md` used to describe as shell commands. That is
//! a second HTTP surface with a second kind of credential (a password, not a
//! token); see `admin` for why the two never meet.
//!
//! Design and rationale: `docs/feature/knowledge-base/remote-knowledge-base-feasibility.md` §13–§18.
//! Deployment and the full API: `server/README.md`.

mod admin;
mod audit;
mod confedit;
mod config;
mod error;
mod ids;
mod maint;
mod routes;
mod session;
mod store;

use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use audit::AuditLog;
use config::Config;
use routes::AppState;
use session::SessionStore;
use store::Store;

#[tokio::main]
async fn main() {
    if let Err(message) = run().await {
        // Reported here rather than by returning an Err from main: the Debug
        // formatting of a returned error prints the message escaped and quoted,
        // which is a poor way to tell an operator their token is too short.
        eprintln!("aiw-kb-server: {message}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let argv: Vec<String> = std::env::args().collect();
    if argv.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        return Ok(());
    }

    // The configuration is read *before* logging is set up, because the log
    // filter is one of the things it carries.
    let config = Config::load(&argv)?;

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_new(&config.server.log)
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(config::DEFAULT_LOG)),
        )
        .init();

    if config.file_created {
        announce_new_config(&config);
    }
    if let Some(error) = &config.file_error {
        tracing::error!(
            "{} could not be parsed ({error}) — running on defaults and the environment. \
             Fix it in the admin console or by hand.",
            config.file_path.display()
        );
    }
    if config.server.allow_anonymous {
        tracing::warn!(
            "the sync API is running without authentication (allow_anonymous) — \
             anyone who can reach {} can read and overwrite every knowledge base",
            config.server.bind
        );
    }
    if config.admin.is_none() {
        tracing::warn!(
            "no [admin] account in {} — the admin console at /admin is disabled",
            config.file_path.display()
        );
    }

    let store = Store::new(config.server.data_dir.clone()).map_err(|e| {
        format!(
            "could not open the data directory {:?}: {e}",
            config.server.data_dir
        )
    })?;
    let audit = AuditLog::open(&config.server.data_dir);

    let bind = config.server.bind;
    let data_dir = config.server.data_dir.clone();
    let config_path = config.file_path.clone();
    let max_entry_bytes = config.max_entry_bytes();

    let state = Arc::new(AppState {
        store,
        config: RwLock::new(config),
        argv,
        sessions: SessionStore::default(),
        audit,
        started_at_ms: now_ms(),
    });
    let app = routes::router(Arc::clone(&state), max_entry_bytes);

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| format!("could not bind {bind}: {e}"))?;
    tracing::info!(
        "listening on {bind}, data in {data_dir:?}, config {}",
        config_path.display()
    );
    tracing::info!("admin console: http://{bind}/admin");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|e| format!("server error: {e}"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn print_help() {
    println!(
        "aiw-kb-server {} — knowledge-base backup / sync server\n\n\
         用法：aiw-kb-server [--config <路径>]\n\n\
         配置全在一个 TOML 文件里；没有就会自动生成一个，并把生成的密码和 token 打在这里。\n\
         查找顺序：--config > AIW_KB_CONFIG > 可执行文件同目录的 aiw-kb.toml > 系统配置目录。\n\
         环境变量（AIW_KB_BIND / AIW_KB_DATA_DIR / AIW_KB_TOKENS / AIW_KB_ALLOW_ANONYMOUS /\n\
         AIW_KB_MAX_ENTRY_MB / RUST_LOG）优先于文件里的值。\n\n\
         启动后：管理后台在 http://<监听地址>/admin",
        env!("CARGO_PKG_VERSION")
    );
}

/// Print the credentials of a config file this run just created.
///
/// To stdout and not through `tracing`: this is the one moment the generated
/// password exists anywhere a person can read it, and it must not be filtered
/// away by a log level or swallowed by a journal the operator is not watching.
fn announce_new_config(config: &Config) {
    let password = config
        .admin
        .as_ref()
        .map(|a| a.password.as_str())
        .unwrap_or("(未生成)");
    let username = config
        .admin
        .as_ref()
        .map(|a| a.username.as_str())
        .unwrap_or("admin");
    let token = config
        .tokens
        .first()
        .map(|t| t.value.as_str())
        .unwrap_or("(未生成)");
    println!(
        "\n\
         ┌──────────────────────────────────────────────────────────────\n\
         │ 已生成配置文件：{}\n\
         │\n\
         │ 管理后台   http://{}/admin\n\
         │ 用户名     {username}\n\
         │ 密码       {password}\n\
         │\n\
         │ app 里填的同步 token：\n\
         │ {token}\n\
         │\n\
         │ 这两个值也躺在上面那个文件里，随时可以改（后台里就能改）。\n\
         └──────────────────────────────────────────────────────────────\n",
        config.file_path.display(),
        config.server.bind,
    );
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
