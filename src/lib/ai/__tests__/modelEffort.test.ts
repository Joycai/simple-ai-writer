import { describe, expect, it } from "vitest";
import { effortMenuOnWire, effortOnWire, resolveThinkingCategory } from "../capabilities";
import { catalogFact } from "../capability/cells/catalog";
import { hasCapability } from "../capabilities";
import { reasoningBody, thinkingBody } from "../reasoning";
import type { ApiStandard } from "../types";

const thinking = ["low", "medium", "high", "xhigh", "max"];
const optional = ["off", ...thinking];

describe("model-specific effort ladders", () => {
  it.each(["kimi-k3.1-pro", "moonshotai/kimi-k3.1-pro", "kimi-k3-1-pro-261024"])("%s keeps only native Kimi levels", (modelId) => {
    for (const standard of ["openai_compat", "openai_responses_compat"] as ApiStandard[]) {
      const wire = { standard, platform: "volcengine-plan" as const };
      const category = resolveThinkingCategory({ modelId }, standard, wire.platform);
      expect(category.menu).toEqual(["low", "high", "max"]);
      expect(effortOnWire("off", wire, { modelId }, false)).toBe("low");
      expect(reasoningBody(category, undefined)).toBeUndefined();
      expect(reasoningBody(category, "max")).toEqual(standard === "openai_compat"
        ? { reasoning_effort: "max" } : { reasoning: { effort: "max", summary: "auto" } });
    }
  });
  it.each([
    ["gpt-5.6-sol", optional], ["gpt-5.6-terra", optional], ["gpt-5.6-luna", optional],
    ["gpt-6-sol", optional], ["gpt-6-luna", optional],
    ["gpt-6-astra", thinking], ["gpt-6.1-sol", thinking],
  ])("%s exposes the same levels on both OpenAI protocols", (modelId, expected) => {
    for (const standard of ["openai", "openai_responses"] as ApiStandard[]) {
      expect(resolveThinkingCategory({ modelId: modelId as string }, standard).menu).toEqual(expected);
    }
  });

  it.each([
    ["claude-opus-4-6", ["low", "medium", "high", "max"]],
    ["claude-opus-4.6", ["low", "medium", "high", "max"]],
    ["claude-opus-4-7", thinking], ["claude-opus-4.8", thinking],
    ["claude-opus-5", thinking], ["claude-opus-5-5", thinking], ["claude-opus-5.5", thinking],
  ])("%s only offers distinct effort levels, without a fake off", (modelId, expected) => {
    expect(resolveThinkingCategory({ modelId: modelId as string }, "anthropic").menu).toEqual(expected);
  });

  it.each([
    ["deepseek-flash", ["off", "low", "high", "max"]],
    ["deepseek-v4-flash", ["off", "low", "high", "max"]],
    ["deepseek-v4-flash-0731", ["off", "low", "high", "max"]],
    ["qwen3.8-max-0902", ["off", "low", "medium", "xhigh"]],
    ["qwen3.8-flash", ["off", "low", "medium", "xhigh"]],
    ["Qwen/Qwen3.8-27B", ["off", "low", "medium", "xhigh"]],
    ["doubao-seed-2-0-pro-260215", ["off", "low", "medium", "high"]],
    ["doubao-seed-2.0-lite", ["off", "low", "medium", "high"]],
    ["doubao-seed-2.1-pro", ["off", "low", "medium", "high"]],
    ["doubao-seed-2-1-pro-260915", ["off", "low", "medium", "high"]],
  ])("%s trims compatibility aliases on Chat and Responses", (modelId, expected) => {
    for (const standard of ["openai_compat", "openai_responses_compat"] as ApiStandard[]) {
      expect(resolveThinkingCategory({ modelId: modelId as string }, standard).menu).toEqual(expected);
    }
  });

  it.each(["dashscope", "dashscope-intl"] as const)("%s selects Qwen effort automatically on Chat and native routes", (platform) => {
    for (const standard of ["openai_compat", "dashscope"] as ApiStandard[]) {
      for (const modelId of ["qwen3.8-max", "qwen3.8-flash", "qwen3.8-27b"]) {
        const category = resolveThinkingCategory({ modelId }, standard, platform);
        expect(category.id).toBe("qwen-effort");
        expect(category.menu).toEqual(["off", "low", "medium", "xhigh"]);
        expect(reasoningBody(category, "xhigh", 1000)).toEqual({ enable_thinking: true, reasoning_effort: "xhigh" });
        expect(reasoningBody(category, "off")).toEqual({ enable_thinking: false });
        expect(reasoningBody(category, undefined)).toBeUndefined();
      }
    }
  });

  it.each([
    ["deepseek", "deepseek-v4-flash-0731", "deepseek"],
    ["deepseek", "deepseek-flash", "deepseek"],
    ["volcengine", "doubao-seed-2-0-pro-260215", "doubao"],
    ["volcengine-plan", "doubao-seed-2.0-lite", "doubao"],
    ["volcengine-plan", "doubao-seed-2-0-lite-260428", "doubao"],
    ["volcengine-plan", "doubao-seed-2.1-pro", "doubao"],
  ] as const)("%s selects the native switch for %s", (platform, modelId, id) => {
    const category = resolveThinkingCategory({ modelId }, "openai_compat", platform);
    expect(category.id).toBe(id);
    for (const effort of category.menu) {
      expect(reasoningBody(category, effort)).toEqual(effort === "off"
        ? { thinking: { type: "disabled" } } : { reasoning_effort: effort });
    }
  });

  it("keeps Qwen 3.7 Plus as a budget control and uses its documented ceiling", () => {
    for (const standard of ["openai_compat", "dashscope"] as ApiStandard[]) {
      const category = resolveThinkingCategory({ modelId: "qwen3.7-plus-2026-05-26" }, standard, "dashscope");
      expect(category.id).toBe("qwen-budget");
      expect(category.shape).toBe("budget");
      expect(category.budget?.max).toBe(262144);
      expect(reasoningBody(category, "high", 262144)).toEqual({ enable_thinking: true, thinking_budget: 262144 });
      expect(reasoningBody(category, "off", 262144)).toEqual({ enable_thinking: false });
    }
  });

  it("keeps explicit controls, unrelated models, and other protocol faces intact", () => {
    expect(resolveThinkingCategory({ modelId: "qwen3.8-max", thinkingCategory: "off" }, "openai_compat", "dashscope").shape).toBe("none");
    expect(resolveThinkingCategory({ modelId: "qwen3.8-max", thinkingCategory: "qwen-budget" }, "openai_compat", "dashscope").shape).toBe("budget");
    expect(resolveThinkingCategory({ modelId: "gpt-6-sol", thinkingCategory: "deepseek" }, "openai").menu).toEqual(["off", "low", "high", "max"]);
    expect(resolveThinkingCategory({ modelId: "qwen3.8-omni-flash" }, "openai_compat", "dashscope").id).toBe("openai-generic");
    expect(resolveThinkingCategory({ modelId: "doubao-seedance-2-0-pro" }, "openai_compat", "volcengine").id).toBe("openai-generic");
    expect(resolveThinkingCategory({ modelId: "qwen3.8-max" }, "anthropic").menu).toContain("max");
    const category = resolveThinkingCategory({ modelId: "qwen3.8-max" }, "openai_responses_compat", "dashscope");
    for (const effort of category.menu) {
      expect(reasoningBody(category, effort)).toEqual({ reasoning: effort === "off" ? { effort: "none" } : { effort, summary: "auto" } });
    }
  });

  it("keeps unknown models and author-declared switch/budget dialects intact", () => {
    expect(resolveThinkingCategory({ modelId: "custom" }, "openai").menu).toEqual(["off", "low", "medium", "high", "max"]);
    expect(resolveThinkingCategory({ modelId: "gpt-6-sol", thinkingCategory: "qwen-budget" }, "openai").shape).toBe("budget");
    expect(resolveThinkingCategory({ modelId: "claude-opus-5", thinkingCategory: "minimax" }, "anthropic").shape).toBe("onoff");
  });

  it("uses the canonical relay identity while retaining measured route restrictions", () => {
    const model = { modelId: "special | gpt-6.1-sol" };
    const wire = { standard: "openai_responses_compat" as const, platform: "newapi" as const };
    const category = resolveThinkingCategory(model, wire.standard, wire.platform, "gpt-6.1-sol");
    expect(category.menu).toEqual(thinking);
    expect(effortOnWire("off", wire, model, false, "gpt-6.1-sol")).toBe("low");
    const relay = { standard: "openai_compat" as const, platform: "orcarouter" as const };
    const sol = { modelId: "openai/gpt-5.6-sol" };
    const menu = resolveThinkingCategory(sol, relay.standard, relay.platform).menu;
    expect(effortMenuOnWire(menu, relay, sol)).not.toContain("max");
  });

  it.each(["gpt-6-astra", "gpt-6.1-sol"])("normalizes a saved off before serializing %s", (modelId) => {
    const wire = { standard: "openai_responses" as const, platform: "openai" as const };
    const category = resolveThinkingCategory({ modelId }, wire.standard, wire.platform);
    expect(reasoningBody(category, effortOnWire("off", wire, { modelId }, false))).toEqual({
      reasoning: { effort: "low", summary: "auto" },
    });
    expect(reasoningBody(category, undefined)).toBeUndefined();
  });

  it("sends a newer Opus xhigh as native effort alongside adaptive thinking", () => {
    const category = resolveThinkingCategory({ modelId: "claude-opus-5-5" }, "anthropic");
    expect(reasoningBody(category, "xhigh")).toEqual({ output_config: { effort: "xhigh" } });
    expect(thinkingBody(category.dialect, 4096, "xhigh")).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
    });
  });
});


