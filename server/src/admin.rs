//! The admin console: `/admin` (a page) and `/admin/api/*` (what it calls).
//!
//! ## Why this is a second surface and not a corner of `/v1`
//!
//! The sync API is spoken by the app, authenticated with a random bearer token,
//! and every machine running the app holds one. The console is spoken by a
//! person, authenticated with a password, and it can delete a knowledge base.
//! Collapsing the two would mean every laptop with the app installed carries a
//! credential that can wipe the server — so a sync token cannot log in here, a
//! session cookie is refused by `/v1`, and neither check knows about the other.
//!
//! The one exception is `allow_anonymous`, which turns off authentication for
//! *both*. It is the "I am running this on my own machine to see what it does"
//! switch, and a console that still demanded a password in that mode would just
//! be a locked door on a house with no walls.
//!
//! ## Why the page is three files and no build step
//!
//! `index.html`, `app.css` and `app.js` are `include_str!`-ed into the binary.
//! No npm, no bundler, no `dist/` that can be stale relative to the source. The
//! console is a few thousand lines of vanilla JavaScript, which is well within
//! what one file can carry, and the alternative — a frontend toolchain in a
//! repository whose server half deliberately has five dependencies — would cost
//! more than it returns. It also means `cargo build` is the whole build.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::audit::{AuditEvent, AuditFilter, EntryLog};
use crate::confedit::{self, Setting};
use crate::config::{self, Source, TokenEntry};
use crate::error::ApiError;
use crate::maint;
use crate::routes::AppState;
use crate::session::{LoginAttempt, LoginOutcome, COOKIE_NAME};
use crate::store::KbSummary;

const INDEX_HTML: &str = include_str!("../admin/index.html");
const APP_CSS: &str = include_str!("../admin/app.css");
const APP_JS: &str = include_str!("../admin/app.js");

/// The logged-in operator, attached by `require_session`.
#[derive(Clone)]
pub struct CurrentUser {
    pub username: String,
    /// Empty in anonymous mode, where there is no session to speak of.
    pub session_id: String,
}

pub fn router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .route("/admin/api/overview", get(overview))
        .route("/admin/api/kbs", get(list_kbs).post(create_kb))
        .route(
            "/admin/api/kbs/{kb}",
            get(kb_detail).patch(rename_kb).delete(delete_kb),
        )
        .route("/admin/api/kbs/{kb}/backup.tar.gz", get(kb_backup))
        .route("/admin/api/kbs/{kb}/entries/delete", post(delete_entries))
        .route(
            "/admin/api/kbs/{kb}/entries/{category}/{id}",
            get(download_entry).delete(delete_entry),
        )
        .route("/admin/api/tokens", get(list_tokens).post(create_token))
        .route(
            "/admin/api/tokens/{id}",
            delete(revoke_token).patch(rename_token),
        )
        .route("/admin/api/tokens/{id}/reveal", get(reveal_token))
        .route("/admin/api/activity", get(activity))
        .route("/admin/api/maintenance", get(maintenance))
        .route("/admin/api/maintenance/clear-tmp", post(clear_tmp))
        .route("/admin/api/maintenance/dedupe", post(dedupe))
        .route("/admin/api/backup.tar.gz", get(full_backup))
        .route("/admin/api/checks", get(checks))
        .route("/admin/api/config", get(read_config).put(write_config))
        .route("/admin/api/restart", post(restart))
        .route("/admin/api/logout", post(logout))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            require_session,
        ));

    Router::new()
        // Outside the session layer, obviously: this is where you go to get one.
        .route("/admin/api/login", post(login))
        .route("/admin/api/session", get(whoami))
        .merge(api)
        .with_state(state)
        // The page itself is public. It is a login form until the API answers,
        // and gating it would only mean serving a 401 to a browser that has no
        // way to render one.
        .route("/admin", get(|| async { redirect("/admin/") }))
        .route(
            "/admin/",
            get(|| async { asset(INDEX_HTML, "text/html; charset=utf-8") }),
        )
        .route(
            "/admin/app.css",
            get(|| async { asset(APP_CSS, "text/css; charset=utf-8") }),
        )
        .route(
            "/admin/app.js",
            get(|| async { asset(APP_JS, "text/javascript; charset=utf-8") }),
        )
}

fn redirect(to: &'static str) -> Response {
    (
        StatusCode::TEMPORARY_REDIRECT,
        [(header::LOCATION, HeaderValue::from_static(to))],
    )
        .into_response()
}

fn asset(body: &'static str, content_type: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            // The assets are compiled in, so their identity is the binary's.
            // No-cache rather than a long max-age: an operator who upgrades the
            // server and gets yesterday's console has a bug report nobody can
            // reproduce.
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-cache, must-revalidate"),
            ),
        ],
        body,
    )
        .into_response()
}

// ─── Session ─────────────────────────────────────────────────────────────────

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
}

fn forwarded_proto(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').next().unwrap_or(v).trim().to_ascii_lowercase())
}

fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| "本机".into())
}

fn unauthorized() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录管理后台")
}

