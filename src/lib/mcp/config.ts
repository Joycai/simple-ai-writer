/** Machine-local MCP endpoints. Header values live only in the OS keyring. */
import { clearAllSecrets, loadApiKey, saveApiKey } from "../keyStore";
import { readPref, writePref, writePrefConfirmed } from "../prefs";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  revision: string;
}
interface McpImport { name: string; url: string; headers: Record<string, string> }
const KEY = "app:mcpServers";
export const mcpSecretAccount = (id: string): string => `mcp:${id}`;
export const isMcpEnabled = (): boolean => readPref("app:mcpBeta") === "1";
export const setMcpEnabled = (on: boolean): void => writePref("app:mcpBeta", on ? "1" : "0");
export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function endpoint(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("MCP requires a URL.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Invalid MCP URL."); }
  if (url.username || url.password || url.hash || url.search) throw new Error("Put credentials in headers, not in the MCP URL.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Use HTTPS, or HTTP on localhost.");
  }
  return url.href;
}

function parseHeaders(value: unknown): Record<string, string> {
  if (!isObject(value)) throw new Error("MCP headers must be an object.");
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(key) || typeof val !== "string" || /[\r\n]/.test(val)) {
      throw new Error("Invalid MCP header.");
    }
    if (/^(accept|content-type|host|origin|content-length|connection|mcp-.*|mcp-method|mcp-name)$/i.test(key)) {
      throw new Error("MCP protocol headers cannot be overridden.");
    }
    result[key] = val;
  }
  return result;
}

export function parseMcpImport(raw: string): McpImport[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid MCP JSON."); }
  if (!isObject(value) || !isObject(value.mcpServers)) throw new Error("Expected an mcpServers object.");
  const entries = Object.entries(value.mcpServers);
  if (!entries.length || entries.length > 32) throw new Error("Import between 1 and 32 MCP servers.");
  return entries.map(([name, server]) => {
    if (!name.trim() || name.length > 100 || !isObject(server) || server.command || server.args || server.env
      || (server.type !== undefined && !["http", "streamable-http"].includes(String(server.type)))) {
      throw new Error("Only named Streamable HTTP MCP servers are supported.");
    }
    return { name, url: endpoint(server.url), headers: parseHeaders(server.headers ?? {}) };
  });
}

export function readMcpServers(): McpServer[] {
  try {
    const value: unknown = JSON.parse(readPref(KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((s): s is McpServer => isObject(s) && typeof s.id === "string"
      && /^[a-zA-Z0-9-]+$/.test(s.id) && typeof s.name === "string" && typeof s.revision === "string"
      && typeof s.url === "string" && typeof s.enabled === "boolean")
      .filter((s) => { try { return endpoint(s.url) === s.url; } catch { return false; } });
  } catch { return []; }
}

async function persist(servers: McpServer[]): Promise<void> {
  await writePrefConfirmed(KEY, JSON.stringify(servers));
}

export async function importMcpServers(raw: string): Promise<void> {
  const entries = parseMcpImport(raw);
  for (const entry of entries) {
    const list = readMcpServers();
    const old = list.find((s) => s.name === entry.name);
    const server: McpServer = { id: old?.id ?? crypto.randomUUID(), name: entry.name, url: entry.url,
      enabled: false, revision: crypto.randomUUID() };
    const next = [...list.filter((s) => s.id !== server.id), server];
    // Register the account before saving its secret. A failed save leaves a
    // disabled, removable row; it never leaves an unnameable keyring account.
    await persist(next);
    await saveApiKey(mcpSecretAccount(server.id), JSON.stringify(entry.headers));
    await persist(next.map((s) => s.id === server.id ? { ...s, enabled: true } : s));
  }
}

export async function toggleMcpServer(id: string, enabled: boolean): Promise<void> {
  await persist(readMcpServers().map((s) => s.id === id ? { ...s, enabled, revision: crypto.randomUUID() } : s));
}
export async function removeMcpServer(id: string): Promise<void> {
  await toggleMcpServer(id, false);
  const wipe = await clearAllSecrets([mcpSecretAccount(id)]);
  if (wipe.failed) throw new Error("Could not remove MCP credentials from the keyring.");
  await persist(readMcpServers().filter((s) => s.id !== id));
}
export async function mcpHeaders(server: McpServer): Promise<Record<string, string>> {
  const secret = await loadApiKey(mcpSecretAccount(server.id));
  if (secret === null) throw new Error("MCP credentials are missing. Import the server configuration again.");
  return parseHeaders(JSON.parse(secret));
}

export function enabledMcpServer(name: string): McpServer {
  const server = readMcpServers().find((s) => s.name === name && s.enabled);
  if (!isMcpEnabled() || !server) throw new Error("MCP server is disabled or missing. Check Settings → AI → Labs.");
  return server;
}