it.each(["gpt-5.60-sol", "gpt-6-astra2", "claude-opus-50", "qwen3.8-max2"])("does not apply a nearby generation's effort profile to %s", (modelId) => {
  expect(catalogFact("effortProfile", modelId)).toBeUndefined();
});

it.each([
  ["deepseek", "deepseek-flash"], ["deepseek", "deepseek-v4-flash"],
  ["dashscope", "qwen3.8-max"], ["dashscope-intl", "qwen3.8-flash"],
  ["dashscope", "qwen3.8-27b"], ["volcengine", "doubao-seed-2-0-pro"],
  ["volcengine-plan", "doubao-seed-2.0-lite"],
] as const)("keeps %s platform categories aligned with catalog profiles for %s", (platform, id) => {
  for (const modelId of id === "deepseek-flash" ? [id] : [id, id + "-20261001"]) {
    expect(resolveThinkingCategory({ modelId }, "openai_compat", platform).id)
      .toBe(catalogFact("effortProfile", modelId)?.category);
  }
});

it("does not turn always-reasoning models off on any currently restricted tools route", () => {
  for (const platform of ["openai", "orcarouter", "newapi"] as const) {
    for (const id of ["gpt-6-astra", "gpt-6.1-sol"]) {
      const modelId = platform === "orcarouter" ? "openai/" + id : id;
      const wire = { platform, standard: "openai_compat" as const };
      expect(hasCapability("effortWithTools", wire, { modelId })).toBe(true);
      expect(effortOnWire("high", wire, { modelId }, true)).toBe("high");
    }
  }
});
