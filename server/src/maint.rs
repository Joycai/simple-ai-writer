//! Maintenance: the things an operator used to need a shell for.
//!
//! Every function here corresponds to a line in `DEPLOY.md` that told a person
//! to ssh in and run something — `du`, `tar`, `rm tmp/*`, "check it isn't
//! running as root". None of them is clever; the point is that they exist at
//! all, because a maintenance step that requires a terminal is a maintenance
//! step that does not happen on the machine under the stairs.
//!
//! The two rules they all follow:
//!
//! **Nothing here deletes anything the sync protocol can see.** Staging files
//! and superseded payloads are, by construction, files no client can name.
//! Deleting a *live* entry is an ordinary API call with a confirmation in front
//! of it, not maintenance.
//!
//! **Checks report, they do not fix.** A check that quietly rewrote the config
//! would be a second, invisible writer of the file the console lets you edit.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::config::Config;

// ─── Disk ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct DiskUsage {
    /// Absolute path of the data directory, as the process sees it.
    pub path: String,
    /// The whole filesystem, not the data directory — an operator asking "will
    /// the next upload fit" is asking about the partition.
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "availableBytes")]
    pub available_bytes: u64,
    /// What this server's own data occupies, summed from the payloads —
    /// knowledge bases *and* config backups. Both, because the number answers
    /// "how much of this partition is us", and a figure that quietly left out
    /// one of the two resources would be wrong in the one direction that
    /// matters.
    #[serde(rename = "dataBytes")]
    pub data_bytes: u64,
    /// The config-backup share of `data_bytes`, broken out so the maintenance
    /// page can show where it went.
    #[serde(rename = "configBytes")]
    pub config_bytes: u64,
    #[serde(rename = "byKb")]
    pub by_kb: Vec<KbUsage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KbUsage {
    pub id: String,
    pub name: String,
    pub bytes: u64,
}

pub fn disk_usage(data_dir: &Path, by_kb: Vec<KbUsage>, config_bytes: u64) -> DiskUsage {
    let absolute = std::fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
    let total = fs2::total_space(&absolute).unwrap_or(0);
    let available = fs2::available_space(&absolute).unwrap_or(0);
    DiskUsage {
        path: absolute.display().to_string(),
        total_bytes: total,
        available_bytes: available,
        data_bytes: by_kb.iter().map(|k| k.bytes).sum::<u64>() + config_bytes,
        config_bytes,
        by_kb,
    }
}

// ─── Backup ──────────────────────────────────────────────────────────────────

