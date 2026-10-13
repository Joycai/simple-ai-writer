import type { ToolContext, McpProposal } from "../agent/toolTypes";
import type { ToolCall, ToolResult } from "../agent/tools";
import { enabledMcpServer, isMcpEnabled, isObject, readMcpServers } from "./config";
import { withMcp } from "./client";
import { saveMcpResult } from "./results";

export async function discoverMcpTools(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!isMcpEnabled()) throw new Error("MCP is disabled.");
  const args: unknown = JSON.parse(call.arguments || "{}");
  if (!isObject(args)) throw new Error("Expected an object.");
  if (args.server === undefined) return { toolCallId: call.id,
    content: JSON.stringify(readMcpServers().filter((s) => s.enabled).map((s) => ({ server: s.name }))) };
  if (typeof args.server !== "string") throw new Error("server must be a name from discover_mcp_tools.");
  const server = enabledMcpServer(args.server);
  const tools = await withMcp(server, ctx.signal, (client) => client.listTools(), 30_000);
  const selected = args.tool === undefined ? tools : tools.filter((t) => t.name === args.tool);
  // Catalogue first, schema on request. External definitions never inflate the
  // resident tool header or mutate the built-in registry.
  const payload = args.tool === undefined
    ? selected.map((t) => ({ name: t.name, description: t.description?.slice(0, 600) })) : selected;
  const content = JSON.stringify({ server: server.name, tools: payload });
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
  const tools = await withMcp(server, ctx.signal, (client) => client.listTools(), 30_000);
  const tool = tools.find((t) => t.name === args.tool);
  if (!tool) throw new Error("Unknown MCP tool. Discover the server's tools again.");
  const proposal: McpProposal = { kind: "mcp", id: `mcp-${crypto.randomUUID()}`, path: ctx.projectPath,
    serverId: server.id, serverName: server.name, serverUrl: server.url, revision: server.revision,
    tool: tool.name, toolSchema: JSON.stringify(tool), arguments: args.arguments, reason: args.reason };
  const decision = await ctx.requestApproval(proposal, ctx.onProgress);
  return { toolCallId: call.id, content: decision.approved
    ? decision.backupPath ?? "MCP call completed without a captured result. Check the server before retrying."
    : `MCP call rejected or failed: ${decision.reason ?? "declined by the author"}. Do not retry without the author's direction.` };
}

/** Called only by the approval apply step; approval covers this exact endpoint,
 * revision, tool schema and argument object. All external calls ask, even if
 * the remote server claims readOnlyHint — that claim is not an authorization.
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
    if (!tool || JSON.stringify(tool) !== proposal.toolSchema) throw new Error("MCP tool changed. Discover it and request approval again.");
    check();
    return client.callTool(proposal.tool, proposal.arguments);
  });
  // Persist returned assets even if Stop was pressed just after the response:
  // generation may already have been paid for.
  return saveMcpResult(proposal.path, result);
}
