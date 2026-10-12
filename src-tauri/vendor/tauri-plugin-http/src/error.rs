// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use serde::{Serialize, Serializer};
use url::Url;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Network(#[from] reqwest::Error),
    #[error("{0}")]
    NetworkAt(reqwest::Error, &'static str, u64),
    #[error(transparent)]
    Http(#[from] http::Error),
    #[error(transparent)]
    HttpInvalidHeaderName(#[from] http::header::InvalidHeaderName),
    #[error(transparent)]
    HttpInvalidHeaderValue(#[from] http::header::InvalidHeaderValue),
    /// URL not allowed by the scope.
    #[error("url not allowed on the configured scope: {0}")]
    UrlNotAllowed(Url),
    #[error(transparent)]
    UrlParseError(#[from] url::ParseError),
    /// HTTP method error.
    #[error(transparent)]
    HttpMethod(#[from] http::method::InvalidMethod),
    #[error("scheme {0} not supported")]
    SchemeNotSupport(String),
    #[error("Request canceled")]
    RequestCanceled,
    #[error(transparent)]
    FsError(#[from] tauri_plugin_fs::Error),
    #[error("failed to process data url")]
    DataUrlError,
    #[error("failed to decode data url into bytes")]
    DataUrlDecodeError,
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error(transparent)]
    Utf8(#[from] std::string::FromUtf8Error),
    #[error("dangerous settings used but are not enabled")]
    DangerousSettings,
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Network(error) => serializer.serialize_str(&network_message(error, "build", 0)),
            Self::NetworkAt(error, phase, elapsed) => {
                serializer.serialize_str(&network_message(error, phase, *elapsed))
            }
            _ => serializer.serialize_str(self.to_string().as_ref()),
        }
    }
}

/// Keep the string rejection contract, but retain the sources reqwest's Display
/// deliberately omits. Never include URL credentials, query strings or fragments.
fn redact_urls(text: &str) -> String {
    let pattern = regex::Regex::new(r#"https?://[^\s\"<>]+"#).expect("static URL regex");
    pattern
        .replace_all(text, |captures: &regex::Captures<'_>| {
            let raw = &captures[0];
            // Parentheses delimit reqwest's outer message, not the diagnostic URL.
            let value = raw.trim_end_matches([')', ',', ';']);
            match Url::parse(value) {
                Ok(mut url) => {
                    let _ = url.set_username("");
                    let _ = url.set_password(None);
                    url.set_query(None);
                    url.set_fragment(None);
                    format!("{}{}", url, &raw[value.len()..])
                }
                Err(_) => "<redacted-url>".into(),
            }
        })
        .into_owned()
}

pub fn network_message(error: &reqwest::Error, phase: &str, elapsed_ms: u64) -> String {
    use std::error::Error as _;
    let message = redact_urls(&error.to_string());
    let mut causes = Vec::new();
    let mut io_errors = Vec::new();
    let mut source = error.source();
    while let Some(cause) = source {
        causes.push(redact_urls(&cause.to_string()));
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            io_errors.push(serde_json::json!({"kind": format!("{:?}", io.kind()), "osCode": io.raw_os_error()}));
        }
        source = cause.source();
        if causes.len() == 16 {
            break;
        }
    }
    let detail = serde_json::json!({
        "phase": phase, "phaseElapsedMs": elapsed_ms,
        "timeout": error.is_timeout(), "connect": error.is_connect(),
        "body": error.is_body(), "decode": error.is_decode(),
        "request": error.is_request(), "causes": causes,
        "ioErrors": io_errors,
    });
    format!("{message}\n[network-details] {detail}")
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod diagnostic_tests {
    use super::*;

    #[test]
    fn removes_secrets_from_every_url() {
        assert_eq!(
            redact_urls("request (https://user:secret@example.com/api?key=secret#token) failed"),
            "request (https://example.com/api) failed"
        );
    }

    #[test]
    fn preserves_non_url_causes_and_old_rejections() {
        assert_eq!(
            redact_urls("connection reset by peer (os error 54)"),
            "connection reset by peer (os error 54)"
        );
        assert_eq!(
            serde_json::to_value(Error::RequestCanceled).unwrap(),
            "Request canceled"
        );
    }
}
