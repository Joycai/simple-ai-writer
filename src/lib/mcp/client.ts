/** Streamable HTTP, MCP 2025-03-26 / 2025-06-18 / 2025-11-25.
 * Sessions belong to one operation, never global. Calls are never retried:
 * a lost response can already have incurred a charge at the server.
 */
import { fetch } from "../http";
import { IS_TAURI } from "../platform";
import { isObject, mcpHeaders, type McpServer } from "./config";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface McpResult { content: unknown[]; structuredContent?: unknown; isError?: boolean }
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_RESPONSE = 32 * 1024 * 1024;

export class McpClient {
  private session?: string;
  private version = VERSIONS[0];
  private serial = 0;
  private headers: Record<string, string> = {};
  private controller = new AbortController();
  private timeout: ReturnType<typeof setTimeout>;
  private onAbort = () => this.controller.abort();

  constructor(private server: McpServer, private signal?: AbortSignal, timeoutMs = 120_000) {
    this.timeout = setTimeout(() => this.controller.abort(), timeoutMs);
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.controller.abort();
  }

  async connect(): Promise<void> {
    this.headers = await mcpHeaders(this.server);
    const result = await this.rpc("initialize", { protocolVersion: this.version,
      capabilities: {}, clientInfo: { name: "simple-ai-writer", version: "1" } });
    if (!isObject(result) || !VERSIONS.includes(String(result.protocolVersion))) {
      throw new Error("Unsupported MCP protocol version.");
    }
    this.version = String(result.protocolVersion);
    if (!isObject(result.capabilities) || !isObject(result.capabilities.tools)) {
      throw new Error("This MCP server does not provide tools.");
    }
    await this.rpc("notifications/initialized", undefined, true);
  }

  private requestHeaders(): Record<string, string> {
    // This is a native MCP client, not a browser origin. An explicit empty
    // Origin tells the Tauri HTTP plugin to omit its synthetic webview Origin
    // (and prevents http.ts's Ollama-specific localhost override). Local MCP
    // servers correctly reject those browser origins under DNS-rebinding guards.
    return { ...this.headers, ...(IS_TAURI ? { Origin: "" } : {}),
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.version, ...(this.session ? { "Mcp-Session-Id": this.session } : {}) };
  }

  private async rpc(method: string, params?: Record<string, unknown>, notification = false): Promise<unknown> {
    this.controller.signal.throwIfAborted();
    const id = ++this.serial;
    let response: Response;
    try {
      response = await fetch(this.server.url, { method: "POST", headers: this.requestHeaders(),
        redirect: "error", ...{ maxRedirections: 0 }, signal: this.controller.signal,
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }) });
    } catch {
      throw new Error(this.controller.signal.aborted ? "MCP request stopped or timed out. The server may still be working; check its task status before retrying." : "MCP connection failed. Check the server and its URL.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Never echo response bodies: authentication errors can repeat secrets.
      throw new Error(`MCP HTTP ${response.status}. Check the server connection and credentials. Calls are not retried automatically.`);
    }
    if (method === "initialize") this.session = response.headers.get("mcp-session-id") ?? undefined;
    if (notification) { await response.body?.cancel(); return undefined; }
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("application/json") && !type.includes("text/event-stream")) {
      await response.body?.cancel();
      throw new Error("Unsupported MCP response content type.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty MCP response.");
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;
    const accept = (raw: string): { value: unknown } | undefined => {
      let message: unknown;
      try { message = JSON.parse(raw); } catch { throw new Error("Invalid MCP JSON response."); }
      if (!isObject(message) || message.jsonrpc !== "2.0") throw new Error("Invalid MCP response.");
      if (message.method) {
        if (message.id !== undefined) throw new Error("MCP server requests (sampling/elicitation) are not supported.");
        return undefined; // notifications/progress
      }
      if (message.id !== id) return undefined;
      if (message.error) throw new Error("MCP server returned a protocol error. Check the server log.");
      if (!("result" in message)) throw new Error("MCP response has no result.");
      return { value: message.result };
    };
    try {
      while (true) {
        const chunk = await reader.read();
        bytes += chunk.value?.byteLength ?? 0;
        if (bytes > MAX_RESPONSE) throw new Error("MCP response exceeds 32 MiB.");
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (type.includes("text/event-stream")) {
          let match: RegExpExecArray | null;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const event = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
            if (data) { const found = accept(data); if (found) return found.value; }
          }
        }
        if (chunk.done) break;
      }
      if (type.includes("application/json")) { const found = accept(buffer); if (found) return found.value; }
      throw new Error("MCP stream ended before the response. Check task status before retrying.");
    } catch (error) {
      if (this.controller.signal.aborted) {
        throw new Error("MCP request stopped or timed out. The server may still be working; check task status before retrying.");
      }
      throw error;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.rpc("tools/list", cursor ? { cursor } : {});
      if (!isObject(result) || !Array.isArray(result.tools)) throw new Error("Invalid MCP tool list.");
      for (const tool of result.tools) {
        if (!isObject(tool) || typeof tool.name !== "string" || !tool.name || !isObject(tool.inputSchema)
          || tool.inputSchema.type !== "object" || (tool.description !== undefined && typeof tool.description !== "string")) {
          throw new Error("Invalid MCP tool definition.");
        }
        if (tools.some((t) => t.name === tool.name)) throw new Error("Duplicate MCP tool name.");
        tools.push({ name: tool.name, description: tool.description as string | undefined, inputSchema: tool.inputSchema });
        if (tools.length > 256) throw new Error("MCP server exposes more than 256 tools.");
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error("MCP pagination repeated a cursor.");
      if (cursor) cursors.add(cursor);
      if (cursors.size > 32) throw new Error("MCP pagination exceeds 32 pages.");
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (!isObject(result) || !Array.isArray(result.content)) throw new Error("Invalid MCP tool result.");
    return { content: result.content, structuredContent: result.structuredContent, isError: result.isError === true };
  }

  async close(): Promise<void> {
    clearTimeout(this.timeout);
    this.signal?.removeEventListener("abort", this.onAbort);
    if (this.session) {
      const cleanup = new AbortController();
      const timer = setTimeout(() => cleanup.abort(), 2000);
      try {
        const response = await fetch(this.server.url, { method: "DELETE", headers: this.requestHeaders(),
          redirect: "error", ...{ maxRedirections: 0 }, signal: cleanup.signal });
        await response.body?.cancel();
      } catch { /* best effort; no retry of the original operation */ }
      finally { clearTimeout(timer); }
    }
    this.controller.abort();
    this.headers = {};
  }
}

export async function withMcp<T>(server: McpServer, signal: AbortSignal | undefined,
  run: (client: McpClient) => Promise<T>, timeoutMs?: number): Promise<T> {
  const client = new McpClient(server, signal, timeoutMs);
  try { await client.connect(); return await run(client); }
  finally { await client.close(); }
}
