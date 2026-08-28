//! HTTP surface.
//!
//! ```text
//! GET    /health                                     no auth — liveness only
//! GET    /v1/kbs                                     list knowledge bases
//! POST   /v1/kbs                                     create one
//! GET    /v1/kbs/{kb}/manifest                       every entry's hash — the sync plan's input
//! GET    /v1/kbs/{kb}/syncs                          recent sync runs, newest first
//! POST   /v1/kbs/{kb}/syncs                          a client reports one completed sync
//! GET    /v1/kbs/{kb}/entries/{category}/{id}        download one entry (zip)
//! PUT    /v1/kbs/{kb}/entries/{category}/{id}        upload one entry (zip)
//! DELETE /v1/kbs/{kb}/entries/{category}/{id}        remove one entry (mirror semantics)
//!
//! GET    /v1/configs                                 list application-config backup slots
//! POST   /v1/configs                                 create one
//! GET    /v1/configs/{slot}                          download the newest version
//! PUT    /v1/configs/{slot}                          upload a new version
//! DELETE /v1/configs/{slot}                          remove a slot and its history
//! GET    /v1/configs/{slot}/versions                 list the retained versions
//! GET    /v1/configs/{slot}/versions/{at}            download one of them
//! ```
//!
//! Two things about this API are deliberate and easy to undo by accident:
//!
//! **The server never diffs.** It hands out a manifest and applies whatever
//! individual writes the client decides on. The whole comparison — local vs
//! remote vs the client's snapshot of the last sync — happens in the app,
//! because only the app knows what the author last agreed to (docs §14.2).
//!
//! **Every mutation carries a precondition.** `If-Match: "<hash>"` for a
//! replace or a delete, `If-None-Match: *` for a create. The manifest a client
//! planned against can be minutes old by the time it writes, and without these
//! a sync would silently overwrite work another machine pushed in between —
//! exactly the failure the client-side rail exists to prevent, reintroduced one
//! layer down. A request with neither header is accepted (some flows genuinely
//! mean "force"), so the guarantee is the client's to keep.
//!
//! **The config endpoints store an opaque envelope.** What the app uploads there
//! is encrypted on the author's machine whenever it carries API keys, and this
//! server has no way to decrypt it and no code that tries. The `X-Config-Meta`
//! header is the client's own display header, stored verbatim and handed back —
//! never parsed here, so the envelope format can keep moving without this binary
//! following it (`docs/feature/knowledge-base/config-backup-plan.md` §2 ①).

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Extension, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::{Arc, RwLock};

use crate::audit::AuditLog;
use crate::config::Config;
use crate::error::ApiError;
use crate::session::SessionStore;
use crate::store::{
    ConfigWrite, EntryWrite, KbSummary, Manifest, Precondition, PutOutcome, SlotSummary,
    SlotVersion, Store, SyncRecord,
};

pub struct AppState {
    pub store: Store,
    /// The live configuration. Behind a lock because the admin console can
    /// rewrite the file and reload it without a restart — a token added there
    /// has to be accepted by the very next request, which is only true if the
    /// token check reads this rather than a copy taken at startup.
    pub config: RwLock<Config>,
    /// The process arguments, kept so a reload can resolve `--config` the same
    /// way the original load did.
    pub argv: Vec<String>,
    pub sessions: SessionStore,
    pub audit: AuditLog,
    pub started_at_ms: u64,
}

impl AppState {
    pub fn config(&self) -> std::sync::RwLockReadGuard<'_, Config> {
        self.config.read().expect("config lock poisoned")
    }

    /// Re-read the config file after the console wrote it.
    ///
    /// A failed reload leaves the running configuration in place and reports
    /// why: the file has already been written by then, and swapping in a broken
    /// configuration would take away the console that is the way to fix it.
    pub fn reload_config(&self) -> Result<(), String> {
        let fresh = Config::load(&self.argv)?;
        *self.config.write().expect("config lock poisoned") = fresh;
        Ok(())
    }
}

