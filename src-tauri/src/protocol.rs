use std::fs;
use std::path::PathBuf;
use tauri::{Runtime, UriSchemeContext};
use tauri::http::{Request, Response};

pub fn register_asset_protocol<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_uri_scheme_protocol("ai-writer-asset", handle_asset_request)
}

fn handle_asset_request<R: Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let uri = request.uri().to_string();
    let path_str = uri
        .strip_prefix("ai-writer-asset://localhost")
        .unwrap_or("")
        .to_string();

    let decoded = percent_decode(&path_str);
    let path = PathBuf::from(&decoded);

    match fs::read(&path) {
        Ok(bytes) => {
            let mime = mime_for_path(&path);
            Response::builder()
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap()
        }
        Err(_) => Response::builder()
            .status(404)
            .body(b"Not found".to_vec())
            .unwrap(),
    }
}

fn mime_for_path(path: &PathBuf) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let h1 = chars.next().unwrap_or('0');
            let h2 = chars.next().unwrap_or('0');
            if let Ok(byte) = u8::from_str_radix(&format!("{h1}{h2}"), 16) {
                out.push(byte as char);
            }
        } else {
            out.push(c);
        }
    }
    out
}
