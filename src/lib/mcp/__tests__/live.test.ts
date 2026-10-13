/** Opt-in, read-only interoperability check. Credentials are never fixtures. */
import { expect, it, vi } from "vitest";
vi.mock("../config", async (original) => ({ ...await original<typeof import("../config")>(),
  mcpHeaders: async () => ({ Authorization: `Bearer ${process.env.MCP_SMOKE_TOKEN ?? ""}` }) }));
import { withMcp } from "../client";
it.skipIf(!process.env.MCP_SMOKE_URL)("initializes and discovers a live MCP server without calling any tools", async () => {
  const tools = await withMcp({ id: "smoke", name: "smoke", url: process.env.MCP_SMOKE_URL!, enabled: true, revision: "1" },
    undefined, (client) => client.listTools(), 10_000);
  expect(tools.length).toBeGreaterThan(0);
  expect(tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
}, 15_000);
