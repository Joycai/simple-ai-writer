/**
 * keyStore.loadApiKey — Phase 5 fix: a genuine OS-keyring failure (locked
 * Secret Service, denied Keychain prompt, etc.) used to be swallowed into the
 * same `null` returned for "no key configured", so a broken keyring produced
 * a request sent with an empty key and an unexplained 401 downstream instead
 * of a message pointing at the real cause. `secret_load` rejecting should now
 * surface as a distinct `KeyringError`; "no entry" (which the Rust side
 * already resolves as `Ok(None)`, not a rejection) still resolves to `null`.
 *
 * `isTauri` is read once at module load from `"__TAURI_INTERNALS__" in
 * window`, so `window` must be stubbed *before* the dynamic import below —
 * setting it in a normal `beforeEach` after a static import would be too late.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  loadLegacyKeyFromDb: vi.fn(async () => null),
  deleteLegacyKeyFromDb: vi.fn(async () => {}),
  getGlobalDb: vi.fn(async () => ({})),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../ai/configDb", () => ({
  loadLegacyKeyFromDb: h.loadLegacyKeyFromDb,
  deleteLegacyKeyFromDb: h.deleteLegacyKeyFromDb,
}));
vi.mock("../project", () => ({ getGlobalDb: h.getGlobalDb }));

vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
const { loadApiKey, KeyringError } = await import("../keyStore");

beforeEach(() => {
  h.invoke.mockReset();
  h.loadLegacyKeyFromDb.mockClear();
});

describe("loadApiKey", () => {
  it("resolves the stored key", async () => {
    h.invoke.mockResolvedValueOnce("sk-abc");
    await expect(loadApiKey("p1")).resolves.toBe("sk-abc");
  });

  it("resolves null (not an error) when the provider has no key stored — falls through to legacy migration, which also has nothing", async () => {
    h.invoke.mockResolvedValueOnce(null); // secret_load: Ok(None)
    h.loadLegacyKeyFromDb.mockResolvedValueOnce(null);

    await expect(loadApiKey("p1")).resolves.toBeNull();
  });

  it("throws KeyringError, not a silent null, when secret_load itself fails", async () => {
    h.invoke.mockRejectedValueOnce(new Error("Secret Service not running"));
    h.invoke.mockRejectedValueOnce(new Error("Secret Service not running"));

    await expect(loadApiKey("p1")).rejects.toBeInstanceOf(KeyringError);
    await expect(loadApiKey("p1")).rejects.toThrow(/Secret Service not running/);
  });

  it("does not touch legacy migration when secret_load fails", async () => {
    h.invoke.mockRejectedValueOnce(new Error("boom"));

    await expect(loadApiKey("p1")).rejects.toThrow();
    expect(h.loadLegacyKeyFromDb).not.toHaveBeenCalled();
  });
});
