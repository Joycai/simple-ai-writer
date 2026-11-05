import { expect, it, vi } from "vitest";
vi.mock("../../distribution", () => ({ distributionAllows: () => false, terminalAvailable: () => false }));
import { getToolDefinitions, executeRegisteredTool } from "../registry";
import { runAgent } from "../runtime";
import { subAgentModel } from "../subagentModel";
import { routeTools } from "../routing";
import { AGENT_ASSIST_PRESET } from "../presets";

it("old allowed/pending tool lists cannot advertise or execute Sakura", async () => {
  expect(getToolDefinitions(["translate"])).toEqual([]);
  const result = await executeRegisteredTool({ id: "old", name: "translate", arguments: "{}" },
    ["translate"], {} as Parameters<typeof executeRegisteredTool>[2], ["translate"]);
  expect(result.content).toContain("unavailable");
});
it.each(["roleplay-character", "roleplay-narrator"])("restored %s preset fails before context or network work", async (id) => {
  await expect(runAgent({ preset: { ...AGENT_ASSIST_PRESET, id }, messages: [] } as unknown as Parameters<typeof runAgent>[0])).rejects.toThrow();
});
it("legacy translation subagent binding is unusable", () => {
  expect(subAgentModel("translate", [], {} as Parameters<typeof subAgentModel>[2])).toBeNull();
});
it("an old preset cannot preserve translate or terminal in routing", () => {
  const routed = routeTools({ ...AGENT_ASSIST_PRESET, tools: ["translate", "run_command", "read_file"] }, {} as Parameters<typeof routeTools>[1], undefined, []);
  expect(routed.tools).not.toContain("translate");
  expect(routed.tools).not.toContain("run_command");
  expect(routed.tools).toContain("read_file");
});