async fn require_session(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let anonymous = state.config().server.allow_anonymous;
    if anonymous {
        request.extensions_mut().insert(CurrentUser {
            username: "匿名".into(),
            session_id: String::new(),
        });
        return Ok(next.run(request).await);
    }

    let id = cookie_value(request.headers(), COOKIE_NAME).ok_or_else(unauthorized)?;
    let session = state.sessions.touch(&id).ok_or_else(unauthorized)?;
    request.extensions_mut().insert(CurrentUser {
        username: session.username,
        session_id: id,
    });
    Ok(next.run(request).await)
}

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
}

async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Result<Response, ApiError> {
    let (admin, session_hours) = {
        let config = state.config();
        match &config.admin {
            Some(admin) => (
                (admin.username.clone(), admin.password.clone()),
                admin.session_hours,
            ),
            None => {
                return Err(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "admin_disabled",
                    format!(
                        "配置文件里没有 [admin] 段，管理后台是关着的。在 {} 里加上 \
                         username 和 password，然后重启服务。",
                        config.file_path.display()
                    ),
                ))
            }
        }
    };

    let agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let outcome = state.sessions.login(LoginAttempt {
        presented_user: &body.username,
        presented_password: &body.password,
        expected_user: &admin.0,
        expected_password: &admin.1,
        session_hours,
        agent,
        ip: &client_ip(&headers),
    });

    match outcome {
        LoginOutcome::Ok(id) => {
            let secure = forwarded_proto(&headers).as_deref() == Some("https");
            let cookie = format!(
                "{COOKIE_NAME}={id}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age={}{}",
                session_hours * 3600,
                if secure { "; Secure" } else { "" }
            );
            state.audit.record(AuditEvent {
                at_ms: now_ms(),
                action: "admin-login".into(),
                kb: None,
                path: None,
                device: Some(client_ip(&headers)),
                token: None,
                status: 200,
                detail: None,
            });
            Ok((
                [(header::SET_COOKIE, cookie)],
                Json(json!({ "username": admin.0 })),
            )
                .into_response())
        }
        LoginOutcome::Wrong => {
            state.audit.record(AuditEvent {
                at_ms: now_ms(),
                action: "admin-login".into(),
                kb: None,
                path: None,
                device: Some(client_ip(&headers)),
                token: None,
                status: 401,
                detail: Some("用户名或密码不正确".into()),
            });
            Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "bad_credentials",
                "用户名或密码不正确",
            ))
        }
        LoginOutcome::Locked(remaining_ms) => Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "locked_out",
            format!("失败次数过多，请在 {} 后重试", human_duration(remaining_ms)),
        )),
    }
}