/// Stream a directory as a gzipped tar.
///
/// Streamed rather than assembled: a data directory is measured in gigabytes,
/// and building the archive in memory to hand back one `Vec<u8>` would decide
/// how large a backup may be by how much RAM the box has.
///
/// **No lock is taken, deliberately.** Every payload is committed by `rename`,
/// so the archive can never contain a half-written file. What it *can* contain
/// is a knowledge base captured mid-sync — some entries from before a push,
/// some from after. Holding every base's write lock for the minutes a large tar
/// takes would block the app instead, which is a worse trade for a backup whose
/// whole purpose is that it runs without stopping anything.
pub fn spawn_tar_gz(root: PathBuf, prefix: String) -> tokio::io::DuplexStream {
    // 256 KiB of slack between the compressor and the socket: enough that a
    // brief stall on either side does not ping-pong, small enough to be free.
    let (writer, reader) = tokio::io::duplex(256 * 1024);
    tokio::task::spawn_blocking(move || {
        use tokio_util::io::SyncIoBridge;
        let bridge = SyncIoBridge::new(writer);
        // `fast` rather than `default`: these are zip files already, so the
        // second pass buys a percent or two and costs the whole transfer's
        // wall-clock on a NAS with a slow CPU.
        let encoder = flate2::write::GzEncoder::new(bridge, flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        builder.follow_symlinks(false);
        if let Err(e) = builder.append_dir_all(&prefix, &root) {
            tracing::warn!("backup archive failed part-way through: {e}");
            return;
        }
        match builder.into_inner().and_then(|enc| enc.finish()) {
            Ok(_) => {}
            Err(e) => tracing::warn!("backup archive could not be finished: {e}"),
        }
    });
    reader
}

// ─── Health check ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckState {
    Pass,
    Warn,
    Fail,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub label: String,
    pub state: CheckState,
    /// What to do about it, when there is something to do.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// A snippet the console offers to copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

/// Run the pre-flight list from `DEPLOY.md` §9.
///
/// `forwarded_proto` is what the reverse proxy said about the scheme on the
/// request that asked for this check — the only way this process can know
/// whether anything in front of it terminates TLS, since it never does itself.
/// `unauthenticated_status` is the result of an actual request this server made
/// to itself; a checklist item that reasons about the code instead of trying it
/// is a checklist item that stays green after the code changes.
pub fn run_checks(
    config: &Config,
    forwarded_proto: Option<&str>,
    unauthenticated_status: Option<u16>,
) -> Vec<Check> {
    let mut checks = Vec::new();

    checks.push(match forwarded_proto {
        Some("https") => Check {
            id: "tls",
            label: "经由 TLS 访问（反向代理已加密）".into(),
            state: CheckState::Pass,
            detail: None,
            fix: None,
        },
        _ if config.server.bind.ip().is_loopback() => Check {
            id: "tls",
            label: "只监听回环，未经网络暴露".into(),
            state: CheckState::Pass,
            detail: Some(
                "bind 是回环地址，只有这台机器上的进程能连上，不需要 TLS。要让别的机器连，\
                 改成 0.0.0.0 之前先套一层 TLS。"
                    .into(),
            ),
            fix: None,
        },
        _ => Check {
            id: "tls",
            label: "这次访问不是 HTTPS".into(),
            state: CheckState::Warn,
            detail: Some(
                "bearer token 和后台密码都是明文发的，同一个网络里抓包就能拿到。\
                 这个进程不做 TLS —— 请在前面放一层反向代理。"
                    .into(),
            ),
            fix: Some(
                "# Caddy（自动申请证书）\nlore.example.com {\n\treverse_proxy 127.0.0.1:8787\n}"
                    .into(),
            ),
        },
    });

    checks.push(check_not_root());

    checks.push(if config.server.allow_anonymous {
        Check {
            id: "anonymous",
            label: "同步 API 未启用鉴权（allow_anonymous = true）".into(),
            state: CheckState::Fail,
            detail: Some(
                "任何能访问到这台机器的人都能读写全部知识库。仅在本机试跑时才该是这样。".into(),
            ),
            fix: Some("[server]\nallow_anonymous = false".into()),
        }
    } else {
        Check {
            id: "anonymous",
            label: format!("同步 API 需要鉴权（{} 个 token）", config.tokens.len()),
            state: CheckState::Pass,
            detail: None,
            fix: None,
        }
    });

    checks.push(check_config_permissions(config));

    checks.push(Check {
        id: "body-limit",
        label: format!("单条目上限 {} MB", config.server.max_entry_mb),
        state: CheckState::Unknown,
        detail: Some(
            "这个进程看不到反向代理的 body 上限。如果代理那边比这里小，413 会由代理先返回，\
             而且它的报错不会说明原因。"
                .into(),
        ),
        fix: Some(format!(
            "# nginx\nclient_max_body_size {}m;\nproxy_request_buffering off;\n\n# Caddy\nrequest_body {{\n\tmax_size {}MB\n}}",
            config.server.max_entry_mb, config.server.max_entry_mb
        )),
    });

    checks.push(match unauthenticated_status {
        Some(401) => Check {
            id: "unauthenticated",
            label: "无凭据访问 /v1/kbs 返回 401（实测）".into(),
            state: CheckState::Pass,
            detail: None,
            fix: None,
        },
        Some(status) if config.server.allow_anonymous => Check {
            id: "unauthenticated",
            label: format!("无凭据访问 /v1/kbs 返回 {status}（实测）"),
            state: CheckState::Fail,
            detail: Some("匿名模式开着，所以它当然通过了。关掉它再测一次。".into()),
            fix: None,
        },
        Some(status) => Check {
            id: "unauthenticated",
            label: format!("无凭据访问 /v1/kbs 返回 {status}，而不是 401（实测）"),
            state: CheckState::Fail,
            detail: Some("鉴权没有在拦。这是一个真正的漏洞，别放着不管。".into()),
            fix: None,
        },
        None => Check {
            id: "unauthenticated",
            label: "无凭据访问 /v1/kbs（探测失败）".into(),
            state: CheckState::Unknown,
            detail: Some(
                "服务端连不上自己的监听地址。如果 bind 是 0.0.0.0 而机器有防火墙，这是正常的。"
                    .into(),
            ),
            fix: None,
        },
    });

    checks
}

#[cfg(unix)]
fn check_not_root() -> Check {
    // SAFETY: `geteuid` takes no arguments, touches no memory and cannot fail.
    let uid = unsafe { libc::geteuid() };
    if uid == 0 {
        Check {
            id: "not-root",
            label: "正在以 root 运行".into(),
            state: CheckState::Warn,
            detail: Some(
                "它只需要读自己的二进制、写数据目录、开一个端口。给它一个专用账号，\
                 一次被利用的读文件漏洞就只能读到知识库，而不是整台机器。"
                    .into(),
            ),
            fix: Some(
                "# systemd 单元里\nDynamicUser=yes\nStateDirectory=aiw-kb\nProtectSystem=strict\nPrivateTmp=yes"
                    .into(),
            ),
        }
    } else {
        Check {
            id: "not-root",
            label: format!("未以 root 运行（uid {uid}）"),
            state: CheckState::Pass,
            detail: None,
            fix: None,
        }
    }
}

#[cfg(not(unix))]
fn check_not_root() -> Check {
    Check {
        id: "not-root",
        label: "运行账户（Windows 上不检查）".into(),
        state: CheckState::Unknown,
        detail: Some("请确认它不是以管理员身份常驻运行。".into()),
        fix: None,
    }
}

#[cfg(unix)]
fn check_config_permissions(config: &Config) -> Check {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(&config.file_path) else {
        return Check {
            id: "config-perms",
            label: "配置文件权限（读不到这个文件）".into(),
            state: CheckState::Unknown,
            detail: None,
            fix: None,
        };
    };
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        Check {
            id: "config-perms",
            label: format!("配置文件权限过于开放（{mode:04o}）"),
            state: CheckState::Warn,
            detail: Some(
                "它明文存着全部同步 token 和后台密码。这台机器上的其他账号现在都能读到。".into(),
            ),
            fix: Some(format!("chmod 600 {}", config.file_path.display())),
        }
    } else {
        Check {
            id: "config-perms",
            label: format!("配置文件仅属主可读（{mode:04o}）"),
            state: CheckState::Pass,
            detail: None,
            fix: None,
        }
    }
}

