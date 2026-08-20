/**
 * HTTP client for the knowledge-base backup server (`server/`).
 *
 * Goes through `lib/http`'s fetch — the Tauri one, which issues the request
 * from Rust — so a self-hosted server on the LAN is reachable without CORS
 * headers it has no reason to serve.
 *
 * Every mutation here takes a precondition and sends it as `If-Match` /
 * `If-None-Match`. That is not politeness: the manifest a sync planned against
 * can be minutes old by the time these calls run, and without the header the
 * server would happily overwrite work another machine pushed in between —
 * reintroducing, one layer down, exactly the failure the three-way plan exists
 * to prevent. `SyncConflictError` is what a violated precondition becomes, and
 * it carries the hash that is actually stored so a caller can re-plan.
 */

import { fetch } from "../http";
import { normalizeServerUrl } from "./config";
import type { HashMap } from "./model";

export interface RemoteKb {
  id: string;
  name: string;
  createdAtMs: number;
}

export interface RemoteManifestEntry {
  path: string;
  hash: string;
  size: number;
  updatedAtMs: number;
}

export interface RemoteManifest {
  kb: RemoteKb;
  /** sha256 over the sorted path+hash list — "has anything changed at all". */
  digest: string;
  entries: RemoteManifestEntry[];
}

/** A precondition on a write, mirroring `server/src/store.rs`'s `Precondition`. */
export type Expect =
  | { kind: "absent" }
  | { kind: "hash"; hash: string }
  /** No condition. Only for a flow that has explicitly opted out of the rail. */
  | { kind: "any" };

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SyncHttpError";
  }
}

/**
 * A precondition was not met — the remote moved since the plan was made.
 * Distinct from a generic HTTP failure because it is the one error the caller
 * can act on without the author: re-fetch the manifest and re-plan.
 */
export class SyncConflictError extends SyncHttpError {
  constructor(
    readonly path: string,
    /** What the server actually holds; null when it holds nothing. */
    readonly currentHash: string | null,
    message: string,
  ) {
    super(412, "precondition_failed", message);
    this.name = "SyncConflictError";
  }
}

export interface SyncClient {
  listKbs(): Promise<RemoteKb[]>;
  createKb(name: string): Promise<RemoteKb>;
  manifest(kbId: string): Promise<RemoteManifest>;
  downloadEntry(kbId: string, path: string): Promise<{ bytes: Uint8Array; hash: string }>;
  uploadEntry(kbId: string, path: string, hash: string, bytes: Uint8Array, expect: Expect): Promise<void>;
  deleteEntry(kbId: string, path: string, expect: Expect): Promise<void>;
}

export function createSyncClient(serverUrl: string, token: string): SyncClient {
  const base = normalizeServerUrl(serverUrl);

  const authHeaders = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  /**
   * Percent-encode each path segment, never the separator.
   *
   * Entry ids are routinely non-ASCII — `slugifyEntityId` keeps CJK verbatim —
   * and may contain `#`, `?` or `%`. `encodeURIComponent` per segment is the
   * only encoding that survives all three; encoding the whole path would escape
   * the `/` that separates category from id.
   */
  const entryUrl = (kbId: string, path: string) =>
    `${base}/v1/kbs/${encodeURIComponent(kbId)}/entries/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;

  const preconditionHeaders = (expect: Expect): Record<string, string> => {
    if (expect.kind === "absent") return { "If-None-Match": "*" };
    if (expect.kind === "hash") return { "If-Match": `"${expect.hash}"` };
    return {};
  };

  async function fail(response: Response, path?: string): Promise<never> {
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
      // A proxy or a misconfigured server can answer with HTML; the status line
      // is still worth reporting, so a non-JSON body is not itself an error.
    }
    if (response.status === 412) {
      throw new SyncConflictError(path ?? "", currentHash, message);
    }
    throw new SyncHttpError(response.status, code, message);
  }

  return {
    async listKbs() {
      const r = await fetch(`${base}/v1/kbs`, { headers: authHeaders() });
      if (!r.ok) await fail(r);
      return (await r.json()) as RemoteKb[];
    },

    async createKb(name) {
      const r = await fetch(`${base}/v1/kbs`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) await fail(r);
      return (await r.json()) as RemoteKb;
    },

    async manifest(kbId) {
      const r = await fetch(`${base}/v1/kbs/${encodeURIComponent(kbId)}/manifest`, {
        headers: authHeaders(),
      });
      if (!r.ok) await fail(r);
      return (await r.json()) as RemoteManifest;
    },

    async downloadEntry(kbId, path) {
      const r = await fetch(entryUrl(kbId, path), { headers: authHeaders() });
      if (!r.ok) await fail(r, path);
      // The header is the server's own record of what these bytes are; the
      // caller re-hashes the unpacked directory against it rather than trusting
      // either side blindly (see ./run).
      const hash = r.headers.get("x-entry-hash") ?? "";
      return { bytes: new Uint8Array(await r.arrayBuffer()), hash };
    },

    async uploadEntry(kbId, path, hash, bytes, expect) {
      // Sent as a plain ArrayBuffer sliced to the view's own window: a
      // `Uint8Array` produced by `subarray` shares a larger buffer, and handing
      // that buffer to fetch would upload the neighbouring bytes too.
      const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const r = await fetch(entryUrl(kbId, path), {
        method: "PUT",
        headers: {
          ...authHeaders(),
          ...preconditionHeaders(expect),
          "Content-Type": "application/zip",
          "X-Entry-Hash": hash,
        },
        body,
      });
      if (!r.ok) await fail(r, path);
    },

    async deleteEntry(kbId, path, expect) {
      const r = await fetch(entryUrl(kbId, path), {
        method: "DELETE",
        headers: { ...authHeaders(), ...preconditionHeaders(expect) },
      });
      // 404 is success for a delete: the end state a mirror wants is "not
      // there", and someone else having removed it first achieves that. Failing
      // would leave the sync stuck on an entry nobody has.
      if (!r.ok && r.status !== 404) await fail(r, path);
    },
  };
}

/** A manifest reduced to the hash map the planner takes. */
export function manifestHashes(manifest: RemoteManifest): HashMap {
  const out: Record<string, string> = {};
  for (const entry of manifest.entries) out[entry.path] = entry.hash;
  return out;
}
