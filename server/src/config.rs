//! Runtime configuration: a TOML file, overridden by the environment.
//!
//! The first version of this server took every setting from an environment
//! variable and said so in a comment: "every deployment style it is likely to
//! meet already speaks environment variables". That was true of systemd and
//! docker and false of the case that turned out to matter — an operator on
//! Windows running the binary on their own machine, for whom setting six
//! environment variables is a trip through a dialog that does not survive being
//! forgotten. So the file is now the primary surface and the environment is the
//! override, in that order:
//!
//! ```text
//! built-in default  <  aiw-kb.toml  <  environment variable
//! ```
//!
//! Every resolved value remembers **which of the three it came from**
//! (`Source`), because the admin console has to be able to explain why a value
//! it can see in the file is not the value the server is running with. A config
//! page that silently shows the file's value while the process runs on an
//! environment override is worse than no config page.
//!
//! The file is also **written back to** by the admin console (`write_back`),
//! through `toml_edit` rather than by re-serializing: an operator's comments and
//! ordering are the part of a config file that carries their intent, and a UI
//! that erases them on the first save is one they stop using.

use std::collections::BTreeMap;
use std::fmt;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Where a resolved value actually came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Default,
    File,
    Env,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Default => "default",
            Source::File => "file",
            Source::Env => "env",
        }
    }
}

/// How the config file's path was chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PathOrigin {
    /// `--config <path>`
    Cli,
    /// `AIW_KB_CONFIG`
    Env,
    /// `aiw-kb.toml` next to the executable — the Windows double-click case.
    NextToExe,
    /// The platform's configuration directory.
    SystemDefault,
}

impl PathOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            PathOrigin::Cli => "cli",
            PathOrigin::Env => "env",
            PathOrigin::NextToExe => "next-to-exe",
            PathOrigin::SystemDefault => "system-default",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ServerSettings {
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    pub max_entry_mb: usize,
    /// Upload cap for one application-config backup, in MiB. Separate from
    /// `max_entry_mb` because the two resources are nothing alike: a lore entry
    /// carries a gallery of images and is measured in tens of megabytes, while a
    /// config envelope is a few tens of kilobytes of JSON. Sharing one number
    /// would mean the generous limit the first one needs also decides how much
    /// this endpoint will accept.
    pub config_max_mb: usize,
    /// How many versions of one config backup slot to keep.
    pub config_versions: usize,
    pub allow_anonymous: bool,
    pub log: String,
}

/// The admin console's single account.
///
/// The password is stored in clear text, which is a deliberate choice for this
/// deployment shape rather than an oversight: the same file already holds the
/// sync tokens in clear text (they have to be comparable to what a client
/// presents), the server is normally a box on the operator's own network, and
/// hashing would mean an operator who wants to set a password by editing the
/// file first has to run a subcommand to compute a hash — reintroducing the
/// command line this whole feature exists to remove. The protection is the
/// file's permissions, and the admin console checks them (see the health check).
#[derive(Debug, Clone)]
pub struct AdminSettings {
    pub username: String,
    pub password: String,
    pub session_hours: u64,
}

/// One bearer token for the sync API.
#[derive(Debug, Clone)]
pub struct TokenEntry {
    /// Stable handle for the admin API. Derived from the value rather than
    /// stored, so hand-editing the file cannot produce a token without one.
    pub id: String,
    pub name: String,
    pub value: String,
    pub created_at_ms: u64,
    /// True when this token came from `AIW_KB_TOKENS` and therefore cannot be
    /// edited by writing the file.
    pub from_env: bool,
}

impl TokenEntry {
    pub fn derive_id(value: &str) -> String {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(value.as_bytes());
        format!("{digest:x}")[..12].to_string()
    }

    /// The first few characters, for a list that should not shout the secret.
    pub fn prefix(&self) -> String {
        self.value.chars().take(6).collect()
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    /// The file this configuration was read from — whether or not it exists.
    pub file_path: PathBuf,
    pub file_origin: PathOrigin,
    pub file_exists: bool,
    /// Set when the file exists but could not be parsed; the server then runs on
    /// defaults + environment, and the admin console says so loudly.
    pub file_error: Option<String>,
    /// True when this run created the file because none was there.
    pub file_created: bool,
    pub server: ServerSettings,
    pub admin: Option<AdminSettings>,
    pub tokens: Vec<TokenEntry>,
    /// Per-key provenance, keyed by the dotted path used in the admin API
    /// (`server.bind`, `admin.username`, `tokens`).
    pub sources: BTreeMap<String, Source>,
}

impl Config {
    pub fn max_entry_bytes(&self) -> usize {
        self.server.max_entry_mb * 1024 * 1024
    }

