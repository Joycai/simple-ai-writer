/**
 * The envelope: what a configuration looks like once it leaves this machine.
 *
 * A config bundle carries the author's provider setup, their prompts, and —
 * when they ask for it — their API keys. The local file export writes that in
 * plain text and warns, which is a fair trade for a file sitting on the
 * author's own disk. Pushing the same thing to a sync server is not the same
 * trade: anyone holding a sync token can download it, and the admin console can
 * pull the whole data directory in one click. So the bytes that go to the server
 * are sealed here, on the author's machine, with a key derived from a password
 * the server never sees and has no way to recover.
 *
 * ```jsonc
 * {
 *   "kind": "ai-writer-config-envelope", "version": 1,
 *   "createdAt": "…", "appVersion": "1.23.1", "device": "REINE-DESKTOP",
 *   "encrypted": true, "hasKeys": true,
 *   "counts": { "providers": 6, "models": 23, "prompts": 4, "prefs": 31 },
 *   "kdf":    { "name": "PBKDF2", "hash": "SHA-256", "iterations": 310000, "salt": "<b64>" },
 *   "cipher": { "name": "AES-GCM", "iv": "<b64>" },
 *   "payload": "<b64 ciphertext>"      // encrypted:false → the bundle object itself
 * }
 * ```
 *
 * Four things here are load-bearing:
 *
 * **The header is plaintext and holds only display facts.** `device`,
 * `appVersion`, `counts` and `hasKeys` are what lets a second machine show a
 * useful list *before* anyone types a password — "this is the one I pushed from
 * the laptop, six providers". Nothing in the header narrows the password or the
 * contents; the server stores it verbatim and never parses it, which is why the
 * format can keep moving without redeploying the server.
 *
 * **`counts` is self-reported and unverifiable.** Once the payload is encrypted
 * nobody can check it, so it may only ever be *shown*. The sentence that tells
 * the author what a restore will merge has to be computed from the decrypted,
 * re-validated bundle — never from this. Rendering `counts` into a confirmation
 * would put a number the author trusts in front of a number nothing checked.
 *
 * **A bundle carrying keys cannot be sealed without a password.** Not a warning
 * — `sealBundle` throws. That invariant is the entire reason this module exists,
 * and a caller that could opt out of it would eventually be written.
 *
 * **The KDF parameters travel in the envelope, not in this file.** Iteration
 * counts get raised; every envelope written before the raise still has to open.
 *
 * A wrong password and a corrupted payload are one failure here, deliberately:
 * AES-GCM's tag check cannot distinguish them, and a message that claimed to
 * would be a guess dressed as a fact.
 */

import type { ConfigBackup } from "../ai/configTransfer";

export const ENVELOPE_KIND = "ai-writer-config-envelope";
export const ENVELOPE_VERSION = 1;

/**
 * PBKDF2-SHA256 rounds for a new envelope. OWASP's floor for this KDF.
 *
 * Read from the envelope on the way back in, never from here — see the module
 * doc. Raising it is a one-line change that leaves every existing backup
 * openable; hardcoding it at the open side would not have been.
 */
export const PBKDF2_ITERATIONS = 310_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EnvelopeCounts {
  providers: number;
  models: number;
  prompts: number;
  prefs: number;
}

export interface EnvelopeHeader {
  kind: typeof ENVELOPE_KIND;
  version: number;
  createdAt: string;
  appVersion: string;
  /** The machine that pushed it, as it names itself. Decoration; may be "". */
  device: string;
  encrypted: boolean;
  /** Whether the payload carries API keys. Always false when `encrypted` is false. */
  hasKeys: boolean;
  /** Self-reported. Display only — see the module doc. */
  counts: EnvelopeCounts;
  kdf?: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher?: { name: "AES-GCM"; iv: string };
}

interface Envelope extends EnvelopeHeader {
  payload: string | unknown;
}

