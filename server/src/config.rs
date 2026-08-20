//! Runtime configuration, entirely from the environment.
//!
//! No config file and no CLI parser on purpose: this is a single binary an
//! operator drops on a box behind a reverse proxy, and every deployment style
//! it is likely to meet (systemd unit, docker run, a shell one-liner) already
//! speaks environment variables.

use std::net::SocketAddr;
use std::path::PathBuf;

pub struct Config {
    pub data_dir: PathBuf,
    pub bind: SocketAddr,
    /// Accepted bearer tokens. Empty only when the operator explicitly opted
    /// into anonymous access.
    pub tokens: Vec<String>,
    pub allow_anonymous: bool,
    pub max_entry_bytes: usize,
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let data_dir = PathBuf::from(env("AIW_KB_DATA_DIR").unwrap_or_else(|| "./data".into()));

        // Loopback by default. A knowledge base is the author's own writing, and
        // a default of 0.0.0.0 would put it on the network the first time
        // someone runs the binary to see what it does.
        let bind_raw = env("AIW_KB_BIND").unwrap_or_else(|| "127.0.0.1:8787".into());
        let bind: SocketAddr = bind_raw
            .parse()
            .map_err(|e| format!("AIW_KB_BIND is not a valid address ({bind_raw:?}): {e}"))?;

        let tokens: Vec<String> = env("AIW_KB_TOKENS")
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let allow_anonymous = env("AIW_KB_ALLOW_ANONYMOUS").as_deref() == Some("1");

        // Fail closed. An unauthenticated server that starts anyway is the kind
        // of default that ends up on a public IP, so refusing to boot is the
        // whole safeguard — and the opt-out is deliberately awkward to type.
        if tokens.is_empty() && !allow_anonymous {
            return Err(
                "no tokens configured: set AIW_KB_TOKENS=<token>[,<token>…], \
                        or AIW_KB_ALLOW_ANONYMOUS=1 to run without authentication"
                    .into(),
            );
        }
        if let Some(short) = tokens.iter().find(|t| t.len() < 16) {
            return Err(format!(
                "the token {short:?} is shorter than 16 characters — generate one with \
                 `openssl rand -hex 32`"
            ));
        }

        let max_entry_mb: usize = match env("AIW_KB_MAX_ENTRY_MB") {
            Some(raw) => raw
                .parse()
                .map_err(|e| format!("AIW_KB_MAX_ENTRY_MB is not a number ({raw:?}): {e}"))?,
            None => 64,
        };
        if max_entry_mb == 0 || max_entry_mb > 1024 {
            return Err("AIW_KB_MAX_ENTRY_MB must be between 1 and 1024".into());
        }

        Ok(Config {
            data_dir,
            bind,
            tokens,
            allow_anonymous,
            max_entry_bytes: max_entry_mb * 1024 * 1024,
        })
    }
}