    pub fn max_config_bytes(&self) -> usize {
        self.server.config_max_mb * 1024 * 1024
    }

    pub fn source_of(&self, key: &str) -> Source {
        self.sources.get(key).copied().unwrap_or(Source::Default)
    }
}

// ─── The file's shape ────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
struct RawFile {
    server: Option<RawServer>,
    admin: Option<RawAdmin>,
    #[serde(default)]
    tokens: Vec<RawToken>,
}

#[derive(Debug, Default, Deserialize)]
struct RawServer {
    bind: Option<String>,
    data_dir: Option<String>,
    max_entry_mb: Option<usize>,
    config_max_mb: Option<usize>,
    config_versions: Option<usize>,
    allow_anonymous: Option<bool>,
    log: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawAdmin {
    username: Option<String>,
    password: Option<String>,
    session_hours: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct RawToken {
    name: Option<String>,
    value: String,
    created_at_ms: Option<u64>,
}

// ─── Defaults ────────────────────────────────────────────────────────────────

pub const DEFAULT_BIND: &str = "127.0.0.1:8787";
pub const DEFAULT_DATA_DIR: &str = "./data";
pub const DEFAULT_MAX_ENTRY_MB: usize = 64;
pub const DEFAULT_CONFIG_MAX_MB: usize = 4;
pub const DEFAULT_CONFIG_VERSIONS: usize = 10;
pub const DEFAULT_LOG: &str = "aiw_kb_server=info,tower_http=info";
pub const DEFAULT_SESSION_HOURS: u64 = 168;

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

// ─── Loading ─────────────────────────────────────────────────────────────────

impl Config {
    /// Resolve the config file's path, read it, and layer the environment on
    /// top. `argv` is the process arguments, so `--config` can be honored
    /// without pulling in an argument parser for one flag.
    pub fn load(argv: &[String]) -> Result<Config, String> {
        let (file_path, file_origin) = resolve_path(argv)?;

        let mut file_exists = file_path.exists();
        let mut file_error = None;
        let mut file_created = false;

        // Nothing there at all: write a starter file rather than refusing to
        // start. The generated token and password are printed once by `main`.
        // This is still fail-closed — the server never comes up without
        // credentials — but it comes up, which is the difference between "it
        // works" and "read the manual first" on a machine with no shell open.
        if !file_exists {
            match write_starter(&file_path) {
                Ok(()) => {
                    file_exists = true;
                    file_created = true;
                }
                Err(e) => {
                    return Err(format!(
                        "no configuration file at {}, and it could not be created ({e}).\n\
                         Create it by hand, or point the server at a writable location with \
                         --config <path> or AIW_KB_CONFIG=<path>.",
                        file_path.display()
                    ));
                }
            }
        }

        let raw = if file_exists {
            match std::fs::read_to_string(&file_path) {
                Ok(text) => match toml::from_str::<RawFile>(&text) {
                    Ok(raw) => raw,
                    Err(e) => {
                        // Running on defaults is better than not running: the
                        // operator's way back in is the admin console, and
                        // refusing to boot takes it away exactly when a typo in
                        // the file is the thing they need to fix.
                        file_error = Some(e.to_string());
                        RawFile::default()
                    }
                },
                Err(e) => {
                    file_error = Some(e.to_string());
                    RawFile::default()
                }
            }
        } else {
            RawFile::default()
        };

        let mut sources = BTreeMap::new();
        let mut mark = |key: &str, source: Source| {
            sources.insert(key.to_string(), source);
        };

        let file_server = raw.server.unwrap_or_default();

        // bind
        let (bind_raw, bind_src) = pick(
            env("AIW_KB_BIND"),
            file_server.bind.clone(),
            DEFAULT_BIND.to_string(),
        );
        let bind: SocketAddr = bind_raw
            .parse()
            .map_err(|e| format!("`bind` is not a valid address ({bind_raw:?}): {e}"))?;
        mark("server.bind", bind_src);

        // data_dir
        let (data_dir_raw, data_src) = pick(
            env("AIW_KB_DATA_DIR"),
            file_server.data_dir.clone(),
            DEFAULT_DATA_DIR.to_string(),
        );
        mark("server.data_dir", data_src);

        // max_entry_mb
        let env_max = match env("AIW_KB_MAX_ENTRY_MB") {
            Some(raw) => Some(
                raw.parse::<usize>()
                    .map_err(|e| format!("AIW_KB_MAX_ENTRY_MB is not a number ({raw:?}): {e}"))?,
            ),
            None => None,
        };
        let (max_entry_mb, max_src) = pick(env_max, file_server.max_entry_mb, DEFAULT_MAX_ENTRY_MB);
        if max_entry_mb == 0 || max_entry_mb > 1024 {
            return Err("`max_entry_mb` must be between 1 and 1024".into());
        }
        mark("server.max_entry_mb", max_src);

        // config_max_mb
        let env_config_max = match env("AIW_KB_CONFIG_MAX_MB") {
            Some(raw) => Some(
                raw.parse::<usize>()
                    .map_err(|e| format!("AIW_KB_CONFIG_MAX_MB is not a number ({raw:?}): {e}"))?,
            ),
            None => None,
        };
        let (config_max_mb, config_max_src) = pick(
            env_config_max,
            file_server.config_max_mb,
            DEFAULT_CONFIG_MAX_MB,
        );
        if config_max_mb == 0 || config_max_mb > 64 {
            return Err("`config_max_mb` must be between 1 and 64".into());
        }
        mark("server.config_max_mb", config_max_src);

        // config_versions
        let env_versions =
            match env("AIW_KB_CONFIG_VERSIONS") {
                Some(raw) => Some(raw.parse::<usize>().map_err(|e| {
                    format!("AIW_KB_CONFIG_VERSIONS is not a number ({raw:?}): {e}")
                })?),
                None => None,
            };
        let (config_versions, versions_src) = pick(
            env_versions,
            file_server.config_versions,
            DEFAULT_CONFIG_VERSIONS,
        );
        if config_versions == 0 || config_versions > 100 {
            return Err("`config_versions` must be between 1 and 100".into());
        }
        mark("server.config_versions", versions_src);

        // allow_anonymous
        let env_anon = env("AIW_KB_ALLOW_ANONYMOUS").map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes"
        });
        let (allow_anonymous, anon_src) = pick(env_anon, file_server.allow_anonymous, false);
        mark("server.allow_anonymous", anon_src);

        // log
        let (log, log_src) = pick(
            env("RUST_LOG"),
            file_server.log.clone(),
            DEFAULT_LOG.to_string(),
        );
        mark("server.log", log_src);

        // admin
        let file_admin = raw.admin.unwrap_or_default();
        let env_user = env("AIW_KB_ADMIN_USER");
        let env_pass = env("AIW_KB_ADMIN_PASSWORD");
        let username = env_user.clone().or_else(|| file_admin.username.clone());
        let password = env_pass.clone().or_else(|| file_admin.password.clone());
        let admin = match (username, password) {
            (Some(u), Some(p)) if !u.trim().is_empty() && !p.is_empty() => {
                mark(
                    "admin.username",
                    if env_user.is_some() {
                        Source::Env
                    } else {
                        Source::File
                    },
                );
                mark(
                    "admin.password",
                    if env_pass.is_some() {
                        Source::Env
                    } else {
                        Source::File
                    },
                );
                let (session_hours, sh_src) =
                    pick(None, file_admin.session_hours, DEFAULT_SESSION_HOURS);
                mark("admin.session_hours", sh_src);
                Some(AdminSettings {
                    username: u.trim().to_string(),
                    password: p,
                    session_hours: session_hours.clamp(1, 24 * 365),
                })
            }
            // Half an account is no account: a username with no password would
            // otherwise mean "log in with an empty password".
            _ => None,
        };

        // tokens
        let env_tokens: Vec<String> = env("AIW_KB_TOKENS")
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let tokens: Vec<TokenEntry> = if !env_tokens.is_empty() {
            mark("tokens", Source::Env);
            env_tokens
                .iter()
                .enumerate()
                .map(|(i, value)| TokenEntry {
                    id: TokenEntry::derive_id(value),
                    name: format!("AIW_KB_TOKENS #{}", i + 1),
                    value: value.clone(),
                    created_at_ms: 0,
                    from_env: true,
                })
                .collect()
        } else {
            mark(
                "tokens",
                if raw.tokens.is_empty() {
                    Source::Default
                } else {
                    Source::File
                },
            );
            raw.tokens
                .iter()
                .map(|t| TokenEntry {
                    id: TokenEntry::derive_id(&t.value),
                    name: t.name.clone().unwrap_or_else(|| "未命名".into()),
                    value: t.value.clone(),
                    created_at_ms: t.created_at_ms.unwrap_or(0),
                    from_env: false,
                })
                .collect()
        };

        for token in &tokens {
            if token.value.len() < 16 {
                return Err(format!(
                    "the token {:?} is shorter than 16 characters — generate one with \
                     `openssl rand -hex 32`, or let the admin console create it",
                    token.name
                ));
            }
        }

        // Fail closed. An unauthenticated server that starts anyway is the kind
        // of default that ends up on a public IP, so refusing to boot is the
        // whole safeguard — and the opt-out is deliberately awkward to type.
        if tokens.is_empty() && !allow_anonymous {
            return Err(format!(
                "no sync tokens configured. Add a [[tokens]] entry to {}, or set \
                 allow_anonymous = true there to run without authentication (local trials only)",
                file_path.display()
            ));
        }

        Ok(Config {
            file_path,
            file_origin,
            file_exists,
            file_error,
            file_created,
            server: ServerSettings {
                bind,
                data_dir: PathBuf::from(data_dir_raw),
                max_entry_mb,
                config_max_mb,
                config_versions,
                allow_anonymous,
                log,
            },
            admin,
            tokens,
            sources,
        })
    }
}

/// Environment wins, then the file, then the built-in default.
fn pick<T>(from_env: Option<T>, from_file: Option<T>, fallback: T) -> (T, Source) {
    match (from_env, from_file) {
        (Some(v), _) => (v, Source::Env),
        (None, Some(v)) => (v, Source::File),
        (None, None) => (fallback, Source::Default),
    }
}

/// `--config <path>` > `AIW_KB_CONFIG` > next to the executable > platform dir.
fn resolve_path(argv: &[String]) -> Result<(PathBuf, PathOrigin), String> {
    let mut args = argv.iter().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--config" || arg == "-c" {
            let value = args
                .next()
                .ok_or_else(|| "--config needs a path".to_string())?;
            return Ok((PathBuf::from(value), PathOrigin::Cli));
        }
        if let Some(value) = arg.strip_prefix("--config=") {
            return Ok((PathBuf::from(value), PathOrigin::Cli));
        }
    }
    if let Some(value) = env("AIW_KB_CONFIG") {
        return Ok((PathBuf::from(value), PathOrigin::Env));
    }
    // Next to the executable first, because that is the shape of the case this
    // file exists for: a binary someone unzipped into a folder and ran.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("aiw-kb.toml");
            if candidate.exists() {
                return Ok((candidate, PathOrigin::NextToExe));
            }
        }
    }
    Ok((system_default_path(), PathOrigin::SystemDefault))
}

