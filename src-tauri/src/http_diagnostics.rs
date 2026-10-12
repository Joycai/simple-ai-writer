//! Regression coverage for the vendored HTTP plugin's IPC error contract.
#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{Duration, Instant};
    use tauri_plugin_http::{client_builder, Error};

    #[cfg(unix)]
    #[tokio::test]
    async fn shared_client_disables_keepalive_on_the_real_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0; 2048];
            assert!(stream.read(&mut buffer).unwrap() > 0);
            ready_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        let request = tokio::spawn(async move {
            client_builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(format!("http://{address}/"))
                .send()
                .await
                .unwrap()
        });
        ready_rx.await.unwrap();
        let mut keepalive = None;
        for fd in 0..1024 {
            // Inspect only this process's IPv4 socket connected to our fixture.
            let mut peer: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
            let mut peer_len = std::mem::size_of_val(&peer) as libc::socklen_t;
            let result = unsafe {
                libc::getpeername(
                    fd,
                    (&mut peer as *mut libc::sockaddr_storage).cast(),
                    &mut peer_len,
                )
            };
            if result != 0 || peer.ss_family as i32 != libc::AF_INET {
                continue;
            }
            let peer =
                unsafe { &*((&peer as *const libc::sockaddr_storage).cast::<libc::sockaddr_in>()) };
            if u16::from_be(peer.sin_port) != address.port() {
                continue;
            }
            let mut enabled: libc::c_int = -1;
            let mut size = std::mem::size_of_val(&enabled) as libc::socklen_t;
            assert_eq!(
                unsafe {
                    libc::getsockopt(
                        fd,
                        libc::SOL_SOCKET,
                        libc::SO_KEEPALIVE,
                        (&mut enabled as *mut libc::c_int).cast(),
                        &mut size,
                    )
                },
                0
            );
            keepalive = Some(enabled);
            break;
        }
        release_tx.send(()).unwrap();
        assert_eq!(request.await.unwrap().text().await.unwrap(), "ok");
        server.join().unwrap();
        assert_eq!(
            keepalive,
            Some(0),
            "the shared client's actual socket must not enable TCP probes"
        );
    }

    #[tokio::test]
    async fn ipc_retains_timeout_causes_and_redacts_url_secrets() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0; 2048];
            let _ = stream.read(&mut buffer);
            std::thread::sleep(Duration::from_millis(150));
        });
        let start = Instant::now();
        let error = client_builder()
            .no_proxy()
            .timeout(Duration::from_millis(50))
            .build()
            .unwrap()
            .get(format!("http://{address}/?key=do-not-log#secret"))
            .send()
            .await
            .unwrap_err();
        let wire = serde_json::to_value(Error::NetworkAt(
            error,
            "send",
            start.elapsed().as_millis() as u64,
        ))
        .unwrap();
        let message = wire.as_str().unwrap();
        let (_, json) = message.split_once("\n[network-details] ").unwrap();
        let details: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(details["phase"], "send");
        assert_eq!(details["timeout"], true);
        assert!(details["causes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|cause| cause.as_str().unwrap().contains("timed out")));
        assert!(!message.contains("do-not-log"));
        assert!(!message.contains("#secret"));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn truncated_body_is_distinguished_from_send_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0; 2048];
            let _ = stream.read(&mut buffer);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx")
                .unwrap();
        });
        let response = client_builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap();
        let error = response.bytes().await.unwrap_err();
        let wire = serde_json::to_value(Error::NetworkAt(error, "body", 0)).unwrap();
        let (_, json) = wire
            .as_str()
            .unwrap()
            .split_once("\n[network-details] ")
            .unwrap();
        let details: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(details["phase"], "body");
        assert!(!details["causes"].as_array().unwrap().is_empty());
        server.join().unwrap();
    }

    #[tokio::test]
    #[ignore = "65-second non-billed network investigation; run explicitly"]
    async fn shared_transport_waits_past_one_minute() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0; 2048];
            let read = stream.read(&mut buffer).unwrap();
            assert!(read > 0);
            std::thread::sleep(Duration::from_secs(65));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        // The actual shared builder used by the plugin; no timeout override.
        let start = Instant::now();
        let response = client_builder()
            .build()
            .unwrap()
            .get(format!("http://{address}/delay"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.text().await.unwrap(), "ok");
        assert!(start.elapsed() >= Duration::from_secs(65));
        server.join().unwrap();
    }

    #[tokio::test]
    #[ignore = "65-second local SSE pause regression; run explicitly"]
    async fn shared_stream_survives_a_pause_past_one_minute() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0; 2048];
            assert!(stream.read(&mut buffer).unwrap() > 0);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 25\r\nConnection: close\r\n\r\ndata: first\n\n").unwrap();
            std::thread::sleep(Duration::from_secs(65));
            stream.write_all(b"data: done\n\n").unwrap();
        });
        let mut response = client_builder()
            .build()
            .unwrap()
            .get(format!("http://{address}/stream"))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.chunk().await.unwrap().unwrap().as_ref(),
            b"data: first\n\n"
        );
        let start = Instant::now();
        assert_eq!(
            response.chunk().await.unwrap().unwrap().as_ref(),
            b"data: done\n\n"
        );
        assert!(start.elapsed() >= Duration::from_secs(64));
        assert!(response.chunk().await.unwrap().is_none());
        server.join().unwrap();
    }
}
