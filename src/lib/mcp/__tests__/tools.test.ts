import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpTool } from "../client";
const server = { id: "1", name: "images", url: "http://localhost:39287/mcp", enabled: true, revision: "1" };
let servers = [server];
const definition = { name: "generate_image", inputSchema: { type: "object", properties: { prompt: { type: "string" } } } };
const listTools = vi.fn<() => Promise<McpTool[]>>(async () => [definition]);
const callTool = vi.fn(async () => ({ content: [] }));
const save = vi.fn(async () => ({ report: "saved", imagePath: "/project/assets/mcp/image.png" }));
vi.mock("../config", async (original) => ({ ...await original<typeof import("../config")>(),
  enabledMcpServer: () => ({ ...server }), isMcpEnabled: () => true, readMcpServers: () => servers }));
vi.mock("../client", () => ({ withMcp: async (_s: unknown, _signal: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ listTools, callTool }) }));
vi.mock("../results", () => ({ saveMcpResult: (...args: unknown[]) => { void args; return save(); } }));
import { applyMcpCall, callMcpTool, discoverMcpTools } from "../tools";
import { isAutoApprovable } from "../../agent/autoApprove";
import type { McpProposal, ToolContext } from "../../agent/toolTypes";
const call = { id: "c", name: "call_mcp_tool", arguments: JSON.stringify({ server: "images", tool: "generate_image", arguments: { prompt: "flowers" }, reason: "illustrate" }) };
const context = { projectPath: "/project", loreIndex: [] } as unknown as ToolContext;
let proposal: McpProposal;
beforeEach(() => {
  vi.clearAllMocks(); server.revision = "1"; servers = [server];
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
  it("returns a sole server's complete schemas in the first discovery", async () => {
    const result = await discoverMcpTools({ ...call, arguments: "{}" }, context);
    expect(JSON.parse(result.content)).toEqual({ server: "images", tools: [definition] });
    expect(callTool).not.toHaveBeenCalled();
  });
  it("lists multiple server names without contacting unrelated endpoints", async () => {
    servers = [server, { ...server, id: "2", name: "other" }];
    const result = await discoverMcpTools({ ...call, arguments: "{}" }, context);
    expect(JSON.parse(result.content)).toEqual([{ server: "images" }, { server: "other" }]);
    expect(listTools).not.toHaveBeenCalled();
  });
  it("returns schemas together for small servers", async () => {
    const list = await discoverMcpTools({ ...call, arguments: '{"server":"images"}' }, context);
    expect(JSON.parse(list.content).tools).toEqual([definition]);
  });
  it("uses a bounded name index for large servers, with selective schema lookup", async () => {
    const large = { ...definition, inputSchema: { ...definition.inputSchema, description: "x".repeat(13_000) } };
    listTools.mockResolvedValue([large]);
    const list = await discoverMcpTools({ ...call, arguments: '{"server":"images"}' }, context);
    expect(list.content).not.toContain("inputSchema");
    expect(list.content.length).toBeLessThan(1000);
    const schema = await discoverMcpTools({ ...call, arguments: '{"server":"images","tool":"generate_image"}' }, context);
    expect(JSON.parse(schema.content).tools).toEqual([large]);
  });
  it("shares discovery and proposal metadata within a run but rechecks on apply", async () => {
    const ctx = { ...context, signal: new AbortController().signal,
      requestApproval: vi.fn(async () => ({ approved: false as const })) };
    await discoverMcpTools({ ...call, arguments: "{}" }, ctx);
    await callMcpTool(call, ctx);
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(ctx.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      serverTools: { generate_image: JSON.stringify(definition) },
    }), undefined);
    await applyMcpCall(proposal, ctx.signal);
    expect(listTools).toHaveBeenCalledTimes(2);
    await discoverMcpTools({ ...call, arguments: "{}" }, { ...ctx, signal: new AbortController().signal });
    expect(listTools).toHaveBeenCalledTimes(3);
  });
  it("keeps every tool discoverable when aggregate descriptions exceed the index budget", async () => {
    const tools = Array.from({ length: 256 }, (_, i) => ({ ...definition,
      name: `tool_${i}`, description: "Long description. ".repeat(30),
    }));
    listTools.mockResolvedValue(tools);
    const ctx = { ...context, signal: new AbortController().signal };
    const list = await discoverMcpTools({ ...call, arguments: "{}" }, ctx);
    expect(list.content.length).toBeLessThanOrEqual(48_000);
    expect(JSON.parse(list.content).tools).toEqual(tools.map(({ name }) => ({ name })));
    const chosen = tools[255];
    const schema = await discoverMcpTools({ ...call, arguments: JSON.stringify({ server: "images", tool: chosen.name }) }, ctx);
    expect(JSON.parse(schema.content).tools).toEqual([chosen]);
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("still rejects an individual schema exceeding the response budget", async () => {
    listTools.mockResolvedValue([{ ...definition, description: "x".repeat(49_000) }]);
    await expect(discoverMcpTools({ ...call, arguments: JSON.stringify({ server: "images", tool: definition.name }) }, context))
      .rejects.toThrow("too large");
  });
  it("does not reuse discovery after configuration changes or a failed lookup", async () => {
    const ctx = { ...context, signal: new AbortController().signal };
    listTools.mockRejectedValueOnce(new Error("offline"));
    await expect(discoverMcpTools({ ...call, arguments: "{}" }, ctx)).rejects.toThrow("offline");
    await discoverMcpTools({ ...call, arguments: "{}" }, ctx);
    server.revision = "2";
    await discoverMcpTools({ ...call, arguments: "{}" }, ctx);
    expect(listTools).toHaveBeenCalledTimes(3);
  });
});
