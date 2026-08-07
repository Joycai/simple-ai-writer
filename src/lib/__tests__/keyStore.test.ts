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
  listLegacyKeyRows: vi.fn(async () => [] as { providerId: string; apiKey: string }[]),
  dropLegacyKeyTable: vi.fn(async () => {}),
  getGlobalDb: vi.fn(async () => ({})),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../ai/configDb", () => ({
  loadLegacyKeyFromDb: h.loadLegacyKeyFromDb,
  deleteLegacyKeyFromDb: h.deleteLegacyKeyFromDb,
  listLegacyKeyRows: h.listLegacyKeyRows,
  dropLegacyKeyTable: h.dropLegacyKeyTable,
}));
vi.mock("../project", () => ({ getGlobalDb: h.getGlobalDb }));

vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
const { loadApiKey, migrateLegacyKeys, KeyringError } = await import("../keyStore");

beforeEach(() => {
  h.invoke.mockReset();
  h.loadLegacyKeyFromDb.mockClear();
  h.listLegacyKeyRows.mockClear().mockResolvedValue([]);
  h.dropLegacyKeyTable.mockClear().mockResolvedValue(undefined);
  h.deleteLegacyKeyFromDb.mockClear();
  h.getGlobalDb.mockClear().mockResolvedValue({});
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

/**
 * The lazy per-provider migration above only ever ran for a provider something
 * asked about, so a key belonging to a provider the author stopped using — or
 * deleted from the UI — stayed in plaintext in config.db indefinitely. This is
 * the sweep that finishes the job.
 */
describe("migrateLegacyKeys", () => {
  it("moves every row into the keyring and then drops the table", async () => {
    h.listLegacyKeyRows.mockResolvedValueOnce([
      { providerId: "p1", apiKey: "sk-one" },
      { providerId: "p2", apiKey: "sk-two" },
    ]);
    h.invoke.mockResolvedValue(undefined);

    await expect(migrateLegacyKeys()).resolves.toEqual({ migrated: 2, failed: 0, dropped: true });

    expect(h.invoke).toHaveBeenCalledWith("secret_save", { providerId: "p1", apiKey: "sk-one" });
    expect(h.invoke).toHaveBeenCalledWith("secret_save", { providerId: "p2", apiKey: "sk-two" });
    expect(h.deleteLegacyKeyFromDb).toHaveBeenCalledTimes(2);
    expect(h.dropLegacyKeyTable).toHaveBeenCalledTimes(1);
  });

  it("saves before deleting, so an interruption can never lose a key", async () => {
    const order: string[] = [];
    h.listLegacyKeyRows.mockResolvedValueOnce([{ providerId: "p1", apiKey: "sk-one" }]);
    h.invoke.mockImplementation(async () => { order.push("save"); });
    h.deleteLegacyKeyFromDb.mockImplementation(async () => { order.push("delete"); });

    await migrateLegacyKeys();

    expect(order).toEqual(["save", "delete"]);
    h.deleteLegacyKeyFromDb.mockImplementation(async () => {});
  });

  it("keeps the row — and the table — when the keyring refuses a write", async () => {
    h.listLegacyKeyRows.mockResolvedValueOnce([
      { providerId: "p1", apiKey: "sk-one" },
      { providerId: "p2", apiKey: "sk-two" },
    ]);
    h.invoke.mockRejectedValueOnce(new Error("Secret Service locked"));
    h.invoke.mockResolvedValueOnce(undefined);

    await expect(migrateLegacyKeys()).resolves.toEqual({ migrated: 1, failed: 1, dropped: false });

    // Only the successful one is gone from the DB; the table survives so the
    // next launch can retry the other.
    expect(h.deleteLegacyKeyFromDb).toHaveBeenCalledTimes(1);
    expect(h.deleteLegacyKeyFromDb).toHaveBeenCalledWith(expect.anything(), "p2");
    expect(h.dropLegacyKeyTable).not.toHaveBeenCalled();
  });

  it("is a no-op on a fresh install, where the legacy table does not exist", async () => {
    h.listLegacyKeyRows.mockRejectedValueOnce(new Error("no such table: api_keys"));

    await expect(migrateLegacyKeys()).resolves.toEqual({ migrated: 0, failed: 0, dropped: false });
    expect(h.dropLegacyKeyTable).not.toHaveBeenCalled();
  });

  it("still drops an already-empty table, so the plaintext schema stops existing", async () => {
    await expect(migrateLegacyKeys()).resolves.toEqual({ migrated: 0, failed: 0, dropped: true });
    expect(h.dropLegacyKeyTable).toHaveBeenCalledTimes(1);
  });

  it("reports a failed drop instead of throwing into the config load", async () => {
    h.dropLegacyKeyTable.mockRejectedValueOnce(new Error("database is locked"));

    await expect(migrateLegacyKeys()).resolves.toEqual({ migrated: 0, failed: 0, dropped: false });
  });
});
