import { describe, expect, it } from "vitest";
import {
  dashscopeRunsCodeInterpreter,
  inferPlatform,
  parsePlatform,
  PLATFORM_IDS,
  platformForAddress,
  platformHasHosts,
  platformSource,
  platformToStore,
  resolvePlatform,
  serverToolStatus,
  wireReadsPdf,
} from "../platforms";

describe("inferPlatform", () => {
  it("names an official standard by its vendor, whatever the (empty) address", () => {
    expect(inferPlatform("", "openai")).toBe("openai");
    expect(inferPlatform("", "openai_responses")).toBe("openai");
    expect(inferPlatform("", "anthropic")).toBe("anthropic");
    expect(inferPlatform("", "gemini")).toBe("google");
  });

  it("names a compat row by its host — the addresses the old presets filled in", () => {
    const cases: [string, string][] = [
      ["https://api.deepseek.com", "deepseek"],
      ["https://dashscope.aliyuncs.com/compatible-mode/v1", "dashscope"],
      ["https://dashscope.aliyuncs.com/apps/anthropic", "dashscope"],
      ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "dashscope-intl"],
      ["https://api.x.ai/v1", "xai"],
      ["https://api.minimaxi.com/anthropic", "minimax"],
      ["https://api.orcarouter.ai/v1beta", "orcarouter"],
      ["http://localhost:11434/v1", "ollama"],
      ["http://127.0.0.1:8188", "comfyui"],
      ["HTTPS://API.DEEPSEEK.COM:443/", "deepseek"],
    ];
    for (const [url, id] of cases) expect(inferPlatform(url, "openai_compat"), url).toBe(id);
  });

  it("lands on custom for a host nothing names, and for an address that doesn't parse", () => {
    expect(inferPlatform("https://relay.example/v1", "openai_compat")).toBe("custom");
    expect(inferPlatform("http://localhost:1234/v1", "openai_compat")).toBe("custom");
    expect(inferPlatform("", "openai_compat")).toBe("custom");
    expect(inferPlatform("not a url", "anthropic_compat")).toBe("custom");
  });
});

describe("parsePlatform / resolvePlatform", () => {
  it("keeps a known id, reads an unknown one as custom, and absent as absent", () => {
    expect(parsePlatform("dashscope")).toBe("dashscope");
    // A newer build's platform, read by this one (plan §4 rule 3).
    expect(parsePlatform("some-future-platform")).toBe("custom");
    expect(parsePlatform(null)).toBeUndefined();
    expect(parsePlatform("")).toBeUndefined();
  });

  it("prefers the stored platform on compat, and the vendor on official", () => {
    expect(resolvePlatform("newapi", "https://dashscope.aliyuncs.com/compatible-mode/v1", "openai_compat")).toBe("newapi");
    expect(resolvePlatform(undefined, "https://dashscope.aliyuncs.com/compatible-mode/v1", "openai_compat")).toBe("dashscope");
    expect(resolvePlatform("dashscope", "", "openai")).toBe("openai");
  });

  it("tells host-identified platforms from the ones only the author can name", () => {
    expect(platformHasHosts("dashscope")).toBe(true);
    expect(platformHasHosts("newapi")).toBe(false);
    expect(platformHasHosts("custom")).toBe(false);
  });
});

describe("platformForAddress", () => {
  it("follows a host that names a platform", () => {
    expect(platformForAddress("custom", "https://dashscope.aliyuncs.com/compatible-mode/v1", "openai_compat")).toBe("dashscope");
    expect(platformForAddress("newapi", "https://api.deepseek.com", "openai_compat")).toBe("deepseek");
  });

  it("leaves a host-identified platform when the address moves off its host, keeps an author-picked one", () => {
    expect(platformForAddress("dashscope", "https://proxy.example/v1", "openai_compat")).toBe("custom");
    expect(platformForAddress("newapi", "https://relay.example/v1", "openai_compat")).toBe("newapi");
    expect(platformForAddress("custom", "", "openai_compat")).toBe("custom");
  });

  it("names the vendor for an official standard", () => {
    expect(platformForAddress("newapi", "https://api.openai.com/v1", "openai")).toBe("openai");
  });
});

