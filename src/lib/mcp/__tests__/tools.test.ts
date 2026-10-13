import { beforeEach, describe, expect, it, vi } from "vitest";
const server = { id: "1", name: "images", url: "http://localhost:39287/mcp", enabled: true, revision: "1" };
const definition = { name: "generate_image", inputSchema: { type: "object", properties: { prompt: { type: "string" } } } };
const listTools = vi.fn(async () => [definition]);
const callTool = vi.fn(async () => ({ content: [] }));
const save = vi.fn(async () => ({ report: "saved", imagePath: "/project/assets/mcp/image.png" }));
vi.mock("../config", async (original) => ({ ...await original<typeof import("../config")>(),
  enabledMcpServer: () => ({ ...server }), isMcpEnabled: () => true, readMcpServers: () => [server] }));
vi.mock("../client", () => ({ withMcp: async (_s: unknown, _signal: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ listTools, callTool }) }));
vi.mock("../results", () => ({ saveMcpResult: (...args: unknown[]) => { void args; return save(); } }));
import { applyMcpCall, callMcpTool, discoverMcpTools } from "../tools";
import { isAutoApprovable } from "../../agent/autoApprove";
import type { McpProposal, ToolContext } from "../../agent/toolTypes";
const call = { id: "c", name: "call_mcp_tool", arguments: JSON.stringify({ server: "images", tool: "generate_image", arguments: { prompt: "flowers" }, reason: "illustrate" }) };
const context = { projectPath: "/project", loreIndex: [] } as unknown as ToolContext;
let proposal: McpProposal;
beforeEach(() => {
  vi.clearAllMocks(); server.revision = "1";
  listTools.mockResolvedValue([definition]);
  proposal = { kind: "mcp", id: "p", path: "/project", serverId: "1", serverName: "images", serverUrl: server.url,
    revision: "1", tool: "generate_image", toolSchema: JSON.stringify(definition), arguments: { prompt: "flowers" } };
});
describe("MCP approvals", () => {
  it("never runs a remote tool before approval or after rejection", async () => {
    const requestApproval = vi.fn(async () => ({ approved: false as const }));
    const result = await callMcpTool(call, { ...context, requestApproval });
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ kind: "mcp", arguments: { prompt: "flowers" } }), undefined);
    expect(callTool).not.toHaveBeenCalled(); expect(result.content).toContain("rejected");
    expect(isAutoApprovable("mcp")).toBe(false);
  });
  it("requires an approval surface before even discovering", async () => {
    await expect(callMcpTool(call, context)).rejects.toThrow("approval surface"); expect(listTools).not.toHaveBeenCalled();
  });
  it("refuses changed configuration before opening a connection", async () => {
    server.revision = "2";
    await expect(applyMcpCall(proposal)).rejects.toThrow("configuration changed"); expect(listTools).not.toHaveBeenCalled();
  });
  it("rechecks the schema after approval and never calls a changed tool", async () => {
    listTools.mockResolvedValueOnce([{ ...definition, inputSchema: { type: "object", properties: { prompt: { type: "number" } } } }]);
    await expect(applyMcpCall(proposal)).rejects.toThrow("tool changed"); expect(callTool).not.toHaveBeenCalled();
  });
  it("executes only the approved arguments and saves the result", async () => {
    expect(await applyMcpCall(proposal)).toEqual({ report: "saved", imagePath: "/project/assets/mcp/image.png" });
    expect(callTool).toHaveBeenCalledExactlyOnceWith("generate_image", { prompt: "flowers" }); expect(save).toHaveBeenCalledTimes(1);
  });
  it("does not connect when discovery only needs server names", async () => {
    const result = await discoverMcpTools({ ...call, arguments: "{}" }, context);
    expect(JSON.parse(result.content)).toEqual([{ server: "images" }]); expect(listTools).not.toHaveBeenCalled();
  });
  it("discovers compact tool names first, then the requested schema", async () => {
    const list = await discoverMcpTools({ ...call, arguments: '{"server":"images"}' }, context);
    expect(list.content).not.toContain("inputSchema");
    const schema = await discoverMcpTools({ ...call, arguments: '{"server":"images","tool":"generate_image"}' }, context);
    expect(schema.content).toContain("inputSchema");
  });
});