async fn logout(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    if !user.session_id.is_empty() {
        state.sessions.revoke(&user.session_id);
    }
    (
        [(
            header::SET_COOKIE,
            format!("{COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0"),
        )],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

/// Who am I — the SPA's first call, and the one that decides login vs console.
async fn whoami(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Json<Value> {
    let config = state.config();
    let anonymous = config.server.allow_anonymous;
    let configured = config.admin.is_some();
    drop(config);

    if anonymous {
        return Json(json!({
            "authenticated": true,
            "anonymous": true,
            "username": "匿名",
            "adminConfigured": configured,
        }));
    }
    let session = cookie_value(&headers, COOKIE_NAME).and_then(|id| state.sessions.touch(&id));
    Json(json!({
        "authenticated": session.is_some(),
        "anonymous": false,
        "adminConfigured": configured,
        "username": session.as_ref().map(|s| s.username.clone()),
        "expiresAtMs": session.as_ref().map(|s| s.expires_at_ms),
        "lockedForMs": state.sessions.locked_for(),
    }))
}

// ─── Overview ────────────────────────────────────────────────────────────────

async fn overview(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let handle = Arc::clone(&state);
    let (summaries, strays, duplicates) = blocking(move || {
        let summaries = handle.store.list_kbs().unwrap_or_default();
        let strays = handle.store.stray_staging();
        let duplicates = handle.store.duplicate_payloads();
        (summaries, strays, duplicates)
    })
    .await?;

    let handle = Arc::clone(&state);
    let sizes: Vec<(String, u64)> = {
        let ids: Vec<String> = summaries.iter().map(|s| s.meta.id.clone()).collect();
        blocking(move || {
            ids.into_iter()
                .map(|id| {
                    let bytes = handle.store.kb_bytes(&id);
                    (id, bytes)
                })
                .collect()
        })
        .await?
    };

    let config = state.config();
    let disk_available = std::fs::canonicalize(&config.server.data_dir)
        .ok()
        .and_then(|p| fs2::available_space(&p).ok());
    let disk_total = std::fs::canonicalize(&config.server.data_dir)
        .ok()
        .and_then(|p| fs2::total_space(&p).ok());

    let mut notices: Vec<Value> = Vec::new();
    if config.server.allow_anonymous {
        notices.push(json!({
            "id": "anonymous",
            "level": "error",
            "title": "匿名模式开着",
            "body": "任何人都能读写全部知识库。若在公网，等于全盘公开。",
            "action": "config",
            "actionLabel": "查看关闭方法",
        }));
    }
    if let Some(error) = &config.file_error {
        notices.push(json!({
            "id": "config-broken",
            "level": "error",
            "title": "配置文件解析失败，正在用默认值运行",
            "body": format!("{}：{error}", config.file_path.display()),
            "action": "config",
            "actionLabel": "去配置页",
        }));
    }
    if !config_writable(&config.file_path) {
        notices.push(json!({
            "id": "config-readonly",
            "level": "warn",
            "title": "配置文件不可写",
            "body": format!(
                "{} 写不了，后台里的改动保存不下去。手工编辑它，或者改掉它的权限。",
                config.file_path.display()
            ),
            "action": "config",
            "actionLabel": "去配置页",
        }));
    }
    if !strays.is_empty() {
        let bytes: u64 = strays.iter().map(|s| s.size).sum();
        notices.push(json!({
            "id": "tmp",
            "level": "warn",
            "title": format!("tmp/ 有 {} 个残留文件（{}）", strays.len(), human_bytes(bytes)),
            "body": "中断上传留下的暂存，不含任何已提交数据，可随时清空。",
            "action": "maintenance",
            "actionLabel": "去维护页清理",
        }));
    }
    if !duplicates.is_empty() {
        notices.push(json!({
            "id": "duplicates",
            "level": "warn",
            "title": format!("{} 个条目存在两个 zip", duplicates.len()),
            "body": "服务端按 mtime 取新的，下次写入会自清。手动清理只是提前回收空间。",
            "action": "maintenance",
            "actionLabel": "去维护页处理",
        }));
    }
    if let (Some(available), Some(total)) = (disk_available, disk_total) {
        if total > 0 && available * 10 < total {
            notices.push(json!({
                "id": "disk",
                "level": "warn",
                "title": format!(
                    "磁盘剩余 {}%（{}）",
                    available * 100 / total,
                    human_bytes(available)
                ),
                "body": "数据目录所在分区快满了。写入失败会返回 storage_error。",
                "action": "maintenance",
                "actionLabel": "查看按库占用",
            }));
        }
    }

    let day_ago = now_ms().saturating_sub(24 * 3_600_000);
    let response = json!({
        "server": {
            "version": env!("CARGO_PKG_VERSION"),
            "startedAtMs": state.started_at_ms,
            "uptimeMs": now_ms().saturating_sub(state.started_at_ms),
            "bind": config.server.bind.to_string(),
            "dataDir": config.server.data_dir.display().to_string(),
            "configPath": config.file_path.display().to_string(),
            "anonymous": config.server.allow_anonymous,
        },
        "stats": {
            "kbs": summaries.len(),
            "entries": summaries.iter().map(|s| s.entry_count).sum::<usize>(),
            "bytes": sizes.iter().map(|(_, b)| *b).sum::<u64>(),
            "writes24h": state.audit.write_count_since(day_ago),
        },
        "notices": notices,
        "recent": state.audit.query(&AuditFilter { limit: 8, ..Default::default() }),
    });
    Ok(Json(response))
}

fn config_writable(path: &std::path::Path) -> bool {
    std::fs::OpenOptions::new().append(true).open(path).is_ok()
}

// ─── Knowledge bases ─────────────────────────────────────────────────────────

fn kb_json(summary: &KbSummary, bytes: u64, digest: Option<String>) -> Value {
    json!({
        "id": summary.meta.id,
        "name": summary.meta.name,
        "createdAtMs": summary.meta.created_at_ms,
        "entryCount": summary.entry_count,
        "updatedAtMs": summary.updated_at_ms,
        "lastDevice": summary.last_device,
        "bytes": bytes,
        "digest": digest,
    })
}

async fn list_kbs(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let handle = Arc::clone(&state);
    let rows = blocking(move || {
        let summaries = handle.store.list_kbs().unwrap_or_default();
        summaries
            .into_iter()
            .map(|summary| {
                let bytes = handle.store.kb_bytes(&summary.meta.id);
                // The digest is what tells an operator two machines are in step,
                // so it is worth the extra walk on a page that lists three rows.
                let digest = handle
                    .store
                    .manifest(&summary.meta.id)
                    .ok()
                    .map(|m| m.digest);
                kb_json(&summary, bytes, digest)
            })
            .collect::<Vec<_>>()
    })
    .await?;
    Ok(Json(json!({ "kbs": rows })))
}

#[derive(Deserialize)]
struct CreateKbBody {
    name: String,
    id: Option<String>,
}

async fn create_kb(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<CreateKbBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let handle = Arc::clone(&state);
    let id = body.id.clone();
    let summary = blocking(move || handle.store.create_kb(&body.name, id.as_deref())).await??;
    state.audit.record(AuditEvent {
        at_ms: now_ms(),
        action: "create-kb".into(),
        kb: Some(summary.meta.id.clone()),
        path: None,
        device: Some(format!("管理后台 · {}", user.username)),
        token: None,
        status: 201,
        detail: None,
    });
    Ok((StatusCode::CREATED, Json(kb_json(&summary, 0, None))))
}

async fn kb_detail(
    State(state): State<Arc<AppState>>,
    Path(kb): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let handle = Arc::clone(&state);
    let (manifest, bytes) = blocking(move || {
        let manifest = handle.store.manifest(&kb);
        let bytes = handle.store.kb_bytes(&kb);
        (manifest, bytes)
    })
    .await?;
    let manifest = manifest?;

    // Category counts are computed here rather than in the page: the page would
    // have to walk the same array to get them, and on a base with a few thousand
    // entries that is a walk per keystroke in the filter box.
    let mut categories: Vec<(String, usize, u64)> = Vec::new();
    for entry in &manifest.entries {
        let category = entry.path.split('/').next().unwrap_or("").to_string();
        match categories.iter_mut().find(|(name, _, _)| *name == category) {
            Some(row) => {
                row.1 += 1;
                row.2 += entry.size;
            }
            None => categories.push((category, 1, entry.size)),
        }
    }
    categories.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));

    Ok(Json(json!({
        "kb": kb_json(&manifest.kb, bytes, Some(manifest.digest.clone())),
        "categories": categories
            .into_iter()
            .map(|(name, count, bytes)| json!({ "name": name, "count": count, "bytes": bytes }))
            .collect::<Vec<_>>(),
        "entries": manifest.entries,
    })))
}

#[derive(Deserialize)]
struct RenameKbBody {
    name: String,
}

async fn rename_kb(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<CurrentUser>,
    Path(kb): Path<String>,
    Json(body): Json<RenameKbBody>,
) -> Result<Json<Value>, ApiError> {
    let handle = Arc::clone(&state);
    let id = kb.clone();
    let summary = blocking(move || handle.store.rename_kb(&id, &body.name)).await??;
    state.audit.record(AuditEvent {
        at_ms: now_ms(),
        action: "rename-kb".into(),
        kb: Some(kb),
        path: None,
        device: Some(format!("管理后台 · {}", user.username)),
        token: None,
        status: 200,
        detail: Some(format!("改名为 {}", summary.meta.name)),
    });
    Ok(Json(kb_json(&summary, 0, None)))
}

async fn delete_kb(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<CurrentUser>,
    Path(kb): Path<String>,
) -> Result<StatusCode, ApiError> {
    let handle = Arc::clone(&state);
    let id = kb.clone();
    blocking(move || handle.store.delete_kb(&id)).await??;
    state.audit.record(AuditEvent {
        at_ms: now_ms(),
        action: "delete-kb".into(),
        kb: Some(kb),
        path: None,
        device: Some(format!("管理后台 · {}", user.username)),
        token: None,
        status: 204,
        detail: None,
    });
    Ok(StatusCode::NO_CONTENT)
}

async fn download_entry(
    State(state): State<Arc<AppState>>,
    Path((kb, category, id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let handle = Arc::clone(&state);
    let file_name = format!("{id}.zip");
    let (bytes, hash) = blocking(move || handle.store.read_entry(&kb, &category, &id)).await??;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/zip"),
            ),
            (header::ETAG, format_etag(&hash)),
            (header::CONTENT_DISPOSITION, attachment(&file_name)),
        ],
        bytes,
    )
        .into_response())
}

