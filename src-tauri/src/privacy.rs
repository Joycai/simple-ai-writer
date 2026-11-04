//! Store document webviews must not bypass the application's consent transport.
use tauri::http::response::Builder;

const DOCUMENT_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' ai-writer-preview:; style-src 'unsafe-inline' ai-writer-preview:; img-src data: blob: ai-writer-preview: ai-writer-asset:; font-src data: ai-writer-preview: ai-writer-font:; connect-src ai-writer-print: ai-writer-preview:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin";

pub(crate) fn document_headers(builder: Builder) -> Builder {
    if cfg!(feature = "app-store") {
        builder.header("Content-Security-Policy", DOCUMENT_CSP)
    } else {
        builder
    }
}

pub(crate) fn document_navigation(url: &tauri::Url, scheme: &str) -> bool {
    !cfg!(feature = "app-store") || (url.scheme() == scheme && url.host_str() == Some("localhost"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn document_network_is_channel_specific() {
        let response = document_headers(tauri::http::Response::builder())
            .body(Vec::<u8>::new())
            .unwrap();
        assert_eq!(
            response.headers().contains_key("Content-Security-Policy"),
            cfg!(feature = "app-store")
        );
        for target in [
            "https://example.test/leak",
            "http://localhost:8080",
            "data:text/html,test",
        ] {
            assert_eq!(
                document_navigation(&target.parse().unwrap(), "ai-writer-preview"),
                !cfg!(feature = "app-store")
            );
        }
        assert!(document_navigation(
            &"ai-writer-preview://localhost/p.html".parse().unwrap(),
            "ai-writer-preview"
        ));
    }
}