/// The first characters of the token a request presented, for the activity log.
///
/// Inserted by the auth middleware so handlers do not each re-parse the header —
/// and so the value they log is by construction the one that was checked.
#[derive(Clone)]
pub struct TokenPrefix(pub Option<String>);

pub fn router(state: Arc<AppState>, max_entry_bytes: usize, max_config_bytes: usize) -> Router {
    let kb_api = Router::new()
        .route("/v1/kbs", get(list_kbs).post(create_kb))
        .route("/v1/kbs/{kb}/manifest", get(manifest))
        .route("/v1/kbs/{kb}/syncs", get(list_sync_log).post(report_sync))
        .route(
            "/v1/kbs/{kb}/entries/{category}/{id}",
            get(get_entry).put(put_entry).delete(delete_entry),
        )
        // Its own body limit, and the config router below has its own too: a
        // knowledge-base entry is a gallery of images and a config envelope is a
        // few tens of kilobytes of JSON. One shared cap would let the generous
        // limit the first one needs decide what the second one accepts.
        .layer(DefaultBodyLimit::max(max_entry_bytes));

    let config_api = Router::new()
        .route("/v1/configs", get(list_slots).post(create_slot))
        .route(
            "/v1/configs/{slot}",
            get(get_config).put(put_config).delete(delete_slot),
        )
        .route("/v1/configs/{slot}/versions", get(list_versions))
        .route("/v1/configs/{slot}/versions/{at}", get(get_config_version))
        .layer(DefaultBodyLimit::max(max_config_bytes));

    let api = kb_api
        .merge(config_api)
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            require_token,
        ));

    Router::new()
        // Outside the auth layer: a reverse proxy or a container runtime has to
        // be able to probe liveness without holding a token, and this answers
        // nothing about the stored data.
        .route("/health", get(health))
        .with_state(Arc::clone(&state))
        .merge(crate::admin::router(Arc::clone(&state)))
        .merge(api.with_state(state))
}

/// Liveness, plus the two facts the admin console's login screen shows before
/// anyone has logged in: that this is the right kind of server, and whether it
/// is running without authentication.
async fn health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let config = state.config();
    Json(serde_json::json!({
        "status": "ok",
        "service": "aiw-kb-server",
        "version": env!("CARGO_PKG_VERSION"),
        "anonymous": config.server.allow_anonymous,
        "adminConfigured": config.admin.is_some(),
    }))
}

// ─── Auth ────────────────────────────────────────────────────────────────────

/// Compare in constant time.
///
/// A token check that returns on the first differing byte leaks the token one
/// byte at a time to anyone who can measure the response — slow over the
/// internet, trivial on a LAN, and this server is most often on a LAN.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn require_token(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("")
        .to_string();

    let (allow_anonymous, ok) = {
        let config = state.config();
        // Every configured token is compared even after a match, so the time
        // taken does not reveal which one (or how many there are).
        let mut ok = false;
        for token in &config.tokens {
            ok |= constant_time_eq(token.value.as_bytes(), presented.as_bytes());
        }
        (config.server.allow_anonymous, ok)
    };

    let prefix = if ok {
        Some(presented.chars().take(6).collect::<String>())
    } else {
        None
    };
    request.extensions_mut().insert(TokenPrefix(prefix));

    if !(ok || allow_anonymous) {
        // Logged rather than only counted: "someone has been hitting this with
        // a token that no longer works" is the question the activity page
        // exists to answer, and a 401 never reaches a handler that could log it.
        state.audit.record(crate::audit::AuditEvent {
            at_ms: now_ms(),
            action: "unauthorized".into(),
            kb: None,
            path: Some(request.uri().path().to_string()),
            device: device_from(request.headers()),
            token: None,
            status: 401,
            detail: if presented.is_empty() {
                Some("请求没有带 Authorization 头".into())
            } else {
                Some("token 不在当前配置里".into())
            },
        });
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "a valid `Authorization: Bearer <token>` header is required",
        ));
    }
    Ok(next.run(request).await)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ─── Knowledge bases ─────────────────────────────────────────────────────────

