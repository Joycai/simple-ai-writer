import { describe, expect, it } from "vitest";
import { routeTools } from "../routing";
import type { TaskWorkspaceHandle } from "../taskWorkspace";

/** Bindings that satisfy every kind's precondition — routing is what's under test. */
const MODELS = [
  { id: "m-search", providerId: "p", modelId: "s", name: "S", type: "text",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, serverTools: ["web_search"] },
  { id: "m-vision", providerId: "p", modelId: "v", name: "V", type: "multimodal",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true },
  { id: "m-long", providerId: "p", modelId: "l", name: "L", type: "text",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true },
] as never;

/** Stand-in handle: routeTools only tests it for presence. */
const WS: TaskWorkspaceHandle = { taskId: null, ensure: async () => ({ taskId: "t", dir: "/d" }) };
import { AGENT_ASSIST_PRESET } from "../presets";
import { withSessionOverrides, type SubAgentConfig, type SubAgentKind } from "../subagent";

describe("routeTools", () => {
  const allDisabled: Record<SubAgentKind, SubAgentConfig> = {
    search: { kind: "search", modelId: null, enabled: false },
    vision: { kind: "vision", modelId: null, enabled: false },
    longread: { kind: "longread", modelId: null, enabled: false },
    pdf: { kind: "pdf", modelId: null, enabled: false },
  };

  it("leaves tools and serverTools unchanged when no subagents are active", () => {
    const res = routeTools(AGENT_ASSIST_PRESET, allDisabled, WS, MODELS);
    expect(res.tools).toEqual(AGENT_ASSIST_PRESET.tools);
    expect(res.serverTools).toBe("final-round-off");
  });

  it("disables serverTools on main agent when search subagent is active", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      search: { kind: "search", modelId: "m-search", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.serverTools).toBe("off");
    expect(res.tools).toContain("delegate");
  });

  it("strips read_image and read_lore_image from main agent when vision subagent is active", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      vision: { kind: "vision", modelId: "m-vision", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.tools).not.toContain("read_image");
    expect(res.tools).not.toContain("read_lore_image");
    expect(res.tools).toContain("delegate");
  });

  it("does not add delegate tool if hasWorkspace is false", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      search: { kind: "search", modelId: "m-search", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, undefined, MODELS);
    expect(res.tools).not.toContain("delegate");
  });
  // ── "Enabled" is not "usable" ────────────────────────────────────────────

  it("ignores a search subagent whose model cannot browse", () => {
    // Acting on the flag alone took the MAIN model's browsing away
    // (serverTools: "off") and handed back a subagent that refuses — strictly
    // worse than leaving the switch alone.
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      search: { kind: "search", modelId: "m-long", enabled: true },  // no web_search
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.serverTools).toBe("final-round-off");
    expect(res.tools).not.toContain("delegate");
  });

  it("ignores a vision subagent bound to a text-only model", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      vision: { kind: "vision", modelId: "m-long", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.tools).toContain("read_image");
    expect(res.tools).not.toContain("delegate");
  });

  it("ignores a subagent whose bound model was deleted", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      longread: { kind: "longread", modelId: "gone", enabled: true },
    };
    const res = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(res.tools).not.toContain("delegate");
  });

  // ── Session chips ────────────────────────────────────────────────────────

  it("a chip switched off this conversation takes the routing with it", () => {
    const subs: Record<SubAgentKind, SubAgentConfig> = {
      ...allDisabled,
      search: { kind: "search", modelId: "m-search", enabled: true },
      vision: { kind: "vision", modelId: "m-vision", enabled: true },
    };
    const on = routeTools(AGENT_ASSIST_PRESET, subs, WS, MODELS);
    expect(on.serverTools).toBe("off");
    expect(on.tools).not.toContain("read_image");

    // Disabling search must hand browsing back to the main model; disabling
    // vision must hand the image tools back. This is the whole point of the
    // chips — the composer and the delegate resolver read the same value.
    const off = routeTools(
      AGENT_ASSIST_PRESET,
      withSessionOverrides(subs, ["search", "vision"]),
      WS,
      MODELS,
    );
    expect(off.serverTools).toBe("final-round-off");
    expect(off.tools).toContain("read_image");
    expect(off.tools).not.toContain("delegate");
  });

  it("session overrides only subtract — a chip cannot enable what Settings did not", () => {
    const restored = withSessionOverrides(allDisabled, []);
    expect(routeTools(AGENT_ASSIST_PRESET, restored, WS, MODELS).tools)
      .toEqual(AGENT_ASSIST_PRESET.tools);
    // And an override for a kind that was never on is a no-op, not a toggle-on.
    const stillOff = withSessionOverrides(allDisabled, ["search"]);
    expect(stillOff.search.enabled).toBe(false);
  });
});