async fn delete_entry(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<CurrentUser>,
    Path((kb, category, id)): Path<(String, String, String)>,
) -> Result<StatusCode, ApiError> {
    let handle = Arc::clone(&state);
    let label = format!("{category}/{id}");
    let kb_id = kb.clone();
    blocking(move || {
        handle
            .store
            // No precondition: the operator is looking at the row they clicked,
            // which is a stronger statement of intent than a hash comparison
            // against a manifest the page fetched a minute ago.
            .delete_entry(&kb, &category, &id, crate::store::Precondition::None, None)
    })
    .await??;
    state.audit.entry(EntryLog {
        action: "delete",
        kb: &kb_id,
        path: &label,
        device: Some(&format!("管理后台 · {}", user.username)),
        token: None,
        status: 204,
        detail: None,
    });
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct DeleteEntriesBody {
    paths: Vec<String>,
}

async fn delete_entries(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<CurrentUser>,
    Path(kb): Path<String>,
    Json(body): Json<DeleteEntriesBody>,
) -> Result<Json<Value>, ApiError> {
    let device = format!("管理后台 · {}", user.username);
    let mut deleted = 0usize;
    let mut failed: Vec<Value> = Vec::new();
    for path in body.paths {
        let Some((category, id)) = path.split_once('/') else {
            failed.push(json!({ "path": path, "message": "路径里没有分类" }));
            continue;
        };
        let handle = Arc::clone(&state);
        let (category, id) = (category.to_string(), id.to_string());
        let kb_id = kb.clone();
        let result = blocking(move || {
            handle.store.delete_entry(
                &kb_id,
                &category,
                &id,
                crate::store::Precondition::None,
                None,
            )
        })
        .await?;
        match result {
            Ok(()) => {
                deleted += 1;
                state.audit.entry(EntryLog {
                    action: "delete",
                    kb: &kb,
                    path: &path,
                    device: Some(&device),
                    token: None,
                    status: 204,
                    detail: None,
                });
            }
            // One failure does not abandon the rest: a batch delete of forty
            // entries where the third is already gone should remove the other
            // thirty-nine and say so.
            Err(e) => failed.push(json!({ "path": path, "message": e.to_string() })),
        }
    }
    Ok(Json(json!({ "deleted": deleted, "failed": failed })))
}

// ─── Backups ─────────────────────────────────────────────────────────────────

fn attachment(file_name: &str) -> HeaderValue {
    // RFC 5987 for the name, because entry ids and knowledge-base names are
    // routinely Chinese and a bare filename= would arrive mangled.
    let encoded: String = file_name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    HeaderValue::from_str(&format!("attachment; filename*=UTF-8''{encoded}"))
        .unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

fn format_etag(hash: &str) -> HeaderValue {
    HeaderValue::from_str(&format!("\"{hash}\""))
        .unwrap_or_else(|_| HeaderValue::from_static("\"\""))
}

fn archive_response(stream: tokio::io::DuplexStream, file_name: &str) -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/gzip"),
            ),
            (header::CONTENT_DISPOSITION, attachment(file_name)),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(stream)),
    )
        .into_response()
}

