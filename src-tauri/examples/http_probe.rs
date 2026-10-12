//! Non-billed GET probe using the app's exact reqwest dependency/features.
//! cargo run --example http_probe -- http://127.0.0.1:18765/delay
use std::time::Instant;
use tauri_plugin_http::{client_builder, Error};

#[tokio::main]
async fn main() {
    let url = std::env::args().nth(1).expect("provide a GET URL");
    let body_bytes: usize = std::env::args()
        .nth(2)
        .map(|value| value.parse().expect("body byte count"))
        .unwrap_or(0);
    assert!(body_bytes <= 65536, "probe payload is capped at 64 KiB");
    for http1 in [false, true] {
        let mut builder = client_builder().timeout(std::time::Duration::from_secs(180));
        if http1 {
            builder = builder.http1_only();
        }
        let client = builder.build().unwrap();
        let start = Instant::now();
        let result = client
            .get(&url)
            .header("Origin", "tauri://localhost")
            .body(vec![b'x'; body_bytes])
            .send()
            .await;
        match result {
            Ok(response) => {
                println!(
                    "peer={:?} request_body_bytes={body_bytes}",
                    response.remote_addr()
                );
                println!(
                    "http1_only={http1} status={} protocol={:?} headers_ms={}",
                    response.status(),
                    response.version(),
                    start.elapsed().as_millis()
                );
                match response.bytes().await {
                    Ok(bytes) => println!(
                        "body_bytes={} total_ms={}",
                        bytes.len(),
                        start.elapsed().as_millis()
                    ),
                    Err(error) => println!(
                        "{}",
                        serde_json::to_string(&Error::NetworkAt(
                            error,
                            "body",
                            start.elapsed().as_millis() as u64
                        ))
                        .unwrap()
                    ),
                }
            }
            Err(error) => println!(
                "{}",
                serde_json::to_string(&Error::NetworkAt(
                    error,
                    "send",
                    start.elapsed().as_millis() as u64
                ))
                .unwrap()
            ),
        }
    }
}
