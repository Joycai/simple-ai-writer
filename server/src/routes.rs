//! HTTP surface.
//!
//! ```text
//! GET    /health                                     no auth — liveness only
//! GET    /v1/kbs                                     list knowledge bases
//! POST   /v1/kbs                                     create one
//! GET    /v1/kbs/{kb}/manifest                       every entry's hash — the sync plan's input
//! GET    /v1/kbs/{kb}/entries/{category}/{id}        download one entry (zip)
//! PUT    /v1/kbs/{kb}/entries/{category}/{id}        upload one entry (zip)
//! DELETE /v1/kbs/{kb}/entries/{category}/{id}        remove one entry (mirror semantics)
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

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;

use crate::error::ApiError;
use crate::store::{KbMeta, Manifest, Precondition, PutOutcome, Store};

pub struct AppState {
    pub store: Store,
    pub tokens: Vec<String>,
    pub allow_anonymous: bool,
}

pub fn router(state: Arc<AppState>, max_entry_bytes: usize) -> Router {
    let api = Router::new()
        .route("/v1/kbs", get(list_kbs).post(create_kb))
        .route("/v1/kbs/{kb}/manifest", get(manifest))
        .route(
            "/v1/kbs/{kb}/entries/{category}/{id}",
            get(get_entry).put(put_entry).delete(delete_entry),
        )
        .layer(DefaultBodyLimit::max(max_entry_bytes))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            require_token,
        ));

    Router::new()
        // Outside the auth layer: a reverse proxy or a container runtime has to
        // be able to probe liveness without holding a token, and this answers
        // nothing about the stored data.
        .route("/health", get(|| async { "ok" }))
        .merge(api.with_state(state))
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
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if state.allow_anonymous {
        return Ok(next.run(request).await);
    }
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("");

    // Every configured token is compared even after a match, so the time taken
    // does not reveal which one (or how many there are).
    let mut ok = false;
    for token in &state.tokens {
        ok |= constant_time_eq(token.as_bytes(), presented.as_bytes());
    }
    if !ok {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "a valid `Authorization: Bearer <token>` header is required",
        ));
    }
    Ok(next.run(request).await)
}

// ─── Knowledge bases ─────────────────────────────────────────────────────────

async fn list_kbs(State(state): State<Arc<AppState>>) -> Result<Json<Vec<KbMeta>>, ApiError> {
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
    Json(body): Json<CreateKb>,
) -> Result<(StatusCode, Json<KbMeta>), ApiError> {
    let store = Arc::clone(&state);
    let meta = blocking(move || store.store.create_kb(&body.name, body.id.as_deref())).await??;
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

// ─── Entries ─────────────────────────────────────────────────────────────────

async fn get_entry(
    State(state): State<Arc<AppState>>,
    Path((kb, category, id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let store = Arc::clone(&state);
    let (bytes, hash) = blocking(move || store.store.read_entry(&kb, &category, &id)).await??;

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

    let store = Arc::clone(&state);
    let outcome = blocking(move || {
        store
            .store
            .put_entry(&kb, &category, &id, &hash, &body, precondition)
    })
    .await??;

    Ok(match outcome {
        PutOutcome::Created => StatusCode::CREATED,
        PutOutcome::Replaced => StatusCode::NO_CONTENT,
    })
}

async fn delete_entry(
    State(state): State<Arc<AppState>>,
    Path((kb, category, id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let precondition = precondition_from(&headers)?;
    let store = Arc::clone(&state);
    blocking(move || store.store.delete_entry(&kb, &category, &id, precondition)).await??;
    Ok(StatusCode::NO_CONTENT)
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