async fn kb_backup(
    State(state): State<Arc<AppState>>,
    Path(kb): Path<String>,
) -> Result<Response, ApiError> {
    let handle = Arc::clone(&state);
    let id = kb.clone();
    blocking(move || handle.store.require_kb(&id)).await??;
    let root = state.store.kb_path(&kb);
    Ok(archive_response(
        maint::spawn_tar_gz(root, kb.clone()),
        &format!("{kb}.tar.gz"),
    ))
}

async fn full_backup(State(state): State<Arc<AppState>>) -> Response {
    let root = state.store.root().to_path_buf();
    archive_response(
        maint::spawn_tar_gz(root, "data".into()),
        "aiw-kb-data.tar.gz",
    )
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

fn token_json(token: &TokenEntry, last_used: Option<&AuditEvent>) -> Value {
    json!({
        "id": token.id,
        "name": token.name,
        "prefix": token.prefix(),
        "createdAtMs": token.created_at_ms,
        "fromEnv": token.from_env,
        "lastUsedAtMs": last_used.map(|e| e.at_ms),
        "lastUsedDevice": last_used.and_then(|e| e.device.clone()),
    })
}

async fn list_tokens(State(state): State<Arc<AppState>>) -> Json<Value> {
    let events = state.audit.snapshot();
    let config = state.config();
    let rows: Vec<Value> = config
        .tokens
        .iter()
        .map(|token| {
            let prefix = token.prefix();
            let last = events
                .iter()
                .rev()
                .find(|e| e.token.as_deref() == Some(prefix.as_str()));
            token_json(token, last)
        })
        .collect();
    Json(json!({
        "tokens": rows,
        // The page needs this to explain why the list is read-only, and it is
        // not derivable from the rows: an env-configured list has no file to
        // write back to at all.
        "fromEnv": config.source_of("tokens") == Source::Env,
        "configPath": config.file_path.display().to_string(),
    }))
}

#[derive(Deserialize)]
struct CreateTokenBody {
    name: String,
}

async fn create_token(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateTokenBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (path, from_env) = {
        let config = state.config();
        (
            config.file_path.clone(),
            config.source_of("tokens") == Source::Env,
        )
    };
    if from_env {
        return Err(env_locked("tokens"));
    }
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("给它起个名字，好认出是哪台机器"));
    }
    let value = config::generate_token();
    confedit::add_token(&path, name, &value, now_ms()).map_err(ApiError::bad_request)?;
    state.reload_config().map_err(|e| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "reload_failed",
            format!("token 写进去了，但重新加载配置失败：{e}"),
        )
    })?;
    Ok((
        StatusCode::CREATED,
        // The only response that carries the whole value. The list never does —
        // not because the server cannot (it is clear text in the file), but
        // because a page that prints every credential in full is a page nobody
        // can safely screenshot.
        Json(json!({ "name": name, "value": value })),
    ))
}

async fn reveal_token(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let config = state.config();
    let token = config
        .tokens
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| ApiError::not_found("没有这个 token"))?;
    Ok(Json(json!({ "value": token.value })))
}

async fn revoke_token(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let (path, from_env) = {
        let config = state.config();
        (
            config.file_path.clone(),
            config.source_of("tokens") == Source::Env,
        )
    };
    if from_env {
        return Err(env_locked("tokens"));
    }
    let removed = confedit::remove_token(&path, &id).map_err(ApiError::bad_request)?;
    if !removed {
        return Err(ApiError::not_found("没有这个 token"));
    }
    state.reload_config().map_err(|e| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "reload_failed",
            format!("token 删掉了，但重新加载配置失败：{e}"),
        )
    })?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RenameTokenBody {
    name: String,
}

async fn rename_token(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<RenameTokenBody>,
) -> Result<StatusCode, ApiError> {
    let (path, from_env) = {
        let config = state.config();
        (
            config.file_path.clone(),
            config.source_of("tokens") == Source::Env,
        )
    };
    if from_env {
        return Err(env_locked("tokens"));
    }
    if !confedit::rename_token(&path, &id, body.name.trim()).map_err(ApiError::bad_request)? {
        return Err(ApiError::not_found("没有这个 token"));
    }
    let _ = state.reload_config();
    Ok(StatusCode::NO_CONTENT)
}