export type EnvelopeErrorCode =
  /** Not an envelope at all — wrong file, or truncated download. */
  | "not-an-envelope"
  /** Written by a newer build than this one. */
  | "unsupported-version"
  /** Encrypted, and no password was supplied. */
  | "password-required"
  /** The password is wrong, or the payload was tampered with. Indistinguishable. */
  | "bad-password"
  /** Sealing was asked to put API keys on a server unencrypted. Refused. */
  | "keys-need-password"
  /** A KDF or cipher this build does not implement. */
  | "unsupported-crypto"
  /** `crypto.subtle` is missing — the page is not a secure context. */
  | "no-webcrypto";

export class EnvelopeError extends Error {
  constructor(
    readonly code: EnvelopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EnvelopeError";
  }
}

// ─── base64 ──────────────────────────────────────────────────────────────────
//
// Chunked rather than `String.fromCharCode(...bytes)`: a config bundle with a
// few dozen models is comfortably past the argument-count limit that spreads a
// byte array into a call, and the failure is a RangeError at the worst moment.

const CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(text: string): Uint8Array {
  let b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return fromBase64(b64);
}

// ─── crypto ──────────────────────────────────────────────────────────────────

/**
 * The WebCrypto surface, or a legible error.
 *
 * `crypto.subtle` exists only in a secure context. The app's window is one —
 * `http://tauri.localhost` is a potentially-trustworthy origin, and the copy
 * buttons all over the app already depend on `navigator.clipboard`, which is
 * gated identically. This guard is here so that if that ever stops being true,
 * the author reads one sentence rather than "Cannot read properties of
 * undefined".
 */
function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle;
  if (!api) {
    throw new EnvelopeError(
      "no-webcrypto",
      "this window has no Web Crypto (crypto.subtle), so a configuration cannot be encrypted here",
    );
  }
  return api;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const api = subtle();
  const material = await api.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return api.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, hash: "SHA-256", iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// ─── seal ────────────────────────────────────────────────────────────────────

export interface SealOptions {
  /** This machine's name (`lib/sync/local`'s `deviceLabel`). "" is fine. */
  device: string;
  appVersion: string;
  /** null seals in the clear — refused when the bundle carries API keys. */
  password: string | null;
}

export interface SealedEnvelope {
  bytes: Uint8Array;
  header: EnvelopeHeader;
  /** The header as base64url, for the server's `X-Config-Meta`. */
  meta: string;
}

function countsOf(bundle: ConfigBackup): EnvelopeCounts {
  return {
    providers: bundle.providers.length,
    models: bundle.models.length,
    prompts: bundle.prompts.length,
    prefs: bundle.prefs?.length ?? 0,
  };
}

export function bundleHasKeys(bundle: ConfigBackup): boolean {
  return bundle.providers.some((p) => typeof p.apiKey === "string" && p.apiKey.length > 0);
}

/** Seal a bundle for upload. Throws `EnvelopeError` — see `EnvelopeErrorCode`. */
export async function sealBundle(
  bundle: ConfigBackup,
  options: SealOptions,
): Promise<SealedEnvelope> {
  const hasKeys = bundleHasKeys(bundle);
  const password = options.password?.length ? options.password : null;
  if (hasKeys && !password) {
    // The invariant, enforced rather than advised. A backup with keys and no
    // password would hand every provider credential to anyone holding a sync
    // token — and to whoever downloads the server's data directory.
    throw new EnvelopeError(
      "keys-need-password",
      "a backup that includes API keys must be protected with a password",
    );
  }

  const header: EnvelopeHeader = {
    kind: ENVELOPE_KIND,
    version: ENVELOPE_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: options.appVersion,
    device: options.device,
    encrypted: !!password,
    hasKeys,
    counts: countsOf(bundle),
  };

  let payload: string | unknown;
  if (password) {
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const cipherText = await subtle().encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(JSON.stringify(bundle)) as BufferSource,
    );
    header.kdf = {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: toBase64(salt),
    };
    header.cipher = { name: "AES-GCM", iv: toBase64(iv) };
    payload = toBase64(new Uint8Array(cipherText));
  } else {
    // Left as an object rather than base64: an unencrypted backup should stay
    // as readable in any JSON tool as the file export it mirrors.
    payload = bundle;
  }

  const envelope: Envelope = { ...header, payload };
  return {
    bytes: new TextEncoder().encode(JSON.stringify(envelope)),
    header,
    meta: encodeMeta(header),
  };
}

// ─── open ────────────────────────────────────────────────────────────────────

