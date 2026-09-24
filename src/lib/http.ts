/**
 * fetch used for all AI provider requests.
 *
 * Inside the Tauri app this is `@tauri-apps/plugin-http`'s fetch: the request is
 * sent from the Rust side (reqwest) so it is not subject to webview CORS. The
 * plugin does, however, attach the webview's own Origin when the caller supplies
 * none — and what that origin is depends on the platform (tauri's
 * `tauri_protocol_url`): `http://tauri.localhost` on Windows/Android,
 * `tauri://localhost` on macOS/Linux, and the devUrl `http://127.0.0.1:1420`
 * under `pnpm tauri dev`.
 *
 * Local servers gate on that value. Ollama's default allowlist takes
 * localhost/127.0.0.1/0.0.0.0 on any port and `tauri://*`, but NOT
 * `http://tauri.localhost` — it answers 403. So the failure is specific to
 * packaged **Windows** builds: dev works (devUrl origin) and packaged
 * macOS/Linux works (`tauri://*`). For local targets we override Origin with one
 * these servers accept, so users don't have to set OLLAMA_ORIGINS themselves.
 *
 * That override only actually leaves the process because src-tauri/Cargo.toml
 * enables tauri-plugin-http's `unsafe-headers` feature. Without it the plugin
 * treats Origin as a forbidden header per the fetch spec, drops it, and appends
 * the webview origin regardless — the override becomes a silent no-op and
 * Windows users get the 403 anyway. Don't drop that feature flag without
 * re-testing a real `tauri build` binary against a default-configured Ollama;
 * `tauri dev` cannot reproduce it, and neither can a machine with
 * OLLAMA_ORIGINS=* set.
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

/**
 * True for a server on this machine **or the local network** — loopback, the
 * RFC 1918 ranges, link-local, CGNAT (Tailscale hands out 100.64/10), IPv6
 * ULA / link-local, and mDNS `.local` names. The question it answers is "may a
 * channel here go without an API key" (`keyOptional` in ai/routes.ts): an
 * Ollama or LM Studio on the desk next to you binds a LAN address and asks for
 * no key. Deliberately *not* folded into `isLocalUrl`: the Origin rewrite
 * above is for OLLAMA_ORIGINS on loopback, and widening it would change
 * requests to LAN hosts that never asked for it.
 */
export function isPrivateNetworkUrl(url: string): boolean {
  if (isLocalUrl(url)) return true;
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.endsWith(".local")) return true;
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    return /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6);
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
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