fn env_locked(what: &str) -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "env_override",
        format!(
            "{what} 当前由环境变量提供，配置文件里的值没有生效——在这里改了也不会有用。\
             去掉那个环境变量并重启，才能在后台管理它。"
        ),
    )
}

// ─── Activity ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ActivityQuery {
    kb: Option<String>,
    device: Option<String>,
    action: Option<String>,
    hours: Option<u64>,
    failures: Option<bool>,
    limit: Option<usize>,
}

async fn activity(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ActivityQuery>,
) -> Json<Value> {
    let hours = query.hours.unwrap_or(24).clamp(1, 24 * 90);
    let since = now_ms().saturating_sub(hours * 3_600_000);
    let filter = AuditFilter {
        kb: query.kb.filter(|v| !v.is_empty()),
        device: query.device.filter(|v| !v.is_empty()),
        action: query.action.filter(|v| !v.is_empty()),
        since_ms: since,
        only_failures: query.failures.unwrap_or(false),
        limit: query.limit.unwrap_or(200).clamp(1, 1000),
    };
    let events = state.audit.query(&filter);

    // 24 buckets over the window, whatever the window is: the chart is "when did
    // things happen", and it reads the same whether the span is a day or a month.
    let buckets = 24usize;
    let bucket_ms = (hours * 3_600_000) / buckets as u64;
    Json(json!({
        "events": events,
        "devices": state.audit.devices(),
        "histogram": state.audit.histogram(since, bucket_ms.max(1), buckets),
        "sinceMs": since,
        "bucketMs": bucket_ms,
    }))
}

// ─── Maintenance ─────────────────────────────────────────────────────────────

async fn maintenance(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let handle = Arc::clone(&state);
    let (summaries, strays, duplicates) = blocking(move || {
        (
            handle.store.list_kbs().unwrap_or_default(),
            handle.store.stray_staging(),
            handle.store.duplicate_payloads(),
        )
    })
    .await?;

    let handle = Arc::clone(&state);
    let ids: Vec<(String, String)> = summaries
        .iter()
        .map(|s| (s.meta.id.clone(), s.meta.name.clone()))
        .collect();
    let by_kb = blocking(move || {
        ids.into_iter()
            .map(|(id, name)| {
                let bytes = handle.store.kb_bytes(&id);
                maint::KbUsage { id, name, bytes }
            })
            .collect::<Vec<_>>()
    })
    .await?;

    let data_dir = state.config().server.data_dir.clone();
    let mut usage = blocking(move || maint::disk_usage(&data_dir, by_kb)).await?;
    usage.by_kb.sort_by_key(|kb| std::cmp::Reverse(kb.bytes));

    Ok(Json(json!({
        "disk": usage,
        "strays": strays,
        "duplicates": duplicates,
    })))
}

async fn clear_tmp(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let handle = Arc::clone(&state);
    let (files, bytes) = blocking(move || handle.store.clear_staging()).await?;
    Ok(Json(json!({ "files": files, "bytes": bytes })))
}

async fn dedupe(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let handle = Arc::clone(&state);
    let (files, bytes) = blocking(move || handle.store.remove_duplicate_payloads()).await?;
    Ok(Json(json!({ "files": files, "bytes": bytes })))
}

