import { describe, it, expect } from "vitest";

import {
  EnvelopeError,
  ENVELOPE_KIND,
  PBKDF2_ITERATIONS,
  bundleHasKeys,
  decodeMeta,
  encodeMeta,
  openEnvelope,
  readEnvelopeHeader,
  sealBundle,
  type EnvelopeHeader,
} from "../configsync/envelope";
import type { ConfigBackup } from "../ai/configTransfer";

/**
 * The envelope is the only place in this app where losing a secret is silent:
 * a backup sealed wrong does not fail, it just sits on a server readable by
 * anyone with a token. So these tests are mostly about refusals.
 */

const bundle = (withKeys: boolean): ConfigBackup => ({
  kind: "ai-writer-config-backup",
  version: 1,
  exportedAt: "2026-08-23T00:00:00.000Z",
  appVersion: "1.23.1",
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiStandard: "openai",
      createdAt: 1,
      ...(withKeys ? { apiKey: "sk-super-secret-value" } : {}),
    },
    {
      id: "local",
      name: "LM Studio",
      baseUrl: "http://192.168.2.206:11234/v1",
      apiStandard: "openai_compat",
      createdAt: 2,
    },
  ],
  models: [
    {
      id: "m1",
      providerId: "openai",
      modelId: "gpt-5",
      name: "GPT-5",
      type: "text",
      priceIn: 1,
      priceCachedIn: 0,
      priceOut: 2,
      enabled: true,
    },
  ],
  prompts: [{ id: "p1", name: "续写", content: "写下去", scene: "continue" }],
  prefs: [["app:theme", "dark"]],
});

const seal = (b: ConfigBackup, password: string | null) =>
  sealBundle(b, { device: "REINE-DESKTOP", appVersion: "1.23.1", password });

const code = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    return e instanceof EnvelopeError ? e.code : `not-an-envelope-error:${e}`;
  }
  return "no-error";
};

describe("config envelope", () => {
  it("round-trips an encrypted bundle", async () => {
    const original = bundle(true);
    const sealed = await seal(original, "correct horse battery staple");

    // The bytes on the wire must not contain the secret in any readable form —
    // this is the whole point, and it is cheap to assert.
    const wire = new TextDecoder().decode(sealed.bytes);
    expect(wire).not.toContain("sk-super-secret-value");

    const opened = await openEnvelope(sealed.bytes, "correct horse battery staple");
    expect(opened.bundle).toEqual(original);
    expect(opened.header.encrypted).toBe(true);
    expect(opened.header.hasKeys).toBe(true);
  });

  it("round-trips an unencrypted bundle, readable as plain JSON", async () => {
    const original = bundle(false);
    const sealed = await seal(original, null);

    // No password means no ciphertext: an unencrypted backup stays as readable
    // in any JSON tool as the file export it mirrors.
    const parsed = JSON.parse(new TextDecoder().decode(sealed.bytes));
    expect(parsed.encrypted).toBe(false);
    expect(parsed.payload).toEqual(original);

    const opened = await openEnvelope(sealed.bytes);
    expect(opened.bundle).toEqual(original);
  });

  it("refuses to seal API keys without a password", async () => {
    // The invariant this module exists for. Not a warning — a refusal.
    expect(await code(() => seal(bundle(true), null))).toBe("keys-need-password");
    expect(await code(() => seal(bundle(true), ""))).toBe("keys-need-password");
    // Without keys the same call is fine.
    expect(await code(() => seal(bundle(false), null))).toBe("no-error");
  });

  it("reports a wrong password and a tampered payload identically", async () => {
    const sealed = await seal(bundle(true), "right");
    expect(await code(() => openEnvelope(sealed.bytes, "wrong"))).toBe("bad-password");

    // Flip one byte of the ciphertext. GCM's tag check cannot tell this apart
    // from a wrong key, and claiming otherwise would be a guess dressed as a fact.
    const doc = JSON.parse(new TextDecoder().decode(sealed.bytes));
    const payload = doc.payload as string;
    const at = Math.floor(payload.length / 2);
    doc.payload = payload.slice(0, at) + (payload[at] === "A" ? "B" : "A") + payload.slice(at + 1);
    const tampered = new TextEncoder().encode(JSON.stringify(doc));
    expect(await code(() => openEnvelope(tampered, "right"))).toBe("bad-password");
  });

  it("asks for the password rather than failing obscurely", async () => {
    const sealed = await seal(bundle(true), "pw");
    expect(await code(() => openEnvelope(sealed.bytes))).toBe("password-required");
    expect(await code(() => openEnvelope(sealed.bytes, ""))).toBe("password-required");
  });

  it("rejects things that are not envelopes", async () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(await code(() => openEnvelope(bytes("not json at all")))).toBe("not-an-envelope");
    expect(await code(() => openEnvelope(bytes('{"kind":"something-else"}')))).toBe(
      "not-an-envelope",
    );
    // A bundle exported to a file is *not* an envelope: it has no header, and
    // treating it as one would report "wrong password" for a readable file.
    expect(await code(() => openEnvelope(bytes(JSON.stringify(bundle(false)))))).toBe(
      "not-an-envelope",
    );
  });

  it("refuses a backup from a newer build instead of guessing", async () => {
    const sealed = await seal(bundle(false), null);
    const doc = JSON.parse(new TextDecoder().decode(sealed.bytes));
    doc.version = 99;
    const future = new TextEncoder().encode(JSON.stringify(doc));
    expect(await code(() => openEnvelope(future))).toBe("unsupported-version");
    expect(await code(async () => readEnvelopeHeader(future))).toBe("unsupported-version");
  });

  it("opens an envelope sealed with a different iteration count", async () => {
    // The KDF parameters travel in the envelope precisely so that raising
    // PBKDF2_ITERATIONS later does not strand every backup written before it.
    const sealed = await seal(bundle(true), "pw");
    const doc = JSON.parse(new TextDecoder().decode(sealed.bytes));
    expect(doc.kdf.iterations).toBe(PBKDF2_ITERATIONS);

    // Re-seal at a low count by hand and confirm the reader follows the file.
    const salt = new Uint8Array(16).fill(7);
    const iv = new Uint8Array(12).fill(9);
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("pw"),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, hash: "SHA-256", iterations: 1000 },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const cipherText = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(JSON.stringify(bundle(true))),
      ),
    );
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
    doc.kdf = { name: "PBKDF2", hash: "SHA-256", iterations: 1000, salt: b64(salt) };
    doc.cipher = { name: "AES-GCM", iv: b64(iv) };
    doc.payload = b64(cipherText);

    const opened = await openEnvelope(new TextEncoder().encode(JSON.stringify(doc)), "pw");
    expect(opened.bundle).toEqual(bundle(true));
  });

  it("refuses a scheme it does not implement rather than trying anyway", async () => {
    const sealed = await seal(bundle(true), "pw");
    const doc = JSON.parse(new TextDecoder().decode(sealed.bytes));
    doc.kdf = { ...doc.kdf, name: "scrypt" };
    expect(
      await code(() => openEnvelope(new TextEncoder().encode(JSON.stringify(doc)), "pw")),
    ).toBe("unsupported-crypto");
  });

  it("every seal is different, even for the same bundle and password", async () => {
    // Salt and IV are regenerated per push. Reusing an AES-GCM IV under one key
    // is the failure that turns two ciphertexts into a readable difference.
    const a = await seal(bundle(true), "pw");
    const b = await seal(bundle(true), "pw");
    const doc = (s: Uint8Array) => JSON.parse(new TextDecoder().decode(s));
    expect(doc(a.bytes).kdf.salt).not.toBe(doc(b.bytes).kdf.salt);
    expect(doc(a.bytes).cipher.iv).not.toBe(doc(b.bytes).cipher.iv);
    expect(doc(a.bytes).payload).not.toBe(doc(b.bytes).payload);
  });

  it("survives a bundle big enough to break a spread-based base64", async () => {
    // `String.fromCharCode(...bytes)` blows the argument limit well before this.
    const big = bundle(true);
    big.prompts = Array.from({ length: 400 }, (_, i) => ({
      id: `p${i}`,
      name: `模板 ${i}`,
      content: "长".repeat(500),
      scene: "custom",
    }));
    const sealed = await seal(big, "pw");
    expect(sealed.bytes.byteLength).toBeGreaterThan(200_000);
    const opened = await openEnvelope(sealed.bytes, "pw");
    expect(opened.bundle).toEqual(big);
  });
});

