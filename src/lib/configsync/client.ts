/**
 * HTTP client for the server's `/v1/configs` resource.
 *
 * Shaped after `lib/sync/client` on purpose — same `lib/http` fetch (the Tauri
 * one, issued from Rust, so a LAN server needs no CORS headers), same `Expect`
 * precondition vocabulary, same 412 → `SyncConflictError`. The two resources
 * are unrelated, but the failure they guard against is the same one: a plan
 * made against a listing that has since moved, overwriting what another machine
 * pushed in between.
 *
 * **The connection is not this module's own.** Address and token come from
 * `lib/sync/config`, where they already live as installation-level facts —
 * several projects share one server, and the address+token describe the
 * install, not the project. Giving config backup a second address to fill in
 * would mean typing the same token twice for one server.
 */

import { fetch } from "../http";
import { getServerUrl, loadToken, normalizeServerUrl } from "../sync/config";
import { deviceLabel } from "../sync/local";
import { SyncConflictError, SyncHttpError, type Expect } from "../sync/client";

/** One backup slot as the server reports it. */
export interface RemoteSlot {
  id: string;
  name: string;
  createdAtMs: number;
  versionCount: number;
  /** The version a bare download returns; null for a slot never written to. */
  current: RemoteSlotVersion | null;
}

export interface RemoteSlotVersion {
  atMs: number;
  hash: string;
  size: number;
  /** The client's own envelope header, base64url. Opaque to the server. */
  meta: string | null;
}

export interface DownloadedConfig {
  bytes: Uint8Array;
  hash: string;
  atMs: number;
}

export interface ConfigSyncClient {
  listSlots(): Promise<RemoteSlot[]>;
  createSlot(name: string): Promise<RemoteSlot>;
  listVersions(slotId: string): Promise<RemoteSlotVersion[]>;
  download(slotId: string, atMs?: number): Promise<DownloadedConfig>;
  upload(slotId: string, bytes: Uint8Array, meta: string, expect: Expect): Promise<string>;
  deleteSlot(slotId: string): Promise<void>;
}

export function createConfigSyncClient(
  serverUrl: string,
  token: string,
  device = "",
): ConfigSyncClient {
  const base = normalizeServerUrl(serverUrl);
  const authHeaders = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });
  const deviceHeaders = (): Record<string, string> =>
    device.trim() ? { "X-Source-Device": device.trim() } : {};
  const slotUrl = (id: string) => `${base}/v1/configs/${encodeURIComponent(id)}`;

  const preconditionHeaders = (expect: Expect): Record<string, string> => {
    if (expect.kind === "absent") return { "If-None-Match": "*" };
    if (expect.kind === "hash") return { "If-Match": `"${expect.hash}"` };
    return {};
  };

  async function fail(response: Response, slotId?: string): Promise<never> {
    let code = "http_error";
    let message = `${response.status} ${response.statusText}`;
    let currentHash: string | null = null;
    try {
      const body = (await response.json()) as {
        code?: string;
        message?: string;
        currentHash?: string | null;
      };
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") message = body.message;
      if (body.currentHash !== undefined) currentHash = body.currentHash;
    } catch {
      // A proxy can answer with HTML; the status line is still worth reporting.
    }
    if (response.status === 412) throw new SyncConflictError(slotId ?? "", currentHash, message);
    throw new SyncHttpError(response.status, code, message);
  }

  return {
    async listSlots() {
      const r = await fetch(`${base}/v1/configs`, { headers: authHeaders() });
      if (!r.ok) await fail(r);
      return (await r.json()) as RemoteSlot[];
    },

    async createSlot(name) {
      const r = await fetch(`${base}/v1/configs`, {
        method: "POST",
        headers: { ...authHeaders(), ...deviceHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) await fail(r);
      return (await r.json()) as RemoteSlot;
    },

    async listVersions(slotId) {
      const r = await fetch(`${slotUrl(slotId)}/versions`, { headers: authHeaders() });
      if (!r.ok) await fail(r, slotId);
      return (await r.json()) as RemoteSlotVersion[];
    },

    async download(slotId, atMs) {
      const url = atMs === undefined ? slotUrl(slotId) : `${slotUrl(slotId)}/versions/${atMs}`;
      const r = await fetch(url, { headers: authHeaders() });
      if (!r.ok) await fail(r, slotId);
      return {
        bytes: new Uint8Array(await r.arrayBuffer()),
        hash: r.headers.get("x-config-hash") ?? "",
        atMs: Number(r.headers.get("x-config-at") ?? 0),
      };
    },

    async upload(slotId, bytes, meta, expect) {
      // Sliced to the view's own window: a `Uint8Array` from `subarray` shares a
      // larger buffer, and handing that buffer to fetch uploads the neighbours.
      const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const r = await fetch(slotUrl(slotId), {
        method: "PUT",
        headers: {
          ...authHeaders(),
          ...deviceHeaders(),
          ...preconditionHeaders(expect),
          "Content-Type": "application/octet-stream",
          "X-Config-Meta": meta,
        },
        body,
      });
      if (!r.ok) await fail(r, slotId);
      return r.headers.get("x-config-hash") ?? "";
    },

    async deleteSlot(slotId) {
      const r = await fetch(slotUrl(slotId), {
        method: "DELETE",
        headers: { ...authHeaders(), ...deviceHeaders() },
      });
      // 404 is the end state a delete wants; someone else having got there
      // first achieves it. Failing would strand the author on a slot nobody has.
      if (!r.ok && r.status !== 404) await fail(r, slotId);
    },
  };
}

/**
 * A client built from the stored installation-level connection.
 *
 * Returns null when no server address has been saved — the caller's cue to show
 * "connect first" rather than an error. The token is read at call time rather
 * than held: it is a bearer secret, and the store that drives this UI should not
 * be the thing keeping it in memory between actions.
 */
export async function connectedConfigClient(): Promise<ConfigSyncClient | null> {
  const url = getServerUrl();
  if (!url) return null;
  const token = (await loadToken(url)) ?? "";
  return createConfigSyncClient(url, token, await deviceLabel());
}