async fn checks(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Json<Value> {
    let bind = state.config().server.bind;
    let probe = maint::probe_unauthenticated(bind).await;
    let config = state.config();
    Json(json!({
        "checks": maint::run_checks(&config, forwarded_proto(&headers).as_deref(), probe),
    }))
}

// ─── Configuration ───────────────────────────────────────────────────────────

/// One row of the config page.
///
/// A struct rather than nine positional arguments: `key`, `label`, `kind`,
/// `env_var` and `help` are all strings, and a call site that lists them in the
/// wrong order compiles and produces a page that labels every setting wrongly.
struct Row {
    key: &'static str,
    label: &'static str,
    /// `text` · `number` · `bool` · `password` — how the page draws it.
    kind: &'static str,
    value: Value,
    default: Value,
    /// The environment variable that overrides it, if any.
    env_var: &'static str,
    needs_restart: bool,
    help: &'static str,
}

impl Row {
    fn to_json(&self, config: &crate::config::Config) -> Value {
        json!({
            "key": self.key,
            "label": self.label,
            "kind": self.kind,
            "value": self.value,
            "default": self.default,
            // Read from the live config rather than passed in, so a row can
            // never claim a provenance that disagrees with what is running.
            "source": config.source_of(self.key).as_str(),
            "envVar": self.env_var,
            "needsRestart": self.needs_restart,
            "help": self.help,
        })
    }
}

async fn read_config(State(state): State<Arc<AppState>>) -> Json<Value> {
    let config = state.config();
    let file_text = std::fs::read_to_string(&config.file_path).unwrap_or_default();
    let admin = config.admin.as_ref();

    let rows = [
        Row {
            key: "server.bind",
            label: "监听地址",
            kind: "text",
            value: json!(config.server.bind.to_string()),
            default: json!(config::DEFAULT_BIND),
            env_var: "AIW_KB_BIND",
            needs_restart: true,
            help: "默认只听回环。要让局域网里的其他机器连上，改成 0.0.0.0:8787——并且在前面套一层 TLS。",
        },
        Row {
            key: "server.data_dir",
            label: "数据目录",
            kind: "text",
            value: json!(config.server.data_dir.display().to_string()),
            default: json!(config::DEFAULT_DATA_DIR),
            env_var: "AIW_KB_DATA_DIR",
            needs_restart: true,
            help: "所有知识库落盘的根目录。整个目录打包就是一次完整备份。",
        },
        Row {
            key: "server.max_entry_mb",
            label: "单条目上限（MB）",
            kind: "number",
            value: json!(config.server.max_entry_mb),
            default: json!(config::DEFAULT_MAX_ENTRY_MB),
            env_var: "AIW_KB_MAX_ENTRY_MB",
            needs_restart: false,
            help: "一个条目（含配图）的上传上限，超出返回 413。调大它时记得同步调大反向代理的 body 上限。",
        },
        Row {
            key: "server.allow_anonymous",
            label: "关闭同步 API 鉴权",
            kind: "bool",
            value: json!(config.server.allow_anonymous),
            default: json!(false),
            env_var: "AIW_KB_ALLOW_ANONYMOUS",
            needs_restart: false,
            help: "打开后任何能访问到这台机器的人都能读写全部知识库，管理后台也不再需要登录。仅用于本机试跑。",
        },
        Row {
            key: "server.log",
            label: "日志级别",
            kind: "text",
            value: json!(config.server.log),
            default: json!(config::DEFAULT_LOG),
            env_var: "RUST_LOG",
            needs_restart: true,
            help: "想看每个请求：aiw_kb_server=debug,tower_http=debug",
        },
        Row {
            key: "admin.username",
            label: "后台用户名",
            kind: "text",
            value: json!(admin.map(|a| a.username.clone()).unwrap_or_default()),
            default: json!("admin"),
            env_var: "AIW_KB_ADMIN_USER",
            needs_restart: false,
            help: "管理后台的登录账号。与 app 里填的同步 token 不是一回事。",
        },
        Row {
            key: "admin.password",
            label: "后台密码",
            kind: "password",
            value: json!(admin.map(|a| a.password.clone()).unwrap_or_default()),
            default: json!(""),
            env_var: "AIW_KB_ADMIN_PASSWORD",
            needs_restart: false,
            help: "明文存在配置文件里，保护它的是文件权限。改掉它会把其他浏览器上的登录状态全部踢掉。",
        },
        Row {
            key: "admin.session_hours",
            label: "会话有效期（小时）",
            kind: "number",
            value: json!(admin.map(|a| a.session_hours).unwrap_or(config::DEFAULT_SESSION_HOURS)),
            default: json!(config::DEFAULT_SESSION_HOURS),
            env_var: "",
            needs_restart: false,
            help: "登录后多久需要重新登录。",
        },
    ];

    Json(json!({
        "file": {
            "path": config.file_path.display().to_string(),
            "origin": config.file_origin.as_str(),
            "exists": config.file_exists,
            "writable": config_writable(&config.file_path),
            "error": config.file_error,
            "text": file_text,
        },
        "rows": rows.iter().map(|row| row.to_json(&config)).collect::<Vec<_>>(),
        "restartHint": "改完需要重启的项，保存后点「重启服务」——只有在 systemd / Docker 等会自动拉起进程的方式下才有用。",
    }))
}

#[derive(Deserialize)]
struct WriteConfigBody {
    /// Dotted key → new value. Only keys the page offered are accepted.
    updates: serde_json::Map<String, Value>,
}

async fn write_config(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<WriteConfigBody>,
) -> Result<Json<Value>, ApiError> {
    let (path, sources) = {
        let config = state.config();
        (config.file_path.clone(), config.sources.clone())
    };

    let mut settings: Vec<Setting> = Vec::new();
    let mut password_changed = false;
    let mut needs_restart: Vec<&'static str> = Vec::new();

    for (key, value) in body.updates.iter() {
        // Refusing an environment-overridden key rather than writing it: the
        // write would succeed, the file would show the new value, and the server
        // would keep running on the old one. Silently doing nothing is the one
        // outcome a config page must never produce.
        if sources.get(key.as_str()) == Some(&Source::Env) {
            return Err(env_locked(key));
        }
        match key.as_str() {
            "server.bind" => {
                let raw = as_str(value)?;
                raw.parse::<std::net::SocketAddr>().map_err(|e| {
                    ApiError::bad_request(format!(
                        "{raw:?} 不是合法的监听地址（要写成 127.0.0.1:8787 这样）：{e}"
                    ))
                })?;
                needs_restart.push("监听地址");
                settings.push(Setting::Str("server.bind", raw));
            }
            "server.data_dir" => {
                let raw = as_str(value)?;
                if raw.trim().is_empty() {
                    return Err(ApiError::bad_request("数据目录不能是空的"));
                }
                needs_restart.push("数据目录");
                settings.push(Setting::Str("server.data_dir", raw));
            }
            "server.max_entry_mb" => {
                let n = as_int(value)?;
                if !(1..=1024).contains(&n) {
                    return Err(ApiError::bad_request("单条目上限要在 1 到 1024 之间"));
                }
                settings.push(Setting::Int("server.max_entry_mb", n));
            }
            "server.allow_anonymous" => {
                settings.push(Setting::Bool("server.allow_anonymous", as_bool(value)?));
            }
            "server.log" => {
                needs_restart.push("日志级别");
                settings.push(Setting::Str("server.log", as_str(value)?));
            }
            "admin.username" => {
                let raw = as_str(value)?;
                if raw.trim().is_empty() {
                    return Err(ApiError::bad_request("用户名不能是空的"));
                }
                password_changed = true;
                settings.push(Setting::Str("admin.username", raw));
            }
            "admin.password" => {
                let raw = as_str(value)?;
                if raw.len() < 6 {
                    return Err(ApiError::bad_request("密码至少 6 个字符"));
                }
                password_changed = true;
                settings.push(Setting::Str("admin.password", raw));
            }
            "admin.session_hours" => {
                let n = as_int(value)?;
                if !(1..=8760).contains(&n) {
                    return Err(ApiError::bad_request("会话有效期要在 1 到 8760 小时之间"));
                }
                settings.push(Setting::Int("admin.session_hours", n));
            }
            other => return Err(ApiError::bad_request(format!("不认识的配置项 {other:?}"))),
        }
    }

    if settings.is_empty() {
        return Ok(Json(json!({ "changed": 0, "needsRestart": [] })));
    }
    let changed = settings.len();
    confedit::apply(&path, &settings).map_err(ApiError::bad_request)?;

    let reload = state.reload_config();
    if password_changed {
        // Everyone else is logged out — including whoever might have been using
        // the credential that was just changed, which is the point of changing it.
        state.sessions.revoke_others(&user.session_id);
    }
    state.audit.record(AuditEvent {
        at_ms: now_ms(),
        action: "config".into(),
        kb: None,
        path: None,
        device: Some(format!("管理后台 · {}", user.username)),
        token: None,
        status: 200,
        detail: Some(format!("改了 {changed} 项")),
    });

    Ok(Json(json!({
        "changed": changed,
        "needsRestart": needs_restart,
        "reloadError": reload.err(),
    })))
}

fn as_str(value: &Value) -> Result<String, ApiError> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| ApiError::bad_request("这一项要填文字"))
}

