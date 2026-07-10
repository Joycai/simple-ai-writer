use std::fs;
use std::path::{Path, PathBuf};
use tauri::http::{Request, Response};
use tauri::{Runtime, UriSchemeContext};

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
    // Windows: JS-side `assetUrl` prepends a `/` to drive-lettered paths so the
    // URL is well-formed (`ai-writer-asset://localhost/D:/foo`). Strip that
    // synthetic leading slash before turning the string into a path, otherwise
    // PathBuf interprets `/D:/foo` as an absolute root path and fails to open.
    let cleaned: &str = {
        let bytes = decoded.as_bytes();
        if bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b':'
        {
            &decoded[1..]
        } else {
            &decoded
        }
    };
    let path = PathBuf::from(cleaned);

    // This protocol only ever serves lore avatar images. Restrict it to known image
    // extensions so it can't be coerced (e.g. via a crafted markdown image URL) into
    // reading arbitrary files off disk.
    let mime = match mime_for_path(&path) {
        Some(m) => m,
        None => {
            return Response::builder()
                .status(403)
                .body(b"Forbidden".to_vec())
                .unwrap();
        }
    };

    match fs::read(&path) {
        Ok(bytes) => Response::builder()
            .header("Content-Type", mime)
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap(),
        Err(_) => Response::builder()
            .status(404)
            .body(b"Not found".to_vec())
            .unwrap(),
    }
}

fn mime_for_path(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

fn percent_decode(s: &str) -> String {
    let mut bytes: Vec<u8> = Vec::with_capacity(s.len());
    let s_bytes = s.as_bytes();
    let mut i = 0;
    while i < s_bytes.len() {
        if s_bytes[i] == b'%' && i + 2 < s_bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&s_bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                bytes.push(byte);
                i += 3;
                continue;
            }
        }
        bytes.push(s_bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_allowlist_accepts_known_image_extensions() {
        assert_eq!(mime_for_path(Path::new("/a/b.png")), Some("image/png"));
        assert_eq!(mime_for_path(Path::new("/a/b.JPEG")), Some("image/jpeg"));
        assert_eq!(mime_for_path(Path::new("/a/b.webp")), Some("image/webp"));
        assert_eq!(mime_for_path(Path::new("/a/b.svg")), Some("image/svg+xml"));
    }

    #[test]
    fn mime_allowlist_rejects_non_image_paths() {
        // The 403 guard depends on these returning None — arbitrary files must
        // not be servable through the asset protocol.
        assert_eq!(mime_for_path(Path::new("/etc/passwd")), None);
        assert_eq!(mime_for_path(Path::new("/a/b.txt")), None);
        assert_eq!(mime_for_path(Path::new("/a/config.db")), None);
        assert_eq!(mime_for_path(Path::new("/a/noextension")), None);
    }

    #[test]
    fn percent_decode_handles_encoded_and_plain_input() {
        assert_eq!(percent_decode("/a%20b/c.png"), "/a b/c.png");
        assert_eq!(percent_decode("/plain/path.png"), "/plain/path.png");
        // Malformed escapes pass through instead of panicking.
        assert_eq!(percent_decode("/a%zz.png"), "/a%zz.png");
        // UTF-8 multibyte sequences survive decoding (e.g. CJK dir names).
        assert_eq!(percent_decode("/%E8%A7%92%E8%89%B2.png"), "/角色.png");
    }
}