describe("platformToStore", () => {
  it("stores only what the address doesn't already say, so inferred rows keep following the table", () => {
    const ds = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    expect(platformToStore({ platform: "dashscope", baseUrl: ds, apiStandard: "openai_compat" })).toBeUndefined();
    expect(platformToStore({ platform: "newapi", baseUrl: ds, apiStandard: "openai_compat" })).toBe("newapi");
    expect(platformToStore({ platform: "dashscope", baseUrl: "https://proxy.example/v1", apiStandard: "openai_compat" }))
      .toBe("dashscope");
    // Official: the vendor, always — nothing to store.
    expect(platformToStore({ platform: "openai", baseUrl: "", apiStandard: "openai" })).toBeUndefined();
    expect(platformToStore({ baseUrl: ds, apiStandard: "openai_compat" })).toBeUndefined();
  });
});

describe("serverToolStatus", () => {
  it("answers yes where the platform lists a tool, unknown for a protocol-native one it doesn't, no otherwise", () => {
    expect(serverToolStatus({ platform: "minimax", standard: "anthropic_compat" }, "web_search")).toBe("yes");
    expect(serverToolStatus({ platform: "orcarouter", standard: "anthropic_compat" }, "web_search")).toBe("unknown");
    expect(serverToolStatus({ platform: "newapi", standard: "openai_responses_compat" }, "web_search")).toBe("unknown");
    expect(serverToolStatus({ platform: "newapi", standard: "openai_responses_compat" }, "web_extractor")).toBe("no");
    expect(serverToolStatus({ platform: "newapi", standard: "openai_compat" }, "web_search")).toBe("no");
    expect(serverToolStatus({ platform: "openai", standard: "openai" }, "web_search")).toBe("no");
    expect(serverToolStatus({ platform: "google", standard: "gemini" }, "web_search")).toBe("no");
    // A local server runs no tools: explicit, not "unknown".
    expect(serverToolStatus({ platform: "ollama", standard: "anthropic_compat" }, "web_search")).toBe("no");
    expect(serverToolStatus({ platform: "deepseek", standard: "anthropic_compat" }, "web_search")).toBe("unknown");
  });

  it("consults the model gate only when given a model id", () => {
    const wire = { platform: "dashscope", standard: "openai_compat" } as const;
    expect(serverToolStatus(wire, "code_interpreter")).toBe("yes");
    expect(serverToolStatus(wire, "code_interpreter", "qwen3.8-flash")).toBe("no");
    expect(serverToolStatus(wire, "code_interpreter", "qwen3.5-plus")).toBe("yes");
  });
});

describe("profiles", () => {
  it("say where every entry was measured", () => {
    for (const id of PLATFORM_IDS) expect(platformSource(id), id).toMatch(/\S/);
  });
});

// The code interpreter's model table is a measurement, not a guess: every id
// below was sent to DashScope on 2026-09-17 (landscape.md §7 第六个样本「代码解释器」).
describe("dashscopeRunsCodeInterpreter", () => {
  it("matches what Chat Completions compat ran", () => {
    for (const id of [
      "qwen3-max", "qwen3-max-2026-01-23", "qwen3.5-plus", "qwen3.5-plus-2026-04-20", "qwen3.6-plus",
      "qwen3.7-plus", "qwen3.7-max", "qwen3.6-max-preview", "qwen3.5-flash", "qwen3.6-flash", "qwen3.5-397b-a17b",
      "Qwen3.5-Plus",
    ]) {
      expect(dashscopeRunsCodeInterpreter("openai", id), id).toBe(true);
    }
  });

  it("refuses what Chat Completions compat refused or silently ignored", () => {
    for (const id of [
      // 400 `does not support the code_interpreter tool`
      "qwen3.8-flash", "qwen3.8-max", "qwen3.8-27b",
      // accepted, but the prompt never grew: ignored
      "qwen-max", "qwen3-max-preview", "qwen3.5-omni-plus",
      "gpt-5.6", "",
    ]) {
      expect(dashscopeRunsCodeInterpreter("openai", id), id).toBe(false);
    }
  });

  it("matches what Responses compat ran", () => {
    for (const id of [
      "qwen3-max", "qwen3.5-plus", "qwen3.5-flash", "qwen3.7-plus", "qwen3.7-max", "qwen3.8-max", "qwen3.8-max-0902",
      "qwen3.8-flash", "qwen3.6-max-preview", "qwen3.5-397b-a17b", "qwen3.5-27b", "qwen3.6-35b-a3b", "qwen3.8-27b",
      "qwen3.8-2.4t-a95b", "deepseek-v4-pro", "deepseek-v4-flash-0731", "deepseek-v4.1-flash",
    ]) {
      expect(dashscopeRunsCodeInterpreter("responses", id), id).toBe(true);
    }
  });

  it("refuses what Responses compat failed", () => {
    for (const id of [
      "qwen3.6-27b", "qwen3-max-preview", "qwen3-235b-a22b-thinking-2507", "qwen3-vl-plus", "qwen3.5-omni-plus",
      "qwen-plus", "qwen3.8-livetranslate-flash-realtime", "qwen3.7-text-embedding",
    ]) {
      expect(dashscopeRunsCodeInterpreter("responses", id), id).toBe(false);
    }
  });

  it("has no table outside the two OpenAI-shaped wires", () => {
    expect(dashscopeRunsCodeInterpreter("anthropic", "qwen3.5-plus")).toBe(false);
    expect(dashscopeRunsCodeInterpreter("gemini", "qwen3.5-plus")).toBe(false);
  });
});

