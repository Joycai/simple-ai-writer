/**
 * fetch used for all AI provider requests.
 *
 * Inside the Tauri app this is `@tauri-apps/plugin-http`'s fetch: the request is
 * sent from the Rust side (reqwest) so it is not subject to webview CORS. The
 * plugin does, however, forward the webview's Origin header — `tauri.localhost`
 * in the packaged app, `localhost:1420` under `pnpm tauri dev`. Local servers
 * like Ollama gate on this: their default OLLAMA_ORIGINS allowlist accepts
 * `localhost` but not `tauri.localhost`, so the built exe gets a 403 while dev
 * works. For local targets we override Origin with one these servers accept, so
 * users don't have to set OLLAMA_ORIGINS themselves.
 *
 * Outside Tauri (vitest / plain browser) it falls back to the global fetch at
 * call time, so tests can keep stubbing `globalThis.fetch`.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * True for requests targeting a server on the local machine. Exported so
 * ai/endpointProbe.ts's looksLocal can share this exact hostname check
 * rather than drifting from it — endpointProbe additionally treats a few
 * well-known local-model-server ports as a signal on their own, which is a
 * fine heuristic for its own low-stakes decision (try a couple of extra
 * probe requests against what might not even be a local server), but not
 * one this module should adopt: rewriting Origin here on that same
 * heuristic could break a legitimate CORS-sensitive request to an actually
 * remote host reachable on one of those ports, instead of fixing one.
 */
export function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url.trim());
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export const fetch: typeof globalThis.fetch = (input, init) => {
  if (!inTauri) return globalThis.fetch(input, init);
  if (isLocalUrl(urlOf(input))) {
    const headers = new Headers(init?.headers);
    if (!headers.has("Origin")) headers.set("Origin", "http://localhost");
    return tauriFetch(input, { ...init, headers });
  }
  return tauriFetch(input, init);
};
