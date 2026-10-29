/** Machine-local MCP endpoints. Header values live only in the OS keyring. */
import { clearAllSecrets, loadApiKey, saveApiKey } from "../keyStore";
import { McpError } from "./errors";
import { readPref, writePref, writePrefConfirmed } from "../prefs";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  revision: string;
  connectionRevision?: string;
  headerNames?: string[];
}
export interface McpImport { name: string; url: string; headers: Record<string, string> }
const KEY = "app:mcpServers";
export const mcpSecretAccount = (id: string): string => `mcp:${id}`;
export const isMcpEnabled = (): boolean => readPref("app:mcpBeta") === "1";
export const setMcpEnabled = (on: boolean): void => { writePref("app:mcpBeta", on ? "1" : "0"); listeners.forEach(fn => fn()); };
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
    if (Object.keys(result).some(name => name.toLowerCase() === key.toLowerCase())) throw new McpError("headers");
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

const listeners = new Set<() => void>();
export const subscribeMcpConfig = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const connectionRevision = (s: McpServer): string => s.connectionRevision ?? s.revision;
async function persist(servers: McpServer[]): Promise<void> {
  await writePrefConfirmed(KEY, JSON.stringify(servers));
  listeners.forEach(fn => fn());
}
// Serialize local mutations, including credential read/patch/write.
let mutations: Promise<unknown> = Promise.resolve();
function mutate<T>(run: () => Promise<T>): Promise<T> {
  const next = mutations.then(run, run); mutations = next.catch(() => {}); return next;
}
interface McpServerDraft {
  id?: string; revision?: string; name: string; url: string; enabled: boolean;
  /** Undefined keeps all headers; null values explicitly remove individual headers. */
  headers?: Record<string, string | null>;
  replaceHeaders?: boolean;
}
export function saveMcpServer(draft: McpServerDraft): Promise<McpServer> {
  return mutate(async () => {
    const list = readMcpServers();
    const old = draft.id ? list.find(s => s.id === draft.id) : undefined;
    if (draft.id && (!old || (draft.revision && old.revision !== draft.revision))) throw new McpError("changed");
    const name = draft.name.trim();
    if (!name || name.length > 100) throw new McpError("name");
    if (list.some(s => s.id !== old?.id && s.name.toLowerCase() === name.toLowerCase())) throw new McpError("duplicate");
    if (!old && list.length >= 32) throw new McpError("limit");
    let url: string;
    try { url = endpoint(draft.url.trim()); } catch { throw new McpError("url"); }
    let headers: Record<string, string> | undefined;
    if (!old || draft.headers !== undefined) {
      try {
        headers = old && !draft.replaceHeaders ? await mcpHeaders(old) : {};
        for (const [key, value] of Object.entries(draft.headers ?? {})) {
          for (const existing of Object.keys(headers)) if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
          if (value !== null) headers[key] = value;
        }
        headers = parseHeaders(headers);
      } catch { throw new McpError("headers"); }
    }
    const changed = !old || old.url !== url || headers !== undefined;
    const server: McpServer = { id: old?.id ?? crypto.randomUUID(), name, url, enabled: draft.enabled,
      revision: crypto.randomUUID(), connectionRevision: changed ? crypto.randomUUID() : connectionRevision(old),
      headerNames: headers ? Object.keys(headers) : old?.headerNames };
    const replace = (value: McpServer) => old ? list.map(s => s.id === old.id ? value : s) : [...list, value];
    if (headers) {
      await persist(replace({ ...server, enabled: false }));
      try { await saveApiKey(mcpSecretAccount(server.id), JSON.stringify(headers)); }
      catch { throw new McpError("credentials"); }
    }
    await persist(replace(server));
    return server;
  });
}
export async function importMcpServers(raw: string): Promise<void> {
  for (const entry of parseMcpImport(raw)) {
    const old = readMcpServers().find(s => s.name === entry.name);
    await saveMcpServer({ ...entry, id: old?.id, revision: old?.revision, enabled: true, replaceHeaders: true });
  }
}
export function toggleMcpServer(id: string, enabled: boolean): Promise<void> {
  return mutate(() => persist(readMcpServers().map(s => s.id === id
    ? { ...s, enabled, connectionRevision: connectionRevision(s), revision: crypto.randomUUID() } : s)));
}
export function removeMcpServer(id: string): Promise<void> {
  return mutate(async () => {
    await persist(readMcpServers().map(s => s.id === id ? { ...s, enabled: false,
      connectionRevision: connectionRevision(s), revision: crypto.randomUUID() } : s));
    const wipe = await clearAllSecrets([mcpSecretAccount(id)]);
    if (wipe.failed) throw new McpError("credentials");
    await persist(readMcpServers().filter(s => s.id !== id));
    await (await import("./catalogueDb")).deleteCatalogueRow(id);
  });
}
/** Read header names only for legacy configurations; never return their values to a form. */
export async function mcpHeaderNames(server: McpServer): Promise<string[]> {
  return Object.keys(await mcpHeaders(server));
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