async fn list_kbs(State(state): State<Arc<AppState>>) -> Result<Json<Vec<KbSummary>>, ApiError> {
    let store = Arc::clone(&state);
    let kbs = blocking(move || store.store.list_kbs()).await??;
    Ok(Json(kbs))
}

#[derive(Deserialize)]
struct CreateKb {
    name: String,
    /// Optional explicit id. Omitted, the server slugifies `name` — which is the
    /// normal path, because a display name may be entirely non-ASCII.
    id: Option<String>,
}

async fn create_kb(
    State(state): State<Arc<AppState>>,
    Extension(TokenPrefix(token)): Extension<TokenPrefix>,
    headers: HeaderMap,
    Json(body): Json<CreateKb>,
) -> Result<(StatusCode, Json<KbSummary>), ApiError> {
    let device = device_from(&headers);
    let store = Arc::clone(&state);
    let meta = blocking(move || store.store.create_kb(&body.name, body.id.as_deref())).await??;
    state.audit.record(crate::audit::AuditEvent {
        at_ms: now_ms(),
        action: "create-kb".into(),
        kb: Some(meta.meta.id.clone()),
        path: None,
        device,
        token,
        status: 201,
        detail: None,
    });
    Ok((StatusCode::CREATED, Json(meta)))
}

async fn manifest(
    State(state): State<Arc<AppState>>,
    Path(kb): Path<String>,
) -> Result<Json<Manifest>, ApiError> {
    let store = Arc::clone(&state);
    let manifest = blocking(move || store.store.manifest(&kb)).await??;
    Ok(Json(manifest))
}

// ─── Sync log ────────────────────────────────────────────────────────────────

async fn list_sync_log(
    State(state): State<Arc<AppState>>,
    Path(kb): Path<String>,
) -> Result<Json<Vec<SyncRecord>>, ApiError> {
    let store = Arc::clone(&state);
    let log = blocking(move || store.store.list_syncs(&kb)).await??;
    Ok(Json(log))
}

#[derive(Deserialize)]
struct ReportSync {
    direction: String,
    #[serde(default)]
    created: u32,
    #[serde(default)]
    replaced: u32,
    #[serde(default)]
    deleted: u32,
}

/// A client says "I just finished a sync run against this base".
///
/// Direction and counts come from the body; the machine name rides the same
/// `X-Source-Device` header every write already carries, and the timestamp is
/// stamped by the store, not taken from the client.
async fn report_sync(
    State(state): State<Arc<AppState>>,
    Extension(TokenPrefix(token)): Extension<TokenPrefix>,
    Path(kb): Path<String>,
    headers: HeaderMap,
    Json(body): Json<ReportSync>,
) -> Result<(StatusCode, Json<SyncRecord>), ApiError> {
    let device = device_from(&headers);
    let kb_id = kb.clone();
    let logged_device = device.clone();
    let store = Arc::clone(&state);
    let record = blocking(move || {
        store.store.record_sync(
            &kb,
            &body.direction,
            device.as_deref(),
            body.created,
            body.replaced,
            body.deleted,
        )
    })
    .await??;
    state.audit.record(crate::audit::AuditEvent {
        at_ms: now_ms(),
        action: "sync".into(),
        kb: Some(kb_id),
        path: None,
        device: logged_device,
        token,
        status: 201,
        detail: Some(format!(
            "{} · +{} ~{} -{}",
            record.direction, record.created, record.replaced, record.deleted
        )),
    });
    Ok((StatusCode::CREATED, Json(record)))
}

// ─── Entries ─────────────────────────────────────────────────────────────────