fn system_default_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(appdata) = env("APPDATA") {
            return PathBuf::from(appdata).join("aiw-kb").join("config.toml");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = env("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("aiw-kb")
                .join("config.toml");
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // A system install writes /etc; a user running it from their shell
        // cannot, and falling back to their config dir is better than failing.
        let etc = PathBuf::from("/etc/aiw-kb/config.toml");
        if etc.exists() {
            return etc;
        }
        if let Some(home) = env("HOME") {
            return PathBuf::from(home)
                .join(".config")
                .join("aiw-kb")
                .join("config.toml");
        }
    }
    PathBuf::from("aiw-kb.toml")
}

// ─── Secrets ─────────────────────────────────────────────────────────────────

/// `bytes` bytes of system entropy as lowercase hex.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).expect("the operating system has no entropy source");
    let mut out = String::with_capacity(bytes * 2);
    for b in buf {
        use fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// A generated sync token. The `aiw_` prefix is there so one found in a log or
/// a config file elsewhere is recognizable as this server's.
pub fn generate_token() -> String {
    format!("aiw_{}", random_hex(24))
}

/// A password a human has to be able to read off a console and type once.
/// Ambiguous glyphs are left out on purpose — this string gets read aloud,
/// copied off a screenshot, and typed on a phone.
pub fn generate_password() -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("the operating system has no entropy source");
    buf.iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The `data_dir` a *generated* config file gets: `data/` beside the config
/// file itself, as an absolute-as-the-config-path string.
///
/// The runtime default (`DEFAULT_DATA_DIR`, resolved against the working
/// directory) is kept for files that simply omit the key — but writing that
/// relative form into a fresh file would tie the data's location to wherever
/// the process happened to be started from. On Windows that is the difference
/// between `%APPDATA%\aiw-kb\data` (the config file's own home) and a `data\`
/// folder materialising beside whatever launched the exe. Forward slashes on
/// purpose: valid in a TOML basic string on every platform, where a Windows
/// `\` would be an escape.
fn starter_data_dir(config_path: &Path) -> String {
    match config_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent
            .join("data")
            .to_string_lossy()
            .replace('\\', "/")
            .to_string(),
        _ => DEFAULT_DATA_DIR.to_string(),
    }
}

