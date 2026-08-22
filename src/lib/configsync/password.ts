/**
 * Remembering a backup's password — on this machine only.
 *
 * The password protecting a config backup is the one secret in this feature the
 * server must never hold, so "remember it" can only ever mean the OS credential
 * manager, through the same `secret_*` commands the provider keys use. Typing it
 * again on a new machine is not a gap to close; it is the feature working.
 *
 * Keyed by server **and** slot: one author can keep a work backup and a personal
 * one on the same box under different passwords, and a single global entry would
 * silently answer with the wrong one — which surfaces as "wrong password" on a
 * backup whose password they typed correctly.
 */

import { deleteApiKey, loadApiKey, saveApiKey } from "../keyStore";
import { normalizeServerUrl } from "../sync/config";

function account(serverUrl: string, slotId: string): string {
  return `cfgpwd:${normalizeServerUrl(serverUrl)}:${slotId}`;
}

/** Never throws: a locked keyring means "not remembered", and the author types it. */
export async function loadSlotPassword(serverUrl: string, slotId: string): Promise<string | null> {
  try {
    return await loadApiKey(account(serverUrl, slotId));
  } catch {
    return null;
  }
}

export async function rememberSlotPassword(
  serverUrl: string,
  slotId: string,
  password: string,
): Promise<void> {
  await saveApiKey(account(serverUrl, slotId), password);
}

/** Best-effort: forgetting a password that was never stored is the same outcome. */
export async function forgetSlotPassword(serverUrl: string, slotId: string): Promise<void> {
  try {
    await deleteApiKey(account(serverUrl, slotId));
  } catch {
    /* already gone */
  }
}
