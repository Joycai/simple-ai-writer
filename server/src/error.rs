//! The one way a request fails.
//!
//! Every handler returns `ApiError`, which renders as
//! `{"code": "...", "message": "..."}` with a matching status. The `code` is the
//! stable half — clients branch on it — while `message` is for the operator's
//! log and the app's error toast, and may be reworded freely.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::store::StoreError;

pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    /// Set on a 412 only: the hash actually stored (absent = nothing stored).
    /// Returned so a client whose plan went stale can re-plan without another
    /// round trip — the same reason `StoreError::Precondition` carries it.
    pub current_hash: Option<Option<String>>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            code,
            message: message.into(),
            current_hash: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        ApiError::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        ApiError::new(StatusCode::NOT_FOUND, "not_found", message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "code": self.code, "message": self.message });
        if let Some(current) = self.current_hash {
            body["currentHash"] = match current {
                Some(h) => json!(h),
                None => json!(null),
            };
        }
        (self.status, Json(body)).into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        let message = e.to_string();
        match e {
            StoreError::NoSuchKb(_)
            | StoreError::NoSuchEntry(_)
            | StoreError::NoSuchSlot(_)
            | StoreError::NoSuchVersion(_) => ApiError::not_found(message),
            StoreError::KbExists(_) | StoreError::SlotExists(_) => {
                ApiError::new(StatusCode::CONFLICT, "already_exists", message)
            }
            StoreError::Invalid(_) => ApiError::bad_request(message),
            StoreError::Precondition { current } => ApiError {
                status: StatusCode::PRECONDITION_FAILED,
                code: "precondition_failed",
                message,
                current_hash: Some(current),
            },
            // The detail is logged, not returned: an io error's text carries
            // absolute paths from the server's filesystem.
            StoreError::Io(err) => {
                tracing::error!("storage error: {err}");
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "storage_error",
                    "the server could not complete that operation",
                )
            }
        }
    }
}