/// Write a first config file, with credentials generated here.
///
/// The comments matter as much as the values: this file is the manual for
/// anyone who opens it, and it is the only manual a Windows operator who
/// double-clicked the binary will ever see.
fn write_starter(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let data_dir = starter_data_dir(path);
    let token = generate_token();
    let password = generate_password();
    let created = now_ms();
    let text = format!(
        r#"# aiw-kb-server 配置文件
#
# 环境变量优先于这里的值（AIW_KB_BIND / AIW_KB_DATA_DIR / AIW_KB_TOKENS …）。
# 管理后台在 http://<地址>/admin —— 这个文件里的任何一项都能在那里改。

[server]
# 监听地址。默认只听回环：知识库是作者自己的创作，不该因为"先跑起来看看"就上了网。
# 要让局域网里的其他机器连上，改成 "0.0.0.0:8787"，并且**务必**在前面套一层 TLS。
bind = "{DEFAULT_BIND}"

# 数据目录。整个目录打包就是一次完整备份，没有数据库、不需要停机。
data_dir = "{data_dir}"

# 单个条目（含配图）的上传上限，单位 MB。改大它时记得同步调大反向代理的 body 上限。
max_entry_mb = {DEFAULT_MAX_ENTRY_MB}

# 应用配置备份（供应商 / 模型 / Prompt / 偏好）的单次上传上限，单位 MB。
# 一份配置只有几十 KB，这里给得宽只是为了不误伤，不是为了当上传通道用。
config_max_mb = {DEFAULT_CONFIG_MAX_MB}

# 每个配置备份档保留几个历史版本。旧版本在新版本落盘之后才裁掉。
config_versions = {DEFAULT_CONFIG_VERSIONS}

# true = 关闭同步 API 的鉴权。仅用于本机试跑——打开它，任何能访问到这台机器的人
# 都能读写全部知识库。
allow_anonymous = false

# 日志级别。想看每个请求：改成 "aiw_kb_server=debug,tower_http=debug"。
log = "{DEFAULT_LOG}"

# 管理后台的登录账号。密码是明文的：这个文件里本来就明文存着下面的 token，
# 保护它的是文件权限（Linux 上 chmod 600），不是加密。
[admin]
username = "admin"
password = "{password}"
# 登录后会话保持多久（小时）。
session_hours = {DEFAULT_SESSION_HOURS}

# 同步 API 的 bearer token —— app 里填的就是它。可以有多个，轮换时新旧并存。
[[tokens]]
name = "第一台设备"
value = "{token}"
created_at_ms = {created}
"#
    );
    std::fs::write(path, text)?;
    harden_permissions(path);
    Ok(())
}

