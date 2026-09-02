//! Headless entry point (`aiw-kb-server`).
//!
//! All the substance lives in the library (see `lib.rs` for what this server
//! is); this file is presentation for a terminal: CLI flags, logging to
//! stderr, the first-run credentials printed to stdout, Ctrl-C / SIGTERM as
//! the shutdown signal. The Windows tray launcher (`src/bin/tray.rs`) is the
//! same skeleton with dialogs where this has prints.

use aiw_kb_server::config::{self, Config};

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
    // Answered before Config::load on purpose: asking a binary which build it
    // is must not create a config file (with fresh credentials) as a side effect.
    if argv.iter().any(|a| a == "--version" || a == "-V") {
        println!("aiw-kb-server {}", env!("CARGO_PKG_VERSION"));
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

    let bind_addr = config.server.bind;
    let data_dir = config.server.data_dir.clone();
    let config_path = config.file_path.clone();

    let server = aiw_kb_server::bind(config, argv).await?;
    tracing::info!(
        "listening on {bind_addr}, data in {data_dir:?}, config {}",
        config_path.display()
    );
    tracing::info!("admin console: http://{bind_addr}/admin");

    server.run(shutdown_signal()).await
}

fn print_help() {
    println!(
        "aiw-kb-server {} — knowledge-base backup / sync server\n\n\
         用法：aiw-kb-server [--config <路径>] | --version | --help\n\n\
         配置全在一个 TOML 文件里；没有就会自动生成一个，并把生成的密码和 token 打在这里。\n\
         查找顺序：--config > AIW_KB_CONFIG > 可执行文件同目录的 aiw-kb.toml > 系统配置目录。\n\
         环境变量（AIW_KB_BIND / AIW_KB_DATA_DIR / AIW_KB_TOKENS / AIW_KB_ALLOW_ANONYMOUS /\n\
         AIW_KB_MAX_ENTRY_MB / RUST_LOG）优先于文件里的值。\n\n\
         启动后：管理后台在 http://<监听地址>/admin\n\
         Windows 上想常驻托盘、开机自启：运行 aiw-kb-tray。",
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
