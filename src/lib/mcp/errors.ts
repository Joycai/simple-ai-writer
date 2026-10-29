/** Only application-owned codes reach UI diagnostics; never remote error bodies. */
export class McpError extends Error {
  constructor(public code: string, public stage = "configuration", public status?: number) { super(code === "protocol" ? "Unsupported MCP protocol version." : status ? `MCP HTTP ${status}. Calls are not retried automatically.` : `MCP ${code}`); }
}
export function mcpErrorCode(error: unknown): string {
  if (error instanceof McpError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  return "failed";
}