describe("the header the server stores", () => {
  it("carries the display facts and none of the payload", async () => {
    const sealed = await seal(bundle(true), "pw");
    const decoded = decodeMeta(sealed.meta);
    expect(decoded).toMatchObject({
      kind: ENVELOPE_KIND,
      device: "REINE-DESKTOP",
      appVersion: "1.23.1",
      encrypted: true,
      hasKeys: true,
      counts: { providers: 2, models: 1, prompts: 1, prefs: 1 },
    });
    // Not the payload, and not anything derived from the password.
    expect(sealed.meta).not.toContain("payload");
    expect(JSON.stringify(decoded)).not.toContain("sk-super-secret-value");
  });

  it("is base64url, because it travels in an HTTP header", async () => {
    // The server validates exactly this alphabet and refuses anything else.
    const sealed = await sealBundle(bundle(false), {
      device: "阳台的 iPad",
      appVersion: "1.23.1",
      password: null,
    });
    expect(sealed.meta).toMatch(/^[A-Za-z0-9_=-]+$/);
    expect(decodeMeta(sealed.meta)?.device).toBe("阳台的 iPad");
  });

  it("treats an unreadable header as no header at all", () => {
    // It is decoration on a list row. A machine that uploaded nonsense must
    // cost one missing label, not a page that will not render.
    expect(decodeMeta(null)).toBeNull();
    expect(decodeMeta("")).toBeNull();
    expect(decodeMeta("not-base64-@@@")).toBeNull();
    expect(decodeMeta(btoa("{}").replace(/\+/g, "-").replace(/\//g, "_"))).toBeNull();
  });

  it("round-trips through encodeMeta", () => {
    const header: EnvelopeHeader = {
      kind: ENVELOPE_KIND,
      version: 1,
      createdAt: "2026-08-23T00:00:00.000Z",
      appVersion: "1.23.1",
      device: "书房台式机",
      encrypted: false,
      hasKeys: false,
      counts: { providers: 3, models: 9, prompts: 2, prefs: 30 },
    };
    expect(decodeMeta(encodeMeta(header))).toMatchObject(header);
  });
});

describe("bundleHasKeys", () => {
  it("is what decides whether a password is mandatory", () => {
    expect(bundleHasKeys(bundle(true))).toBe(true);
    expect(bundleHasKeys(bundle(false))).toBe(false);
    // An empty string is not a key — it would otherwise force a password for a
    // backup that carries no secret at all.
    const empty = bundle(false);
    empty.providers[0].apiKey = "";
    expect(bundleHasKeys(empty)).toBe(false);
  });
});
