import type { ToolCall, ToolResult } from "../agent/tools";
import type { McpSettingsProposal, ToolContext } from "../agent/toolTypes";
import { IS_TAURI } from "../platform";
import { endpoint, isObject, readMcpServers, saveMcpServer } from "./config";

export async function manageMcpSettings(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!IS_TAURI || !ctx.requestApproval || !ctx.projectPath) {
    throw new Error("MCP configuration requires the desktop chat approval surface.");
  }
  const args: unknown = JSON.parse(call.arguments || "{}");
  if (!isObject(args) || Object.keys(args).some(key => !["action", "server", "new_name", "url", "disabled"].includes(key))
    || (args.server !== undefined && typeof args.server !== "string")
    || (args.new_name !== undefined && typeof args.new_name !== "string")
    || (args.url !== undefined && typeof args.url !== "string")
    || (args.disabled !== undefined && args.disabled !== true)) {
    throw new Error("Invalid MCP configuration request.");
  }
  const servers = readMcpServers();
  const result = (content: string) => ({ toolCallId: call.id, content });
  if (args.action === "list") {
    return result(JSON.stringify(servers.map(({ name, url, enabled }) => ({ name, url, enabled }))));
  }
  if (args.action !== "add" && args.action !== "update") throw new Error("Choose list, add, or update.");
  const old = args.action === "update" ? servers.find(server => server.name === args.server) : undefined;
  if (args.action === "update" && !old) throw new Error("MCP server not found. List the current configurations.");
  const name = (args.new_name ?? old?.name)?.trim();
  if (!name || name.length > 100) throw new Error("Provide an MCP server name of 1–100 characters.");
  if (servers.some(server => server.id !== old?.id && server.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("An MCP server with that name already exists.");
  }
  const url = endpoint(args.url?.trim() ?? old?.url);
  // A changed endpoint may receive stored credentials after the user enables it.
  const enabled = !!old?.enabled && old.url === url && args.disabled !== true;
  if (old && old.name === name && old.url === url && old.enabled === enabled) return result("MCP configuration already matches.");
  const before = old && { id: old.id, revision: old.revision, name: old.name, url: old.url, enabled: old.enabled };
  const proposal: McpSettingsProposal = {
    kind: "mcpSettings", id: crypto.randomUUID(), path: ctx.projectPath, before, after: { name, url, enabled },
  };
  const decision = await ctx.requestApproval(proposal);
  return result(decision.approved
    ? decision.backupPath ?? "MCP configuration saved."
    : `Error: MCP configuration change was not approved or could not be completed (${decision.reason ?? "declined"}). Ask the user before proposing it again.`);
}

export async function applyMcpSettings(proposal: McpSettingsProposal, signal?: AbortSignal): Promise<string> {
  if (!IS_TAURI) throw new Error("MCP configuration requires the desktop app.");
  const { before, after } = proposal;
  const saved = await saveMcpServer({
    ...after, id: before?.id, revision: before?.revision,
    enabled: before?.enabled === true && before.url === after.url && after.enabled,
  }, signal);
  return JSON.stringify({ name: saved.name, url: saved.url, enabled: saved.enabled });
}
