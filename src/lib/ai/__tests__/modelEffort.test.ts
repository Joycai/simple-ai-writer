import { describe, expect, it } from "vitest";
import { effortMenuOnWire, effortOnWire, resolveThinkingCategory } from "../capabilities";
import { reasoningBody, thinkingBody } from "../reasoning";
import type { ApiStandard } from "../types";

const thinking = ["low", "medium", "high", "xhigh", "max"];
const optional = ["off", ...thinking];

describe("model-specific effort ladders", () => {
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
