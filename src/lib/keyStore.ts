/**
 * API key storage backed by the OS credential manager
 * (Windows Credential Manager / macOS Keychain / Linux Secret Service)
 * via the Rust `secret_*` commands. Falls back to sessionStorage in the
 * browser dev environment.
 *
 * History: stronghold was removed because its Rust actor deadlocks on some
 * macOS setups; keys were then stored in plaintext SQLite as an interim
 * measure. They now live in the OS keyring, and any key still found in the
 * legacy SQLite table is migrated (and removed from the DB) on first access.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  deleteLegacyKeyFromDb,
  dropLegacyKeyTable,
  listLegacyKeyRows,
  loadLegacyKeyFromDb,
} from "./ai/configDb";
import { getGlobalDb } from "./project";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Thrown by loadApiKey when the OS keyring itself is unreachable or errors —
 * a locked/missing Secret Service on Linux, a denied Keychain prompt, etc.
 * Kept distinct from "no key stored" (which resolves to `null`, not a
 * rejection): collapsing both into `null` used to make a broken keyring look
 * exactly like an unconfigured provider, so the request went out with an
 * empty key and failed downstream as an unexplained 401 instead of a message
 * that points at the actual cause.
 */
export class KeyringError extends Error {
  constructor(cause: unknown) {
    super(`Could not read the API key from the OS keyring: ${String(cause)}`);
    this.name = "KeyringError";
  }
}

function sessionKey(providerId: string) {
  return `apikey:${providerId}`;
}

/**
 * One-shot migration for a single provider: move the key out of the legacy
 * plaintext `api_keys` table into the OS keyring, then delete the DB row.
 * Returns the migrated key, or null when there is nothing to migrate.
 */
async function migrateLegacyKey(providerId: string): Promise<string | null> {
  try {
    const db = await getGlobalDb();
    const legacy = await loadLegacyKeyFromDb(db, providerId);
    if (legacy == null) return null;
    await invoke("secret_save", { providerId, apiKey: legacy });
    await deleteLegacyKeyFromDb(db, providerId);
    return legacy;
  } catch {
    // Legacy table may not exist (fresh installs) — nothing to migrate.
    return null;
  }
}

export interface LegacyKeyMigration {
  /** Keys moved into the keyring by this run. */
  migrated: number;
  /** Keys the keyring refused; their rows are left in place for the next run. */
  failed: number;
  /** Whether the legacy table is now gone. */
  dropped: boolean;
}

/**
 * Move *every* remaining plaintext key into the OS keyring and drop the table.
 *
 * `migrateLegacyKey` below is lazy — it runs when someone asks for one
 * particular provider's key — which means a provider the author stopped using
 * (or deleted from the UI, which only removes the row for the id it still
 * lists) keeps its key in plaintext in `config.db` forever. Since the keyring
 * became the store, "eventually" was never going to arrive for those rows.
 *
 * Run once per app launch, before the config loads. Ordering per row is
 * save-then-delete, so an interruption at worst duplicates a key into the
 * keyring rather than destroying it; the table is only dropped when nothing is
 * left to lose. A keyring that rejects a write (locked Secret Service, denied
 * Keychain prompt) leaves that row for the next launch instead of failing the
 * launch — the migration is cleanup, and cleanup must not stop the app from
 * starting.
 */
export async function migrateLegacyKeys(): Promise<LegacyKeyMigration> {
  const idle: LegacyKeyMigration = { migrated: 0, failed: 0, dropped: false };
  if (!isTauri) return idle;

  let db: Awaited<ReturnType<typeof getGlobalDb>>;
  let rows: { providerId: string; apiKey: string }[];
  try {
    db = await getGlobalDb();
    rows = await listLegacyKeyRows(db);
  } catch {
    // No legacy table (a fresh install) — the normal case, and nothing to do.
    return idle;
  }

  let migrated = 0;
  let failed = 0;
  for (const { providerId, apiKey } of rows) {
    try {
      await invoke("secret_save", { providerId, apiKey });
      await deleteLegacyKeyFromDb(db, providerId);
      migrated++;
    } catch (e) {
      failed++;
      console.warn(`[keyStore] could not migrate the stored key for ${providerId}:`, e);
    }
  }

  if (failed > 0) return { migrated, failed, dropped: false };
  try {
    await dropLegacyKeyTable(db);
    return { migrated, failed, dropped: true };
  } catch (e) {
    console.warn("[keyStore] migrated every legacy key but could not drop the table:", e);
    return { migrated, failed, dropped: false };
  }
}

export async function saveApiKey(providerId: string, apiKey: string): Promise<void> {
  // Keyless providers (e.g. a local Ollama server) store no secret. Persisting an
  // empty string is rejected by some OS keyrings (macOS Keychain), so treat an
  // empty key as "remove any existing key" instead.
  if (!apiKey) {
    await deleteApiKey(providerId);
    return;
  }
  if (!isTauri) {
    sessionStorage.setItem(sessionKey(providerId), apiKey);
    return;
  }
  await invoke("secret_save", { providerId, apiKey });
  // Make sure no stale plaintext copy survives in the legacy table.
  try {
    const db = await getGlobalDb();
    await deleteLegacyKeyFromDb(db, providerId);
  } catch {}
}

/**
 * Resolves to the stored key, or `null` when the provider genuinely has none
 * configured. Throws `KeyringError` when the keyring itself couldn't be
 * reached — callers should let that surface as a real error rather than
 * treating it the same as "no key".
 */
export async function loadApiKey(providerId: string): Promise<string | null> {
  if (!isTauri) {
    return sessionStorage.getItem(sessionKey(providerId));
  }
  let key: string | null;
  try {
    key = await invoke<string | null>("secret_load", { providerId });
  } catch (e) {
    throw new KeyringError(e);
  }
  if (key != null) return key;
  return await migrateLegacyKey(providerId);
}

export async function deleteApiKey(providerId: string): Promise<void> {
  if (!isTauri) {
    sessionStorage.removeItem(sessionKey(providerId));
    return;
  }
  try {
    await invoke("secret_delete", { providerId });
  } catch {}
  try {
    const db = await getGlobalDb();
    await deleteLegacyKeyFromDb(db, providerId);
  } catch {}
}

/** What `clearAllSecrets` managed to remove. Mirrors the Rust `SecretWipe`. */
export interface SecretWipe {
  /** Secrets actually removed. */
  removed: number;
  /** Secrets the OS keyring refused to delete. "Already gone" is not one. */
  failed: number;
}

/**
 * Delete every secret this app stores — the keyring half of 重置应用配置.
 *
 * `accounts` is what the caller can *name*: one entry per provider row, the
 * knowledge-base server's token, any remembered backup password it knows of.
 * That list is the whole scope on Windows and Linux (one credential per id,
 * nothing to enumerate); macOS holds every secret in a single keychain item and
 * empties it outright, so there the list is a floor rather than the reach. The
 * asymmetry belongs to the storage shape — see `src-tauri/src/secrets.rs`.
 *
 * Errors from individual entries come back as `failed` rather than a rejection,
 * because the caller has to weigh the count: `lib/appReset` drops the config
 * rows only when nothing was refused, since those rows are the only record of
 * which accounts exist.
 */
export async function clearAllSecrets(accounts: string[]): Promise<SecretWipe> {
  if (!isTauri) {
    let removed = 0;
    for (const id of accounts) {
      const key = sessionKey(id);
      if (sessionStorage.getItem(key) != null) removed++;
      sessionStorage.removeItem(key);
    }
    return { removed, failed: 0 };
  }
  return await invoke<SecretWipe>("secret_clear_all", { providerIds: accounts });
}
