/**
 * Channels, routes and per-route model fields (docs/feature/channel-model-route-plan.md).
 *
 * The migration promise is the one pinned hardest here: a row saved before
 * routes existed reads as a channel with one route whose address is its old
 * base URL **byte for byte** (§5.2) — no request changes on upgrade.
 */
import { describe, expect, it } from "vitest";
import type { Model, Provider } from "../configDb";
import { readChannel } from "../configDb";
import {
  activeFamily, channelEndpoints, dropModelRoute, endpointBaseUrl, keyOptional, legacyEndpoint, modelRouteFamilies,
  newChannelEndpoints, normalizeChannel, parseEndpoints, parseRouteProfiles, providerFor, routeProfileOf,
  routeProvider, splitBaseUrl, standardOf, switchModelRoute,
} from "../routes";
import { convertToAnthropicMessages } from "../anthropic";
import { toResponsesInput } from "../responses";
import type { ApiStandard, StreamMessage } from "../types";

const legacy = (baseUrl: string, apiStandard: ApiStandard, extra: Partial<Provider> = {}): Provider => ({
  id: "p", name: "P", baseUrl, apiStandard, createdAt: 0, ...extra,
});

const model = (extra: Partial<Model> = {}): Model => ({
  id: "m1", providerId: "p", modelId: "qwen3.8-flash", name: "Q", type: "text",
  priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, ...extra,
});

describe("migration: a pre-routes row is one route at the same address", () => {
  // Every preset the old drawer offered, plus the shapes authors hand-type.
  const cases: [string, ApiStandard][] = [
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "openai_compat"],
    ["https://dashscope.aliyuncs.com/apps/anthropic", "anthropic_compat"],
    ["https://api.deepseek.com", "openai_compat"],
    ["https://api.x.ai/v1", "openai_responses_compat"],
    ["https://api.orcarouter.ai", "anthropic_compat"],
    ["https://api.orcarouter.ai/v1beta", "gemini_compat"],
    ["http://localhost:11434/v1", "openai_compat"],
    ["https://Relay.Example.com/openai/v1/", "openai_compat"],
    ["", "openai_compat"],
    ["not a url", "openai_compat"],
    ["", "openai"],
    ["https://api.openai.com/v1", "openai"],
    ["", "anthropic"],
  ];
  it.each(cases)("%s (%s)", (baseUrl, std) => {
    const c = normalizeChannel(legacy(baseUrl, std));
    expect(c.baseUrl).toBe(baseUrl);
    expect(c.apiStandard).toBe(std);
    expect(c.endpoints).toHaveLength(1);
    expect(endpointBaseUrl(c, c.endpoints![0])).toBe(baseUrl);
  });

  it("stores no path where the address is the platform's convention", () => {
    // NULL follows the platform (§5.1.1): a convention that moves later moves
    // this route with it; an override would be pinned.
    expect(legacyEndpoint(legacy("https://dashscope.aliyuncs.com/compatible-mode/v1", "openai_compat")).endpoint.path)
      .toBeUndefined();
    expect(legacyEndpoint(legacy("https://dashscope.aliyuncs.com/proxy/v1", "openai_compat")).endpoint.path)
      .toBe("/proxy/v1");
  });

  it("keeps auth and safety on the route they belong to", () => {
    const c = normalizeChannel(legacy("https://api.orcarouter.ai/v1beta", "gemini_compat", {
      authMode: "bearer", safetySettings: { HARM_CATEGORY_HARASSMENT: "BLOCK_NONE" },
    }));
    expect(c.endpoints![0]).toMatchObject({ family: "gemini", authMode: "bearer" });
    expect(c.endpoints![0].safetySettings).toEqual({ HARM_CATEGORY_HARASSMENT: "BLOCK_NONE" });
  });

  it("splits on the raw string, so an upper-case host survives", () => {
    expect(splitBaseUrl("https://Relay.Example.com/v1")).toEqual({ host: "https://Relay.Example.com", rest: "/v1" });
    expect(splitBaseUrl("")).toEqual({ host: "", rest: "" });
  });
});

