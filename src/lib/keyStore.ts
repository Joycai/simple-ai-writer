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
import { loadLegacyKeyFromDb, deleteLegacyKeyFromDb } from "./ai/configDb";
import { getGlobalDb } from "./project";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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

export async function saveApiKey(providerId: string, apiKey: string): Promise<void> {
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

export async function loadApiKey(providerId: string): Promise<string | null> {
  if (!isTauri) {
    return sessionStorage.getItem(sessionKey(providerId));
  }
  try {
    const key = await invoke<string | null>("secret_load", { providerId });
    if (key != null) return key;
    return await migrateLegacyKey(providerId);
  } catch {
    return null;
  }
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
