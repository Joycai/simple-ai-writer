import { describe, expect, it } from "vitest";
import {
  inferPlatform,
  parsePlatform,
  PLATFORM_IDS,
  platformCostReport,
  platformEndpoints,
  platformForAddress,
  platformHasHosts,
  platformModelCalibration,
  platformOrigin,
  platformSource,
  platformToStore,
  resolvePlatform,
} from "../platforms";
import { THINKING_CATEGORIES } from "../reasoning";
import { knownMaxOutput } from "../modelLimits";

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

describe("profiles", () => {
  it("say where every entry was measured", () => {
    for (const id of PLATFORM_IDS) expect(platformSource(id), id).toMatch(/\S/);
  });
});

// 火山方舟: one host, two products told apart by path (landscape.md §7 第十二个样本).
describe("volcengine: two platforms on one host", () => {
  const HOST = "https://ark.cn-beijing.volces.com";
  it("names the plan by its path prefix and pay-as-you-go by the bare host", () => {
    expect(inferPlatform(`${HOST}/api/plan/v3`, "openai_compat")).toBe("volcengine-plan");
    expect(inferPlatform(`${HOST}/api/plan/v3`, "openai_responses_compat")).toBe("volcengine-plan");
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
});

// DeepSeek: off is the disable switch, which only the `deepseek` category sends.
describe("deepseek calibration", () => {
  it("prefills the deepseek thinking category for its listed ids", () => {
    expect(platformModelCalibration("deepseek", "deepseek-flash")?.thinkingCategory).toBe("deepseek");
    expect(platformModelCalibration("deepseek", "DeepSeek-V4-Pro")?.thinkingCategory).toBe("deepseek");
  });
});

// MiniMax: Chat Completions under `/v1` — the bare root is an nginx 404 page.
describe("minimax", () => {
  it("routes Chat Completions under /v1 and Messages under /anthropic", () => {
    expect(platformEndpoints("minimax")).toEqual([
      { family: "openai", path: "/v1" },
      { family: "anthropic", path: "/anthropic" },
    ]);
    expect(inferPlatform("https://api.minimaxi.com/v1", "openai_compat")).toBe("minimax");
  });
});

// 智谱 BigModel (landscape.md §7 第十四个样本): the pay-as-you-go standard
// endpoint only; forcing a tool is sent as auto.
describe("zhipu", () => {
  const BASE = "https://open.bigmodel.cn/api/paas/v4";
  it("is named by its host and lists the one standard route", () => {
    expect(inferPlatform(BASE, "openai_compat")).toBe("zhipu");
    expect(platformEndpoints("zhipu")).toEqual([{ family: "openai", path: "/api/paas/v4" }]);
    expect(platformOrigin("zhipu")).toBe("https://open.bigmodel.cn");
  });
  // The Coding Plan's paths share the host but not the bill (zhipu-plan.md G9).
  it("names only the standard path; the Coding Plan's paths on the same host stay custom", () => {
    expect(inferPlatform("https://open.bigmodel.cn/api/coding/paas/v4", "openai_compat")).toBe("custom");
    expect(inferPlatform("https://open.bigmodel.cn/api/anthropic", "anthropic_compat")).toBe("custom");
    expect(inferPlatform("https://open.bigmodel.cn", "openai_compat")).toBe("custom");
  });
  // The drawer's host field is bare — it cannot tell the two bills apart, so
  // the bare host still means this platform (typed char by char, the platform
  // passes through custom on the way).
  it("follows the drawer's bare host field back to zhipu", () => {
    expect(platformForAddress("zhipu", "https://open.bigmodel.cn", "openai_compat")).toBe("zhipu");
    expect(platformForAddress("custom", "https://open.bigmodel.cn", "openai_compat")).toBe("zhipu");
    expect(platformForAddress("zhipu", "https://open.bigmodel.c", "openai_compat")).toBe("custom");
  });
});

// G11 (docs/api/zhipu-plan.md): the family default is wrong on all eleven, so
// the platform carries a per-id prefill. Every entry must be sendable on the
// platform's one route, and agree with the app-wide output-cap table.
describe("zhipu model calibration", () => {
  const IDS = [
    "glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2", "glm-5.1", "glm-5", "glm-5-turbo",
    "glm-4.7", "glm-4.6", "glm-4.5", "glm-4.5-air",
  ];
  it("covers the eleven measured ids, one of the three GLM categories each", () => {
    for (const id of IDS) {
      const cal = platformModelCalibration("zhipu", id);
      expect(cal, id).toBeDefined();
      expect(["glm", "glm-effort", "glm-switch"]).toContain(cal!.thinkingCategory);
      expect(THINKING_CATEGORIES[cal!.thinkingCategory!].family).toBe("openai");
      expect(cal!.maxOutput).toBe(knownMaxOutput(id));
    }
    expect(platformModelCalibration("zhipu", "glm-5.3")?.thinkingCategory).toBe("glm");
    expect(platformModelCalibration("zhipu", "glm-5.2")?.thinkingCategory).toBe("glm-effort");
    expect(platformModelCalibration("zhipu", "glm-4.7")?.thinkingCategory).toBe("glm-switch");
  });
  it("only the 5.3 flash pair reads pictures and PDFs", () => {
    const readers = IDS.filter((id) => platformModelCalibration("zhipu", id)?.type === "multimodal");
    expect(readers).toEqual(["glm-5.3-flash", "glm-5.3-flashx"]);
  });
  it("matches ids case-insensitively, and knows nothing it did not measure", () => {
    expect(platformModelCalibration("zhipu", " GLM-4.7 ")?.thinkingCategory).toBe("glm-switch");
    expect(platformModelCalibration("zhipu", "glm-4.6v")).toBeUndefined();
    expect(platformModelCalibration("dashscope", "glm-4.7")).toBeUndefined();
  });
});


describe("reported cost: the trust boundary", () => {
  // A reported cost overrides the model's whole fee group, so the set of
  // platforms taken at their word is pinned: adding one means a sample compared
  // its number against what it actually charged (reportedCost.ts).
  it("only OrcaRouter is trusted to report what a request cost", () => {
    expect(PLATFORM_IDS.filter((id) => platformCostReport(id))).toEqual(["orcarouter"]);
    expect(platformCostReport("orcarouter")?.header).toEqual(["X-OrcaRouter-Include-Cost", "true"]);
  });
});