/// Make a newly written config readable only by its owner.
///
/// Best-effort, and only on Unix: it holds the sync tokens and the admin
/// password, and the default umask on a shared box would otherwise leave it
/// world-readable. On Windows the inherited ACL is what it is — the admin
/// console's health check reports the situation rather than pretending to fix it.
pub fn harden_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starter_data_dir_lands_beside_the_config_file() {
        // A Windows path only parses as one on Windows — `\` is not a
        // separator to a Unix `Path`, so this half stays off the ubuntu CI.
        #[cfg(windows)]
        assert_eq!(
            starter_data_dir(Path::new(r"C:\Users\a\AppData\Roaming\aiw-kb\config.toml")),
            "C:/Users/a/AppData/Roaming/aiw-kb/data"
        );
        assert_eq!(
            starter_data_dir(Path::new("/home/a/.config/aiw-kb/config.toml")),
            "/home/a/.config/aiw-kb/data"
        );
        // The bare-filename fallback keeps the runtime default, not "" + /data.
        assert_eq!(starter_data_dir(Path::new("aiw-kb.toml")), DEFAULT_DATA_DIR);
    }

    #[test]
    fn a_generated_file_parses_and_carries_its_own_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        write_starter(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let raw: RawFile = toml::from_str(&text).expect("the starter must be valid TOML");
        let expected = dir.path().join("data").to_string_lossy().replace('\\', "/");
        assert_eq!(raw.server.unwrap().data_dir.unwrap(), expected);
        assert!(raw.tokens.first().unwrap().value.starts_with("aiw_"));
    }
}
