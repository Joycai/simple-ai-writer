/**
 * API key storage backed by the global config SQLite DB (appDataDir/config.db).
 * Falls back to sessionStorage in the browser dev environment.
 *
 * Stronghold was removed because its Rust actor deadlocks on some macOS setups,
 * causing every save/delete that touched the vault to hang indefinitely.
 * The keys never leave the local machine — the app-data directory is already
 * OS-protected — so SQLite storage is an acceptable trade-off here.
 */

import { saveKeyToDb, loadKeyFromDb, deleteKeyFromDb, ensureAiSchema } from "./aiConfig";
import { getGlobalDb } from "./project";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function sessionKey(providerId: string) {
  return `apikey:${providerId}`;
}

async function keyDb() {
  const d = await getGlobalDb();
  await ensureAiSchema(d);
  return d;
}

export async function saveApiKey(providerId: string, apiKey: string): Promise<void> {
  if (!isTauri) {
    sessionStorage.setItem(sessionKey(providerId), apiKey);
    return;
  }
  const d = await keyDb();
  await saveKeyToDb(d, providerId, apiKey);
}

export async function loadApiKey(providerId: string): Promise<string | null> {
  if (!isTauri) {
    return sessionStorage.getItem(sessionKey(providerId));
  }
  try {
    const d = await keyDb();
    return await loadKeyFromDb(d, providerId);
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
    const d = await keyDb();
    await deleteKeyFromDb(d, providerId);
  } catch {}
}