describe("a channel's other routes", () => {
  const dashscope = normalizeChannel({
    id: "p", name: "百炼", baseUrl: "", apiStandard: "openai_compat", createdAt: 0,
    platform: "dashscope", host: "https://dashscope.aliyuncs.com",
    endpoints: newChannelEndpoints("dashscope"),
  });

  it("gets every route the platform serves, primary first", () => {
    expect(channelEndpoints(dashscope).map((e) => e.family)).toEqual(["openai", "responses", "anthropic"]);
    expect(dashscope.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("reads each route at the platform's path, with its own standard", () => {
    const anth = routeProvider(dashscope, "anthropic")!;
    expect(anth.baseUrl).toBe("https://dashscope.aliyuncs.com/apps/anthropic");
    expect(anth.apiStandard).toBe("anthropic_compat");
    // The platform is the channel's: the Anthropic route still spells DashScope.
    expect(anth.platform).toBe("dashscope");
    expect(routeProvider(dashscope, "responses")!.apiStandard).toBe("openai_responses_compat");
    expect(routeProvider(dashscope, "gemini")).toBeUndefined();
  });

  it("an absolute path replaces the host too", () => {
    const c = normalizeChannel({
      ...dashscope,
      endpoints: [dashscope.endpoints![0], { family: "anthropic", official: false, path: "https://claude.relay.example" }],
    });
    expect(routeProvider(c, "anthropic")!.baseUrl).toBe("https://claude.relay.example");
  });

  it("an official platform's routes are the vendor constants", () => {
    const c = normalizeChannel({
      id: "o", name: "OpenAI", baseUrl: "", apiStandard: "openai", createdAt: 0,
      platform: "openai", host: "", endpoints: newChannelEndpoints("openai"),
    });
    expect(c.baseUrl).toBe("");
    expect(routeProvider(c, "responses")!.apiStandard).toBe("openai_responses");
    expect(standardOf({ family: "gemini", official: true })).toBe("gemini");
  });

  it("a custom channel starts with one route", () => {
    expect(newChannelEndpoints("custom").map((e) => e.family)).toEqual(["openai"]);
    expect(newChannelEndpoints("orcarouter").find((e) => e.family === "anthropic")?.authMode).toBe("bearer");
  });

  it("providerFor sees the channel through the model's route", () => {
    expect(providerFor(model({ activeRoute: "anthropic" }), [dashscope])!.apiStandard).toBe("anthropic_compat");
    expect(providerFor(model(), [dashscope])!.apiStandard).toBe("openai_compat");
    // A route the channel dropped reads as the primary one here; resolveConn
    // is where a request refuses it (aiConn.test.ts).
    expect(activeFamily({ activeRoute: "gemini" }, dashscope)).toBe("openai");
  });
});

describe("switching a model's route (invariants 1 and 3)", () => {
  const channel = normalizeChannel({
    id: "p", name: "百炼", baseUrl: "", apiStandard: "openai_compat", createdAt: 0,
    platform: "dashscope", host: "https://dashscope.aliyuncs.com", endpoints: newChannelEndpoints("dashscope"),
  });
  const onChat = model({
    thinkingCategory: "qwen-budget", thinkingBudget: 4000, maxOutput: 8192, temperature: 0.3,
    structuredOutput: "json_schema", serverTools: ["web_search"], contextSize: 131_072,
  });

  it("copies nothing onto a route never configured", () => {
    const onResp = switchModelRoute(onChat, channel, "responses");
    expect(onResp.id).toBe("m1");
    expect(onResp.activeRoute).toBe("responses");
    expect(routeProfileOf(onResp)).toEqual({});
    // Model-level fields don't move: the grant and the window are the model's.
    expect(onResp.serverTools).toEqual(["web_search"]);
    expect(onResp.contextSize).toBe(131_072);
    expect(modelRouteFamilies(onResp, channel)).toEqual(["responses", "openai"]);
  });

  it("brings the old route's fields back when switching back", () => {
    const back = switchModelRoute(switchModelRoute(onChat, channel, "responses"), channel, "openai");
    expect(routeProfileOf(back)).toEqual(routeProfileOf(onChat));
    expect(back.routes).toMatchObject({ responses: {} });
  });

  it("forgets a parked route, never the current one", () => {
    const parked = switchModelRoute(onChat, channel, "responses");
    expect(dropModelRoute(parked, "openai").routes).toBeUndefined();
    expect(dropModelRoute(parked, "responses")).toBe(parked);
  });
});

describe("parsing", () => {
  it("drops an unknown family and a second route of one family", () => {
    expect(parseEndpoints(JSON.stringify([
      { family: "openai", official: false, path: "/v1" },
      { family: "openai", official: false, path: "/other" },
      { family: "cohere", official: false },
      { family: "anthropic", official: false, authMode: "nonsense" },
    ]))).toEqual([
      { family: "openai", official: false, path: "/v1" },
      { family: "anthropic", official: false },
    ]);
    expect(parseEndpoints("[]")).toBeUndefined();
    expect(parseEndpoints("{bad")).toBeUndefined();
  });

  it("narrows parked profiles field by field", () => {
    expect(parseRouteProfiles({ responses: { reasoningEffort: "extreme", maxOutput: 100, x: 1 }, zzz: {} }))
      .toEqual({ responses: { maxOutput: 100 } });
  });

  it("a moved platform convention is not mistaken for an older build's edit", () => {
    // The columns still hold what this build wrote (the marker says so), so an
    // empty path keeps following the platform even though today's convention
    // computes another address than the one written back then.
    const stored: Provider = {
      id: "p", name: "P", createdAt: 0, platform: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/old-mode/v1", apiStandard: "openai_compat",
      host: "https://dashscope.aliyuncs.com",
      endpoints: [{ family: "openai", official: false }],
    };
    const c = readChannel(stored, "https://dashscope.aliyuncs.com/old-mode/v1");
    expect(c.endpoints![0].path).toBeUndefined();
    expect(c.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("an older build's edit to the columns wins for the primary route", () => {
    // It rewrote base_url / api_standard and knows nothing of `endpoints`.
    const stored: Provider = {
      id: "p", name: "P", createdAt: 0,
      baseUrl: "https://relay.example/moved/v1", apiStandard: "openai_compat",
      host: "https://relay.example",
      endpoints: [
        { family: "openai", official: false },
        { family: "anthropic", official: false },
      ],
    };
    const c = readChannel(stored);
    expect(c.baseUrl).toBe("https://relay.example/moved/v1");
    expect(c.endpoints!.map((e) => e.family)).toEqual(["openai", "anthropic"]);
  });
});

describe("invariant 6: a carry does not cross families", () => {
  // Same model id, new family: the new adapter never reads the old family's
  // carry field, so the turn degrades to the plain tool-call spelling — the
  // path a model switch already took. No code was added for routes; this pins it.
  const turn: StreamMessage[] = [
    { role: "user", content: "hi" },
    {
      role: "assistant", content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
      _responseItems: { modelId: "same", items: [{ type: "reasoning", encrypted_content: "x" }] },
      _thinkingBlocks: { modelId: "same", blocks: [{ type: "thinking", thinking: "t", signature: "s" }] },
    },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ];

  it("Responses items never reach an Anthropic request", () => {
    const out = JSON.stringify(convertToAnthropicMessages(turn.map((m) =>
      "_thinkingBlocks" in m ? { ...m, _thinkingBlocks: undefined } : m), "same"));
    expect(out).not.toContain("encrypted_content");
    expect(out).toContain("tool_use");
  });

  it("Anthropic thinking blocks never reach a Responses request", () => {
    const { input } = toResponsesInput(turn.map((m) =>
      "_responseItems" in m ? { ...m, _responseItems: undefined } : m), "same");
    expect(JSON.stringify(input)).not.toContain("signature");
    expect(input.some((i) => i.type === "function_call")).toBe(true);
  });
});

describe("keyOptional: which channels may go without an API key", () => {
  it("an Ollama channel, whatever its host", () => {
    expect(keyOptional(legacy("http://192.168.2.206:11434/v1", "openai_compat", { platform: "ollama" }))).toBe(true);
    expect(keyOptional(legacy("https://ollama.example.com/v1", "openai_compat", { platform: "ollama" }))).toBe(true);
  });

  it("any platform whose every route is on this machine or the LAN (LM Studio as custom)", () => {
    expect(keyOptional(legacy("http://192.168.2.206:1234/v1", "openai_compat", { platform: "custom" }))).toBe(true);
    expect(keyOptional(legacy("http://localhost:1234/v1", "openai_compat", { platform: "custom" }))).toBe(true);
  });

  it("not a public host, nor an official vendor route", () => {
    expect(keyOptional(legacy("https://relay.example/v1", "openai_compat", { platform: "newapi" }))).toBe(false);
    expect(keyOptional(legacy("", "openai"))).toBe(false);
  });

  it("not when one route leaves the LAN by an absolute override", () => {
    const ch = normalizeChannel(legacy("http://192.168.2.206:1234/v1", "openai_compat", { platform: "custom" }));
    ch.endpoints = [...channelEndpoints(ch), { family: "anthropic", official: false, path: "https://api.example.com" }];
    expect(keyOptional(ch)).toBe(false);
  });
});