#[cfg(not(unix))]
fn check_config_permissions(config: &Config) -> Check {
    Check {
        id: "config-perms",
        label: "配置文件权限（Windows 上不检查）".into(),
        state: CheckState::Unknown,
        detail: Some(format!(
            "{} 里明文存着全部同步 token 和后台密码。请确认它不在共享目录里，\
             并且 Users 组读不到它。",
            config.file_path.display()
        )),
        fix: None,
    }
}

/// Ask our own listener what an unauthenticated request gets.
///
/// A hand-rolled HTTP/1.0 request over a raw socket rather than a client crate:
/// it is one request to one known URL on localhost, and the status line is the
/// only part of the answer anyone reads.
pub async fn probe_unauthenticated(bind: std::net::SocketAddr) -> Option<u16> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // A wildcard bind is not connectable as an address; loopback is where this
    // process is certainly listening.
    let target = if bind.ip().is_unspecified() {
        std::net::SocketAddr::new(
            if bind.is_ipv6() {
                std::net::Ipv6Addr::LOCALHOST.into()
            } else {
                std::net::Ipv4Addr::LOCALHOST.into()
            },
            bind.port(),
        )
    } else {
        bind
    };

    let connect = tokio::net::TcpStream::connect(target);
    let mut stream = tokio::time::timeout(std::time::Duration::from_secs(2), connect)
        .await
        .ok()?
        .ok()?;
    stream
        .write_all(b"GET /v1/kbs HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .await
        .ok()?;
    let mut buf = [0u8; 64];
    let read = tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut buf))
        .await
        .ok()?
        .ok()?;
    let head = String::from_utf8_lossy(&buf[..read]);
    head.split_whitespace().nth(1)?.parse().ok()
}