async fn get_entry(
    State(state): State<Arc<AppState>>,
    Extension(TokenPrefix(token)): Extension<TokenPrefix>,
    headers: HeaderMap,
    Path((kb, category, id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let device = device_from(&headers);
    let label = format!("{category}/{id}");
    let kb_id = kb.clone();
    let store = Arc::clone(&state);
    let (bytes, hash) = blocking(move || store.store.read_entry(&kb, &category, &id)).await??;
    state.audit.entry(crate::audit::EntryLog {
        action: "download",
        kb: &kb_id,
        path: &label,
        device: device.as_deref(),
        token: token.as_deref(),
        status: 200,
        detail: None,
    });

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    // Both the app-level header and the standard ETag carry the hash: the
    // former is what the client reads, the latter is what an HTTP cache or a
    // proxy understands. They are always the same value.
    if let Ok(v) = HeaderValue::from_str(&hash) {
        headers.insert("x-entry-hash", v);
    }
    if let Ok(v) = HeaderValue::from_str(&format!("\"{hash}\"")) {
        headers.insert(header::ETAG, v);
    }
    Ok((headers, bytes).into_response())
}

async fn put_entry(
    State(state): State<Arc<AppState>>,
    Extension(TokenPrefix(token)): Extension<TokenPrefix>,
    Path((kb, category, id)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let hash = headers
        .get("x-entry-hash")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .ok_or_else(|| {
            ApiError::bad_request(
                "an `X-Entry-Hash` header is required — the client's hash of the entry \
                 directory's contents, which the server stores but never recomputes",
            )
        })?
        .to_string();
    if body.is_empty() {
        return Err(ApiError::bad_request("the request body is empty"));
    }
    let precondition = precondition_from(&headers)?;
    let device = device_from(&headers);

    let label = format!("{category}/{id}");
    let kb_id = kb.clone();
    let logged_device = device.clone();
    let store = Arc::clone(&state);
    let outcome = blocking(move || {
        store.store.put_entry(
            &kb,
            &category,
            &id,
            EntryWrite {
                hash: &hash,
                bytes: &body,
                precondition,
                device: device.as_deref(),
            },
        )
    })
    .await?;

    // A rejected write is logged too, and it is the interesting one: a 412 is
    // this server telling one machine that another got there first, and reading
    // that sentence in the activity page is the whole reason the page exists.
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(e) => {
            let error = ApiError::from(e);
            state.audit.entry(crate::audit::EntryLog {
                action: "replace",
                kb: &kb_id,
                path: &label,
                device: logged_device.as_deref(),
                token: token.as_deref(),
                status: error.status.as_u16(),
                detail: Some(error.message.clone()),
            });
            return Err(error);
        }
    };

    let (action, status) = match outcome {
        PutOutcome::Created => ("create", StatusCode::CREATED),
        PutOutcome::Replaced => ("replace", StatusCode::NO_CONTENT),
    };
    state.audit.entry(crate::audit::EntryLog {
        action,
        kb: &kb_id,
        path: &label,
        device: logged_device.as_deref(),
        token: token.as_deref(),
        status: status.as_u16(),
        detail: None,
    });
    Ok(status)
}

async fn delete_entry(
    State(state): State<Arc<AppState>>,
    Extension(TokenPrefix(token)): Extension<TokenPrefix>,
    Path((kb, category, id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let precondition = precondition_from(&headers)?;
    let device = device_from(&headers);
    let label = format!("{category}/{id}");
    let kb_id = kb.clone();
    let logged_device = device.clone();
    let store = Arc::clone(&state);
    let result = blocking(move || {
        store
            .store
            .delete_entry(&kb, &category, &id, precondition, device.as_deref())
    })
    .await?;
    if let Err(e) = result {
        let error = ApiError::from(e);
        state.audit.entry(crate::audit::EntryLog {
            action: "delete",
            kb: &kb_id,
            path: &label,
            device: logged_device.as_deref(),
            token: token.as_deref(),
            status: error.status.as_u16(),
            detail: Some(error.message.clone()),
        });
        return Err(error);
    }
    state.audit.entry(crate::audit::EntryLog {
        action: "delete",
        kb: &kb_id,
        path: &label,
        device: logged_device.as_deref(),
        token: token.as_deref(),
        status: 204,
        detail: None,
    });
    Ok(StatusCode::NO_CONTENT)
}

// ─── Application-config backups ──────────────────────────────────────────────

async fn list_slots(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<SlotSummary>>, ApiError> {
    let handle = Arc::clone(&state);
    let slots = blocking(move || handle.store.list_slots()).await??;
    Ok(Json(slots))
}

#[derive(Deserialize)]
struct CreateSlot {
    name: String,
    id: Option<String>,
}

async fn create_slot(
    State(state): State<Arc<AppState>>,
    Extension(TokenPrefix(token)): Extension<TokenPrefix>,
    headers: HeaderMap,
    Json(body): Json<CreateSlot>,
) -> Result<(StatusCode, Json<SlotSummary>), ApiError> {
    let device = device_from(&headers);
    let handle = Arc::clone(&state);
    let slot = blocking(move || handle.store.create_slot(&body.name, body.id.as_deref())).await??;
    state.audit.entry(crate::audit::EntryLog {
        action: "config-create",
        kb: "",
        path: &format!("configs/{}", slot.meta.id),
        device: device.as_deref(),
        token: token.as_deref(),
        status: 201,
        detail: None,
    });
    Ok((StatusCode::CREATED, Json(slot)))
}

async fn list_versions(
    State(state): State<Arc<AppState>>,
    Path(slot): Path<String>,
) -> Result<Json<Vec<SlotVersion>>, ApiError> {
    let handle = Arc::clone(&state);
    let versions = blocking(move || handle.store.list_config_versions(&slot)).await??;
    Ok(Json(versions))
}

async fn get_config(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<TokenPrefix>,
    headers: HeaderMap,
    Path(slot): Path<String>,
) -> Result<Response, ApiError> {
    read_config_version(state, token, &headers, slot, None).await
}

async fn get_config_version(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<TokenPrefix>,
    headers: HeaderMap,
    Path((slot, at)): Path<(String, u64)>,
) -> Result<Response, ApiError> {
    read_config_version(state, token, &headers, slot, Some(at)).await
}

async fn read_config_version(
    state: Arc<AppState>,
    TokenPrefix(token): TokenPrefix,
    headers: &HeaderMap,
    slot: String,
    at_ms: Option<u64>,
) -> Result<Response, ApiError> {
    let device = device_from(headers);
    let label = format!("configs/{slot}");
    let handle = Arc::clone(&state);
    let (bytes, version) = blocking(move || handle.store.read_config(&slot, at_ms)).await??;
    state.audit.entry(crate::audit::EntryLog {
        action: "config-download",
        kb: "",
        path: &label,
        device: device.as_deref(),
        token: token.as_deref(),
        status: 200,
        detail: None,
    });

    let mut out = HeaderMap::new();
    // Not `application/json` even though the envelope is JSON: an encrypted one
    // is JSON wrapping base64 ciphertext, and labelling it as JSON invites a
    // proxy or a browser to treat it as something a human might want rendered.
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    if let Ok(v) = HeaderValue::from_str(&version.hash) {
        out.insert("x-config-hash", v);
    }
    if let Ok(v) = HeaderValue::from_str(&format!("\"{}\"", version.hash)) {
        out.insert(header::ETAG, v);
    }
    if let Ok(v) = HeaderValue::from_str(&version.at_ms.to_string()) {
        out.insert("x-config-at", v);
    }
    // Validated on the way in and re-validated on the way out: this string is
    // going into a response header, and a stored file is not a trusted source
    // just because this process wrote it.
    if let Some(meta) = version.meta.as_deref() {
        if let Ok(v) = HeaderValue::from_str(meta) {
            out.insert("x-config-meta", v);
        }
    }
    Ok((out, bytes).into_response())
}

async fn put_config(
    State(state): State<Arc<AppState>>,
    Extension(TokenPrefix(token)): Extension<TokenPrefix>,
    Path(slot): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    if body.is_empty() {
        return Err(ApiError::bad_request("the request body is empty"));
    }
    let precondition = precondition_from(&headers)?;
    let device = device_from(&headers);
    let meta = headers
        .get("x-config-meta")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string);
    if let Some(meta) = meta.as_deref() {
        crate::ids::validate_slot_meta(meta).map_err(|e| ApiError::bad_request(e.to_string()))?;
    }
    let keep = state.config().server.config_versions;

    let label = format!("configs/{slot}");
    let logged_device = device.clone();
    let handle = Arc::clone(&state);
    let written = blocking(move || {
        handle.store.put_config(
            &slot,
            ConfigWrite {
                bytes: &body,
                meta: meta.as_deref(),
                precondition,
                keep,
            },
        )
    })
    .await?;

    // A 412 here is this server telling one machine that another pushed its
    // configuration first — the same sentence the entry endpoints exist to say,
    // and the same reason it is logged rather than only returned.
    let (outcome, hash) = match written {
        Ok(v) => v,
        Err(e) => {
            let error = ApiError::from(e);
            state.audit.entry(crate::audit::EntryLog {
                action: "config-upload",
                kb: "",
                path: &label,
                device: logged_device.as_deref(),
                token: token.as_deref(),
                status: error.status.as_u16(),
                detail: Some(error.message.clone()),
            });
            return Err(error);
        }
    };

    let status = match outcome {
        PutOutcome::Created => StatusCode::CREATED,
        PutOutcome::Replaced => StatusCode::NO_CONTENT,
    };
    state.audit.entry(crate::audit::EntryLog {
        action: "config-upload",
        kb: "",
        path: &label,
        device: logged_device.as_deref(),
        token: token.as_deref(),
        status: status.as_u16(),
        detail: None,
    });

    let mut out = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&hash) {
        out.insert("x-config-hash", v);
    }
    if let Ok(v) = HeaderValue::from_str(&format!("\"{hash}\"")) {
        out.insert(header::ETAG, v);
    }
    Ok((status, out).into_response())
}

async fn delete_slot(
    State(state): State<Arc<AppState>>,
    Extension(TokenPrefix(token)): Extension<TokenPrefix>,
    Path(slot): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let device = device_from(&headers);
    let label = format!("configs/{slot}");
    let handle = Arc::clone(&state);
    blocking(move || handle.store.delete_slot(&slot)).await??;
    state.audit.entry(crate::audit::EntryLog {
        action: "config-delete",
        kb: "",
        path: &label,
        device: device.as_deref(),
        token: token.as_deref(),
        status: 204,
        detail: None,
    });
    Ok(StatusCode::NO_CONTENT)
}

/// The machine that is writing, as it names itself (`X-Source-Device`).
///
/// Purely a label the binding picker shows, so a bad value is dropped rather
/// than refused: failing an upload over a decorative header would be the wrong
/// trade. Trimmed to a sane length and stripped of control characters, because
/// it is written to a file and rendered in the app — untrusted text either way.
fn device_from(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("x-source-device")?.to_str().ok()?.trim();
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).take(64).collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Read `If-Match` / `If-None-Match` into a store precondition.
///
/// Only the two forms a sync client actually sends are accepted — one exact
/// hash, or `*` for "must not exist". The rest of RFC 9110's grammar (lists,
/// `W/` weak validators) is rejected rather than approximated: silently reading
/// a list as "no condition" would turn the safety rail off without saying so.
fn precondition_from(headers: &HeaderMap) -> Result<Precondition, ApiError> {
    if let Some(raw) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
    {
        return if raw.trim() == "*" {
            Ok(Precondition::Absent)
        } else {
            Err(ApiError::bad_request(
                "only `If-None-Match: *` is supported (create-only)",
            ))
        };
    }
    if let Some(raw) = headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok()) {
        let value = raw.trim().trim_matches('"');
        if value.is_empty() || value.contains(',') || raw.trim().starts_with("W/") {
            return Err(ApiError::bad_request(
                "`If-Match` must be exactly one strong entity tag: the hash you expect to replace",
            ));
        }
        return Ok(Precondition::Match(value.to_string()));
    }
    Ok(Precondition::None)
}

// ─── Plumbing ────────────────────────────────────────────────────────────────

/// Run a `store` call off the async runtime.
///
/// Every `store` method is synchronous filesystem work. Called directly from a
/// handler it would block a runtime worker for the duration of a multi-megabyte
/// read or write, which on a small server is a meaningful share of them.
async fn blocking<T, F>(f: F) -> Result<T, ApiError>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f).await.map_err(|e| {
        tracing::error!("worker task failed: {e}");
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "the server could not complete that operation",
        )
    })
}