// 火山方舟: one host, two products told apart by path (landscape.md §7 第十二个样本).
describe("volcengine: two platforms on one host", () => {
  const HOST = "https://ark.cn-beijing.volces.com";
  it("names the plan by its path prefix and pay-as-you-go by the bare host", () => {
    expect(inferPlatform(`${HOST}/api/plan/v3`, "openai_compat")).toBe("volcengine-plan");
    expect(inferPlatform(`${HOST}/api/plan`, "anthropic_compat")).toBe("volcengine-plan");
    expect(inferPlatform(`${HOST}/api/plan/`, "anthropic_compat")).toBe("volcengine-plan");
    expect(inferPlatform(`${HOST}/api/v3`, "openai_compat")).toBe("volcengine");
    // A prefix matches on a segment boundary only.
    expect(inferPlatform(`${HOST}/api/planner`, "openai_compat")).toBe("volcengine");
  });

  it("keeps the picked product while the drawer's host field holds the bare host", () => {
    expect(platformForAddress("volcengine-plan", HOST, "openai_compat")).toBe("volcengine-plan");
    expect(platformForAddress("volcengine", HOST, "openai_compat")).toBe("volcengine");
    expect(platformForAddress("custom", HOST, "openai_compat")).toBe("volcengine");
    // A path still decides: pasting the pay-as-you-go address leaves the plan.
    expect(platformForAddress("volcengine-plan", `${HOST}/api/v3`, "openai_compat")).toBe("volcengine");
    // An inferable row stores nothing.
    expect(platformToStore({ platform: "volcengine-plan", baseUrl: `${HOST}/api/plan/v3`, apiStandard: "openai_compat" }))
      .toBeUndefined();
  });

  it("spells the plan's measured tools: Anthropic web_search yes, Chat none", () => {
    expect(serverToolStatus({ platform: "volcengine-plan", standard: "anthropic_compat" }, "web_search")).toBe("yes");
    expect(serverToolStatus({ platform: "volcengine-plan", standard: "openai_compat" }, "web_search")).toBe("no");
    expect(serverToolStatus({ platform: "volcengine", standard: "openai_responses_compat" }, "web_search")).toBe("unknown");
  });
});

describe("wireReadsPdf", () => {
  it("is Chat + Responses by default, and Anthropic only where a platform measured it", () => {
    expect(wireReadsPdf({ platform: "custom", standard: "openai_compat" })).toBe(true);
    expect(wireReadsPdf({ platform: "custom", standard: "openai_responses_compat" })).toBe(true);
    expect(wireReadsPdf({ platform: "deepseek", standard: "anthropic_compat" })).toBe(false);
    expect(wireReadsPdf({ platform: "google", standard: "gemini" })).toBe(false);
    expect(wireReadsPdf({ platform: "volcengine-plan", standard: "anthropic_compat" })).toBe(true);
    expect(wireReadsPdf({ platform: "volcengine-plan", standard: "openai_compat" })).toBe(true);
  });
});
