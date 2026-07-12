/**
 * fetch used for all AI provider requests.
 *
 * Inside the Tauri app this is `@tauri-apps/plugin-http`'s fetch: the request
 * is sent from the Rust side (reqwest), so it carries no browser Origin header
 * and is not subject to webview CORS. This matters for local servers like
 * Ollama, whose default OLLAMA_ORIGINS whitelist does not include the packaged
 * app's origin (`http://tauri.localhost` on Windows) — with browser fetch the
 * built exe gets CORS-rejected while `pnpm tauri dev` works.
 *
 * Outside Tauri (vitest / plain browser) it falls back to the global fetch at
 * call time, so tests can keep stubbing `globalThis.fetch`.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const fetch: typeof globalThis.fetch = (input, init) =>
  inTauri ? tauriFetch(input, init) : globalThis.fetch(input, init);
