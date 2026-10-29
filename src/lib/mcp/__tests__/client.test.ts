import { beforeEach, describe, expect, it, vi } from "vitest";
const fetchMock = vi.fn<typeof fetch>();
vi.mock("../../platform", () => ({ IS_TAURI: true }));
vi.mock("../../http", () => ({ fetch: (...args: Parameters<typeof fetch>) => fetchMock(...args) }));
vi.mock("../config", async (original) => ({ ...await original<typeof import("../config")>(),
  mcpHeaders: async () => ({ Authorization: "Bearer test-secret" }) }));
import { McpClient, withMcp } from "../client";
import type { McpServer } from "../config";
const server: McpServer = { id: "1", name: "images", url: "http://127.0.0.1:39287/mcp", enabled: true, revision: "a" };
const tool = { name: "draw", inputSchema: { type: "object" } };
const json = (id: number, result: unknown, headers?: HeadersInit) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }),
  { headers: { "content-type": "application/json", ...headers } });
function handshake() {
  fetchMock.mockResolvedValueOnce(json(1, { protocolVersion: "2025-11-25", capabilities: { tools: {} } }, { "mcp-session-id": "session" }))
    .mockResolvedValueOnce(new Response(null, { status: 202 }));
}
beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue(new Response(null, { status: 204 })); });
describe("Streamable HTTP MCP", () => {
  it.each(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"])(
    "uses negotiated %s for notifications, discovery, calls and session cleanup", async (version) => {
      fetchMock.mockResolvedValueOnce(json(1, { protocolVersion: version, capabilities: { tools: {} } },
        { "mcp-session-id": "session" }))
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(json(3, { tools: [tool] }))
        .mockResolvedValueOnce(json(4, { content: [{ type: "text", text: "ok" }] }));
      await withMcp(server, undefined, async (client) => {
        expect(await client.listTools()).toEqual([tool]);
        expect((await client.callTool("draw", {})).content).toEqual([{ type: "text", text: "ok" }]);
      });
      const requests = fetchMock.mock.calls.map(([, init]) => init!);
      expect(JSON.parse(String(requests[0].body)).params.protocolVersion).toBe("2025-11-25");
      expect(requests).toHaveLength(5);
      for (const request of requests.slice(1)) {
        expect(request.headers).toMatchObject({ "MCP-Protocol-Version": version, "Mcp-Session-Id": "session" });
      }
      expect(requests[4].method).toBe("DELETE");
    });
  it("discovers 2024 tools without requiring a session or a second initialize", async () => {
    fetchMock.mockResolvedValueOnce(json(1, { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } } }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(json(3, { tools: [tool] }));
    expect(await withMcp(server, undefined, (client) => client.listTools())).toEqual([tool]);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).method))
      .toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(new Headers(fetchMock.mock.calls[2][1]!.headers).has("Mcp-Session-Id")).toBe(false);
  });
  it("negotiates, propagates session headers, pages tools and terminates its session", async () => {
    handshake();
    fetchMock.mockResolvedValueOnce(json(3, { tools: [tool], nextCursor: "next" }))
      .mockResolvedValueOnce(json(4, { tools: [{ ...tool, name: "poll" }] }));
    expect(await withMcp(server, undefined, (c) => c.listTools())).toHaveLength(2);
    const requests = fetchMock.mock.calls.map(([, init]) => init!);
    expect(requests[2].headers).toMatchObject({ Authorization: "Bearer test-secret", "Mcp-Session-Id": "session", "MCP-Protocol-Version": "2025-11-25" });
    expect(JSON.parse(String(requests[3].body)).params).toEqual({ cursor: "next" });
    expect(requests[4].method).toBe("DELETE");
    expect(requests[2]).toMatchObject({ redirect: "error", maxRedirections: 0 });
    // The native plugin removes empty Origin; neither its webview origin nor
    // http.ts's Ollama origin may be sent to a local MCP server.
    expect(requests.every((request) => new Headers(request.headers).get("Origin") === "")).toBe(true);
  });
  it("returns an SSE result before the stream closes and cancels the reader", async () => {
    handshake(); const cancel = vi.fn();
    const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\ndata: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"你好"}]}}\r\n\r\n');
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); }, cancel });
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const result = await withMcp(server, undefined, (c) => c.callTool("draw", {}));
    expect(result.content).toEqual([{ type: "text", text: "你好" }]); expect(cancel).toHaveBeenCalled();
  });
  it("does not retry a possibly billed call on an expired session", async () => {
    handshake(); fetchMock.mockResolvedValueOnce(new Response("test-secret", { status: 404 }));
    await expect(withMcp(server, undefined, (c) => c.callTool("draw", {}))).rejects.toThrow("MCP HTTP 404");
    const calls = fetchMock.mock.calls.filter(([, i]) => i?.body && JSON.parse(String(i.body)).method === "tools/call");
    expect(calls).toHaveLength(1);
  });
  it("rejects repeated cursors", async () => {
    handshake(); fetchMock.mockResolvedValueOnce(json(3, { tools: [], nextCursor: "x" }))
      .mockResolvedValueOnce(json(4, { tools: [], nextCursor: "x" }));
    await expect(withMcp(server, undefined, (c) => c.listTools())).rejects.toThrow("repeated");
  });
  it("fails closed on unknown protocol versions", async () => {
    fetchMock.mockResolvedValueOnce(json(1, { protocolVersion: "future", capabilities: { tools: {} } }));
    await expect(withMcp(server, undefined, (c) => c.listTools())).rejects.toThrow("Unsupported MCP protocol");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("never sends a request when already stopped", async () => {
    const controller = new AbortController(); controller.abort();
    const client = new McpClient(server, controller.signal);
    await expect(client.connect()).rejects.toThrow(); await client.close(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("preserves tool-level errors as results", async () => {
    handshake(); fetchMock.mockResolvedValueOnce(json(3, { isError: true, content: [{ type: "text", text: "failed" }] }));
    expect((await withMcp(server, undefined, (c) => c.callTool("draw", {}))).isError).toBe(true);
  });
});
