import { describe, expect, it } from "vitest";
import { addReportedCost, costReportHeaders, costReportingPlatform, reportedCostOf } from "../reportedCost";

describe("reportedCostOf — 只收声明过的平台", () => {
  it("OrcaRouter 四族各读自己的字段", () => {
    expect(reportedCostOf("orcarouter", "anthropic", { output_tokens: 2, cost_usd: 7.4e-5 })).toBe(7.4e-5);
    expect(reportedCostOf("orcarouter", "gemini", { promptTokenCount: 5, costUsd: 1.4e-5 })).toBe(1.4e-5);
    expect(reportedCostOf("orcarouter", "openai", { prompt_tokens: 5, cost: 9.9e-6 })).toBe(9.9e-6);
    expect(reportedCostOf("orcarouter", "responses", { input_tokens: 5, cost: 4.4e-6 })).toBe(4.4e-6);
  });

  it("字段按族认，别族的拼法不认", () => {
    expect(reportedCostOf("orcarouter", "anthropic", { cost: 1 })).toBeUndefined();
    expect(reportedCostOf("orcarouter", "gemini", { cost_usd: 1 })).toBeUndefined();
    expect(reportedCostOf("orcarouter", "responses", { cost_usd: 1 })).toBeUndefined();
    // ① 两种都认，`cost_usd` 优先。
    expect(reportedCostOf("orcarouter", "openai", { cost_usd: 2, cost: 1 })).toBe(2);
  });

  it("没声明的平台回包里有同名字段也不收", () => {
    expect(reportedCostOf("newapi", "openai", { cost: 0.01 })).toBeUndefined();
    expect(reportedCostOf("custom", "anthropic", { cost_usd: 0.01 })).toBeUndefined();
    expect(reportedCostOf("deepseek", "openai", { cost: 0.01 })).toBeUndefined();
    expect(reportedCostOf(undefined, "openai", { cost: 0.01 })).toBeUndefined();
  });

  it("0 是「上游说免费」，原样保留", () => {
    expect(reportedCostOf("orcarouter", "responses", { cost: 0 })).toBe(0);
  });

  it("负数、NaN、无穷、字符串、缺 usage 都是「没报」", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "0.01", null]) {
      expect(reportedCostOf("orcarouter", "gemini", { costUsd: bad })).toBeUndefined();
    }
    expect(reportedCostOf("orcarouter", "gemini", undefined)).toBeUndefined();
    expect(reportedCostOf("orcarouter", "gemini", "cost")).toBeUndefined();
  });
});

describe("costReportHeaders", () => {
  it("OrcaRouter 要带头才报 ④③", () => {
    expect(costReportHeaders("orcarouter")).toEqual({ "X-OrcaRouter-Include-Cost": "true" });
  });

  it("别的平台不加任何头", () => {
    expect(costReportHeaders("custom")).toEqual({});
    expect(costReportHeaders("anthropic")).toEqual({});
    expect(costReportHeaders(undefined)).toEqual({});
  });
});

describe("addReportedCost — 全报才加，缺一次整行回落计费组", () => {
  it("第一次的值原样接过来", () => {
    expect(addReportedCost(undefined, 0.5)).toBe(0.5);
    expect(addReportedCost(undefined, 0)).toBe(0);
  });

  it("每次都报了才相加", () => {
    expect(addReportedCost(addReportedCost(undefined, 0.25), 0.5)).toBe(0.75);
  });

  it("任何一次没报就是 null，之后再报也回不来", () => {
    expect(addReportedCost(undefined, undefined)).toBeNull();
    expect(addReportedCost(0.25, undefined)).toBeNull();
    expect(addReportedCost(null, 0.5)).toBeNull();
  });
});

describe("costReportingPlatform — 标签和地址都得是它", () => {
  it("OrcaRouter 的四条线路地址都认", () => {
    expect(costReportingPlatform({ baseUrl: "https://api.orcarouter.ai/v1", standard: "openai_compat" })).toBe("orcarouter");
    expect(costReportingPlatform({ baseUrl: "https://api.orcarouter.ai/v1", standard: "openai_responses_compat" })).toBe("orcarouter");
    expect(costReportingPlatform({ baseUrl: "https://api.orcarouter.ai", standard: "anthropic_compat", platform: "orcarouter" })).toBe("orcarouter");
    expect(costReportingPlatform({ baseUrl: "https://api.orcarouter.ai/v1beta", standard: "gemini_compat" })).toBe("orcarouter");
  });

  it("给别的主机贴上 OrcaRouter 标签不算", () => {
    expect(costReportingPlatform({ baseUrl: "https://relay.example.com/v1", standard: "openai_compat", platform: "orcarouter" })).toBeUndefined();
  });

  it("OrcaRouter 的地址被标成别的平台也不算（作者说它不是）", () => {
    expect(costReportingPlatform({ baseUrl: "https://api.orcarouter.ai/v1", standard: "openai_compat", platform: "newapi" })).toBeUndefined();
  });

  it("没声明报价的平台一律没有", () => {
    expect(costReportingPlatform({ baseUrl: "https://api.deepseek.com", standard: "openai_compat" })).toBeUndefined();
    expect(costReportingPlatform({ baseUrl: "", standard: "anthropic" })).toBeUndefined();
  });
});
