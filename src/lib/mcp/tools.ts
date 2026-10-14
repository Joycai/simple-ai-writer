import type { ToolContext, McpProposal } from "../agent/toolTypes";
import type { ToolCall, ToolResult } from "../agent/tools";
import { enabledMcpServer, isMcpEnabled, isObject, readMcpServers } from "./config";
import { withMcp, type McpTool } from "./client";
import { saveMcpResult } from "./results";

// One catalogue per run/endpoint. Approval always rechecks against the server.
const catalogues = new WeakMap<AbortSignal, Map<string, Promise<McpTool[]>>>();
async function catalogue(server: ReturnType<typeof enabledMcpServer>, ctx: ToolContext): Promise<McpTool[]> {
  const load = () => withMcp(server, ctx.signal, (client) => client.listTools(), 30_000);
  if (!ctx.signal) return load();
  ctx.signal.throwIfAborted();
  let cache = catalogues.get(ctx.signal);
  if (!cache) { cache = new Map(); catalogues.set(ctx.signal, cache); }
  const key = JSON.stringify([server.id, server.url, server.revision]);
  let pending = cache.get(key);
  if (!pending) {
    pending = load();
    cache.set(key, pending);
    void pending.catch(() => cache.delete(key));
  }
  return pending;
}

export async function discoverMcpTools(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!isMcpEnabled()) throw new Error("MCP is disabled.");
  const args: unknown = JSON.parse(call.arguments || "{}");
  if (!isObject(args)) throw new Error("Expected an object.");
  const servers = readMcpServers().filter((s) => s.enabled);
  if (args.server === undefined && servers.length !== 1) return { toolCallId: call.id,
    content: JSON.stringify(servers.map((s) => ({ server: s.name }))) };
  const name = args.server ?? servers[0]?.name;
  if (typeof name !== "string") throw new Error("server must be a name from discover_mcp_tools.");
  const server = enabledMcpServer(name);
  const tools = await catalogue(server, ctx);
  const selected = args.tool === undefined ? tools : tools.filter((t) => t.name === args.tool);
  if (args.tool !== undefined && !selected.length) throw new Error("Unknown MCP tool. Choose a name from the server catalogue.");
  let content = JSON.stringify({ server: server.name, tools: selected });
  // Small services are immediately callable. Large catalogues retain the
  // bounded name index and selective schema lookup instead of filling history.
  if (args.tool === undefined && content.length > 12_000) {
    content = JSON.stringify({ server: server.name,
      tools: tools.map((t) => ({ name: t.name, description: t.description?.slice(0, 300) })),
      next: "Request a tool by name for its input schema, then use call_mcp_tool." });
  }
  if (content.length > 48_000) throw new Error("MCP catalogue/schema is too large. Request one tool by name.");
  return { toolCallId: call.id, content };
}

export async function callMcpTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.requestApproval || !ctx.projectPath) throw new Error("MCP calls require a project and an approval surface.");
  const args: unknown = JSON.parse(call.arguments || "{}");
  if (!isObject(args) || typeof args.server !== "string" || typeof args.tool !== "string"
    || !isObject(args.arguments) || typeof args.reason !== "string" || !args.reason.trim()) {
    throw new Error("Provide server, tool, an arguments object, and a reason.");
  }
  if (JSON.stringify(args.arguments).length > 64_000) throw new Error("MCP arguments exceed 64,000 characters.");
  const server = enabledMcpServer(args.server);
  const tools = await catalogue(server, ctx);
  const tool = tools.find((t) => t.name === args.tool);
  if (!tool) throw new Error("Unknown MCP tool. Discover the server's tools again.");
  const proposal: McpProposal = { kind: "mcp", id: `mcp-${crypto.randomUUID()}`, path: ctx.projectPath,
    serverId: server.id, serverName: server.name, serverUrl: server.url, revision: server.revision,
    tool: tool.name, toolSchema: JSON.stringify(tool),
    serverTools: Object.fromEntries(tools.map((t) => [t.name, JSON.stringify(t)])), arguments: args.arguments, reason: args.reason };
  const decision = await ctx.requestApproval(proposal, ctx.onProgress);
  return { toolCallId: call.id, content: decision.approved
    ? decision.backupPath ?? "MCP call completed without a captured result. Check the server before retrying."
    : `Error: MCP call rejected or failed: ${decision.reason ?? "declined by the author"}. Do not retry without the author's direction.` };
}

/** Called only by the approval apply step; approval covers this exact endpoint,
 * revision, tool schema and argument object. A dedicated session grant can
 * approve it; a remote readOnlyHint never grants permission.
 */
export async function applyMcpCall(proposal: McpProposal, signal?: AbortSignal): Promise<{ report: string; imagePath?: string }> {
  const check = () => {
    const server = enabledMcpServer(proposal.serverName);
    if (server.id !== proposal.serverId || server.url !== proposal.serverUrl || server.revision !== proposal.revision) {
      throw new Error("MCP configuration changed while approval was pending. Submit a new proposal.");
    }
    signal?.throwIfAborted();
    return server;
  };
  const result = await withMcp(check(), signal, async (client) => {
    const tool = (await client.listTools()).find((t) => t.name === proposal.tool);
    if (!tool || JSON.stringify(tool) !== proposal.toolSchema) {
      if (signal) catalogues.delete(signal);
      throw new Error("MCP tool changed. Discover it and request approval again.");
    }
    check();
    return client.callTool(proposal.tool, proposal.arguments);
  });
  // Persist returned assets even if Stop was pressed just after the response:
  // generation may already have been paid for.
  return saveMcpResult(proposal.path, result);
}
