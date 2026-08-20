/**
 * Where the server is, and how we authenticate to it.
 *
 * Split deliberately from `SyncBinding` (which lives in the project's
 * `.ai-writer/sync.json`): the address and the token describe the
 * **installation**, not the project. Several projects share one server, so
 * storing them per project would mean re-entering a token for each one — and
 * would put a bearer token inside a folder the author may hand to someone else.
 *
 * The address is an ordinary preference; the token goes to the OS keyring,
 * through the same `secret_*` commands the AI provider keys use.
 */

import { readPref, writePref } from "../prefs";
import { deleteApiKey, loadApiKey, saveApiKey } from "../keyStore";

/**
 * Keyring account for a server's token.
 *
 * Namespaced by URL rather than a single global key so an author who moves from
 * a laptop server to a hosted one does not silently authenticate to the new
 * address with the old secret. `keyStore` keys are opaque strings to the Rust
 * side (`Entry::new(SERVICE, provider_id)`), so a prefix is all the separation
 * this needs.
 */
function tokenAccount(serverUrl: string): string {
  return `kbsync:${normalizeServerUrl(serverUrl)}`;
}

/**
 * Canonical form of a server address: no trailing slash, trimmed.
 *
 * Applied everywhere an address is stored or compared, because
 * `http://box:8787` and `http://box:8787/` are the same server but two keyring
 * accounts and two `serverUrl` values that would not match the binding check.
 */
export function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function getServerUrl(): string {
  return readPref("app:kbServerUrl") ?? "";
}

export function setServerUrl(url: string): void {
  writePref("app:kbServerUrl", normalizeServerUrl(url));
}

export async function loadToken(serverUrl: string): Promise<string | null> {
  return loadApiKey(tokenAccount(serverUrl));
}

export async function saveToken(serverUrl: string, token: string): Promise<void> {
  await saveApiKey(tokenAccount(serverUrl), token);
}

export async function deleteToken(serverUrl: string): Promise<void> {
  await deleteApiKey(tokenAccount(serverUrl));
}
