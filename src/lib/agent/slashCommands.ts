/** Composer syntax only; execution still belongs to the approved agent runtime. */
export function parseSlash(text: string): { command: string; request: string } | null {
  const match = /^\/([^\s]*)\s*([\s\S]*)$/.exec(text);
  return match ? { command: match[1], request: match[2].trim() } : null;
}
export function mcpCommand(server: string, tool: string): string {
  return `${encodeURIComponent(server)}:${encodeURIComponent(tool)}`;
}
export function mcpTarget(command: string): { server: string; tool: string } | null {
  const parts = command.split(":");
  if (parts.length !== 2 || !parts.every(Boolean)) return null;
  try { return { server: decodeURIComponent(parts[0]), tool: decodeURIComponent(parts[1]) }; }
  catch { return null; }
}
export function commandRequest(command: string, request: string): string {
  if (command === "imageGen") return `Use the built-in generate_image tool through the imagegen subagent for this request. Ask for any missing destination or details and retain the normal approval flow.\n\n${request}`;
  const target = mcpTarget(command);
  if (!target) return request;
  return `Use the MCP tool selected by the author: ${JSON.stringify(target)}. Discover its current schema using discover_mcp_tools, prepare arguments from the request below, and call it through call_mcp_tool with the normal approval flow. Ask for missing required information; do not substitute another tool.\n\n${request}`;
}