fn as_int(value: &Value) -> Result<i64, ApiError> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
        .ok_or_else(|| ApiError::bad_request("这一项要填数字"))
}

fn as_bool(value: &Value) -> Result<bool, ApiError> {
    value
        .as_bool()
        .ok_or_else(|| ApiError::bad_request("这一项只能是开或关"))
}

/// Exit, and let whatever started this process start it again.
///
/// The process does **not** re-exec itself: under systemd that would leave a
/// child outside the unit's cgroup, and under Docker it would keep a container
/// alive whose PID 1 is not the server. Exiting cleanly is the only restart that
/// behaves the same everywhere — which is also why the console says out loud
/// that this needs a supervisor.
async fn restart(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<CurrentUser>,
) -> Json<Value> {
    tracing::warn!(
        "restart requested from the admin console by {}",
        user.username
    );
    state.audit.record(AuditEvent {
        at_ms: now_ms(),
        action: "restart".into(),
        kb: None,
        path: None,
        device: Some(format!("管理后台 · {}", user.username)),
        token: None,
        status: 200,
        detail: None,
    });
    tokio::spawn(async {
        // Long enough for this response to reach the browser, short enough that
        // the page's reconnect poll is still waiting when the socket drops.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        std::process::exit(0);
    });
    Json(json!({ "ok": true }))
}

// ─── Plumbing ────────────────────────────────────────────────────────────────

async fn blocking<T, F>(f: F) -> Result<T, ApiError>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f).await.map_err(|e| {
        tracing::error!("admin worker task failed: {e}");
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "the server could not complete that operation",
        )
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn human_duration(ms: u64) -> String {
    let seconds = ms / 1000;
    if seconds < 60 {
        format!("{seconds} 秒")
    } else {
        format!("{} 分 {} 秒", seconds / 60, seconds % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookies_are_parsed_out_of_a_crowded_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("theme=dark; aiw_kb_admin=abc123; other=1"),
        );
        assert_eq!(
            cookie_value(&headers, COOKIE_NAME),
            Some("abc123".to_string())
        );
        assert_eq!(cookie_value(&headers, "nope"), None);
    }

    #[test]
    fn a_chinese_filename_survives_the_content_disposition() {
        let value = attachment("爱丽丝.zip");
        let text = value.to_str().unwrap();
        assert!(text.starts_with("attachment; filename*=UTF-8''"));
        assert!(text.contains("%E7%88%B1"), "{text}");
        assert!(text.ends_with(".zip"));
    }

    #[test]
    fn forwarded_proto_takes_the_first_hop() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https, http"));
        assert_eq!(forwarded_proto(&headers).as_deref(), Some("https"));
    }

    #[test]
    fn byte_sizes_read_like_a_file_manager() {
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(15_234), "14.9 KB");
        assert_eq!(human_bytes(64_200_000_000), "59.8 GB");
    }
}
