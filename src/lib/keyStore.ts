/**
 * Thin wrapper around tauri-plugin-stronghold for API key storage.
 * Keys are stored under the vault path `{projectPath}/.ai-writer/keys.hold`
 * and accessed with the record path `provider:{providerId}`.
 *
 * Falls back to in-memory sessionStorage for the browser preview/dev environment
 * where Tauri IPC is not available.
 */

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function sessionKey(providerId: string) {
  return `apikey:${providerId}`;
}

export async function saveApiKey(
  _projectPath: string,
  providerId: string,
  apiKey: string
): Promise<void> {
  if (!isTauri) {
    sessionStorage.setItem(sessionKey(providerId), apiKey);
    return;
  }
  const { Stronghold } = await import("@tauri-apps/plugin-stronghold");
  const { appDataDir } = await import("@tauri-apps/api/path");
  const vaultPath = `${await appDataDir()}/keys.hold`;
  const stronghold = await Stronghold.load(vaultPath, "simple-ai-writer-vault");
  const client = await stronghold.createClient("api-keys");
  const store = client.getStore();
  const encoded = Array.from(new TextEncoder().encode(apiKey));
  await store.insert(`provider:${providerId}`, encoded);
  await stronghold.save();
}

export async function loadApiKey(
  _projectPath: string,
  providerId: string
): Promise<string | null> {
  if (!isTauri) {
    return sessionStorage.getItem(sessionKey(providerId));
  }
  try {
    const { Stronghold } = await import("@tauri-apps/plugin-stronghold");
    const { appDataDir } = await import("@tauri-apps/api/path");
    const vaultPath = `${await appDataDir()}/keys.hold`;
    const stronghold = await Stronghold.load(vaultPath, "simple-ai-writer-vault");
    const client = await stronghold.createClient("api-keys");
    const store = client.getStore();
    const bytes = await store.get(`provider:${providerId}`);
    if (!bytes) return null;
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

export async function deleteApiKey(
  _projectPath: string,
  providerId: string
): Promise<void> {
  if (!isTauri) {
    sessionStorage.removeItem(sessionKey(providerId));
    return;
  }
  try {
    const { Stronghold } = await import("@tauri-apps/plugin-stronghold");
    const { appDataDir } = await import("@tauri-apps/api/path");
    const vaultPath = `${await appDataDir()}/keys.hold`;
    const stronghold = await Stronghold.load(vaultPath, "simple-ai-writer-vault");
    const client = await stronghold.createClient("api-keys");
    const store = client.getStore();
    await store.remove(`provider:${providerId}`);
    await stronghold.save();
  } catch {}
}