function validateHeader(raw: unknown): EnvelopeHeader {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== "object" || r.kind !== ENVELOPE_KIND) {
    throw new EnvelopeError("not-an-envelope", "this is not a configuration backup");
  }
  const version = typeof r.version === "number" ? r.version : 0;
  if (version > ENVELOPE_VERSION) {
    throw new EnvelopeError(
      "unsupported-version",
      "this backup was written by a newer version of the app",
    );
  }
  const counts = (r.counts ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    kind: ENVELOPE_KIND,
    version,
    createdAt: s(r.createdAt),
    appVersion: s(r.appVersion),
    device: s(r.device),
    encrypted: r.encrypted === true,
    hasKeys: r.hasKeys === true,
    counts: {
      providers: n(counts.providers),
      models: n(counts.models),
      prompts: n(counts.prompts),
      prefs: n(counts.prefs),
    },
    kdf: r.kdf as EnvelopeHeader["kdf"],
    cipher: r.cipher as EnvelopeHeader["cipher"],
  };
}

/**
 * Read the plaintext header without touching the payload.
 *
 * This is what a listing shows before anyone is asked for a password.
 */
export function readEnvelopeHeader(bytes: Uint8Array): EnvelopeHeader {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new EnvelopeError("not-an-envelope", "this is not a configuration backup");
  }
  return validateHeader(raw);
}

export interface OpenedEnvelope {
  header: EnvelopeHeader;
  /** The bundle as it was sealed. Still has to go through `parseConfigBundle`. */
  bundle: unknown;
}

/**
 * Open an envelope, decrypting it when it is encrypted.
 *
 * Returns the payload **unvalidated**: what a config bundle is allowed to
 * contain is `lib/ai/configTransfer`'s call, made in one place for the file
 * route and this one alike.
 */
export async function openEnvelope(
  bytes: Uint8Array,
  password?: string | null,
): Promise<OpenedEnvelope> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    throw new EnvelopeError("not-an-envelope", "this is not a configuration backup");
  }
  const header = validateHeader(raw);

  if (!header.encrypted) return { header, bundle: raw.payload };

  if (!password) {
    throw new EnvelopeError("password-required", "this backup is protected with a password");
  }
  const { kdf, cipher } = header;
  if (
    kdf?.name !== "PBKDF2" ||
    kdf.hash !== "SHA-256" ||
    !kdf.salt ||
    cipher?.name !== "AES-GCM" ||
    !cipher.iv
  ) {
    throw new EnvelopeError(
      "unsupported-crypto",
      "this backup uses an encryption scheme this version does not know",
    );
  }
  const iterations =
    typeof kdf.iterations === "number" && kdf.iterations > 0 ? kdf.iterations : PBKDF2_ITERATIONS;

  const key = await deriveKey(password, fromBase64(kdf.salt), iterations);
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt(
      { name: "AES-GCM", iv: fromBase64(cipher.iv) as BufferSource },
      key,
      fromBase64(String(raw.payload)) as BufferSource,
    );
  } catch {
    // GCM's tag check fails identically for a wrong key and for altered bytes.
    // Reporting one of them as certain would be a guess presented as a fact.
    throw new EnvelopeError(
      "bad-password",
      "wrong password, or this backup has been damaged",
    );
  }
  try {
    return { header, bundle: JSON.parse(new TextDecoder().decode(plain)) };
  } catch {
    throw new EnvelopeError("not-an-envelope", "this backup could not be read");
  }
}

// ─── the server's display header ─────────────────────────────────────────────

/**
 * The header as base64url, for `X-Config-Meta`.
 *
 * The payload is left out: this string is stored by the server and handed back
 * in a response header, and it exists so a listing can be drawn without
 * downloading — putting the payload in it would defeat both.
 */
export function encodeMeta(header: EnvelopeHeader): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(header)));
}

/** The inverse. Returns null for anything unreadable — it is decoration. */
export function decodeMeta(meta: string | null | undefined): EnvelopeHeader | null {
  if (!meta) return null;
  try {
    return validateHeader(JSON.parse(new TextDecoder().decode(fromBase64Url(meta))));
  } catch {
    return null;
  }
}
