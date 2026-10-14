import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpProposal } from "../../lib/agent/toolTypes";
import { chatAutoApproveKey, grantsMcp } from "../../lib/agent/autoApprove";

const apply = vi.fn(async () => ({ report: "MCP result" }));
vi.mock("../../lib/mcp/tools", () => ({ discoverMcpTools: vi.fn(), callMcpTool: vi.fn(), applyMcpCall: (...args: unknown[]) => { void args; return apply(); } }));
vi.mock("../projectStore", () => ({ useProjectStore: { getState: () => ({ projectPath: "/project" }) } }));
import { useAgentStore } from "../agentStore";
await import("../projectStore");
await import("../../lib/mcp/tools");
const key = chatAutoApproveKey("c0");
function proposal(over: Partial<McpProposal> = {}): McpProposal {
  return { kind: "mcp", id: crypto.randomUUID(), path: "/project", serverId: "images", serverName: "images",
    serverUrl: "http://localhost/mcp", revision: "1", tool: "list_models", toolSchema: "models-schema",
    serverTools: { list_models: "models-schema", generate_image: "generate-schema" }, arguments: {}, ...over };
}
beforeEach(() => { vi.clearAllMocks(); useAgentStore.setState({ pending: [], autoApprove: null }); });

describe("explicit MCP session grants", () => {
  it("covers this server's discovered tools across turns, with an automatic receipt", async () => {
    const store = useAgentStore.getState();
    store.grantMcpServer(key, proposal());
    expect(await store.requestApproval(proposal(), {}, { autoApproveKey: key })).toMatchObject({ approved: true, auto: true });
    store.rejectAll("turn ended", {});
    expect(await store.requestApproval(proposal({ tool: "generate_image", toolSchema: "generate-schema" }), {}, { autoApproveKey: key }))
      .toMatchObject({ approved: true, auto: true });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(useAgentStore.getState().pending).toEqual([]);
    store.enableAutoApprove(key, "proposals");
    expect(grantsMcp(useAgentStore.getState().autoApprove, key, proposal())).toBe(true);
    store.clearAutoApprove();
    expect(grantsMcp(useAgentStore.getState().autoApprove, key, proposal())).toBe(false);
  });
  it("requires a card for another chat/server, changed connection/schema, or a newly added tool", () => {
    const store = useAgentStore.getState();
    store.grantMcpServer(key, proposal());
    const state = useAgentStore.getState().autoApprove;
    expect(grantsMcp(state, chatAutoApproveKey("c1"), proposal())).toBe(false);
    expect(grantsMcp(state, undefined, proposal())).toBe(false);
    for (const over of [{ serverId: "other" }, { serverUrl: "http://localhost/new" }, { revision: "2" },
      { toolSchema: "changed" }, { tool: "new_tool" }, { tool: "toString", toolSchema: "models-schema" }]) {
      expect(grantsMcp(state, key, proposal(over))).toBe(false);
    }
    const run = {};
    void store.requestApproval(proposal({ toolSchema: "changed" }), run, { autoApproveKey: key });
    expect(useAgentStore.getState().pending).toHaveLength(1);
    expect(apply).not.toHaveBeenCalled();
    store.rejectAll("cleanup", run);
  });
  it("never inherits manuscript grants, and revocation returns to a card", () => {
    const store = useAgentStore.getState();
    store.enableAutoApprove(key, "proposals");
    const run = {};
    void store.requestApproval(proposal(), run, { autoApproveKey: key });
    expect(useAgentStore.getState().pending).toHaveLength(1);
    store.rejectAll("cleanup", run);
    store.grantMcpServer(key, proposal());
    store.clearAutoApprove();
    void store.requestApproval(proposal(), run, { autoApproveKey: key });
    expect(useAgentStore.getState().pending).toHaveLength(1);
    store.rejectAll("cleanup", run);
  });
  it("expires with a panel run, and an unbound surface cannot create it", () => {
    const store = useAgentStore.getState();
    store.grantMcpServer(undefined, proposal());
    expect(useAgentStore.getState().autoApprove).toBeNull();
    const run = {};
    store.grantMcpServer(run, proposal());
    store.rejectAll("task ended", run);
    expect(useAgentStore.getState().autoApprove).toBeNull();
  });
});
