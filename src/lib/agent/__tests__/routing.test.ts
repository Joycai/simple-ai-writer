import { describe, expect, it } from "vitest";
import { routeTools } from "../routing";
import { AGENT_ASSIST_PRESET } from "../presets";
import type { SubAgentConfig, SubAgentKind } from "../subagent";

describe("routeTools", () => {
  const allDisabled: Record<SubAgentKind, SubAgentConfig> = {
    search: { kind: "search", modelId: null, enabled: false },
    vision: { kind: "vision", modelId: null, enabled: false },
    longread: { kind: "longread", modelId: null, enabled: false },
  };

  it("leaves tools and serverTools unchanged when no subagents are active", () => {
    const res = routeTools(AGENT_ASSIST_PRESET, allDisabled, true);
    expect(res.tools).toEqual(AGENT_ASSIST_PRESET.tools);
    expect(res.serverTools).toBe("final-round-off");
  });

  it("disables serverTools on main agent when search subagent is active", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      search: { kind: "search", modelId: "m-search", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, true);
    expect(res.serverTools).toBe("off");
    expect(res.tools).toContain("delegate");
  });

  it("strips read_image and read_lore_image from main agent when vision subagent is active", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      vision: { kind: "vision", modelId: "m-vision", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, true);
    expect(res.tools).not.toContain("read_image");
    expect(res.tools).not.toContain("read_lore_image");
    expect(res.tools).toContain("delegate");
  });

  it("does not add delegate tool if hasWorkspace is false", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      search: { kind: "search", modelId: "m-search", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, false);
    expect(res.tools).not.toContain("delegate");
  });
});
