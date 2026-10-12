# Local HTTP compatibility and diagnostic patch

Source: crates.io `tauri-plugin-http` 2.6.0, registry checksum
`7241a0c762649be8fba7dd4cc84684d0e409f26b335a978ef4dd5fe78da74ce6`.
Original licenses are retained. Rust source changes are limited to `src/error.rs`,
`src/commands.rs` and `src/lib.rs`; Cargo.toml adds test-only MockRuntime dependencies.
Other copied files support the plugin's unchanged build, IPC and permission scope.

The patch preserves string errors and appends redacted reqwest cause chains,
classification flags, phase and elapsed time. The shared `client_builder` also
clears all three TCP keepalive options to avoid early disconnects on network paths
that do not acknowledge probes. Protocol selection, deadlines, proxy, cookies,
TLS validation, redirects, cancellation and URL scope are retained.
Tests inspect the actual socket and exercise the plugin's cancellation entry points.
Maintenance and validation: `docs/reference/network-diagnostics.md` in the app.
