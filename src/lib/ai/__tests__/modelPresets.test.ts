import { describe, expect, it } from "vitest";
import { findModelPreset, MODEL_PRESETS } from "../modelPresets";
import { FEE_GROUP_PRESETS } from "../feeGroupPresets";
import { resolveThinkingCategory } from "../capability/values";
import { effortMenuForDisplay, reasoningBody } from "../reasoning";

describe("built-in model presets", () => {
  it("matches explicit IDs and aliases without guessing related models", () => {
    const preset = findModelPreset("  [relay] OpenAI/GPT-6.2-SOL  ", {});
    expect(preset).toMatchObject({ id: "gpt-6.2-sol", contextSize: 1_050_000, maxOutput: 128_000, type: "multimodal" });
    expect(findModelPreset("anthropic/claude-opus-5.5")?.id).toBe("claude-opus-5-5");
    expect(findModelPreset("models/gemini-3-pro-image-preview")?.type).toBe("image");
    expect(findModelPreset("qwen3.8-max-0902")?.id).toBe("qwen3.8-max");
    expect(findModelPreset("gpt-6.2-sol-extra")).toBeUndefined();
    expect(findModelPreset("gemini-3.8-flash-tts")).toBeUndefined();
  });

  it("resolves documented Gemini effort levels and their wire spellings", () => {
    const neon = resolveThinkingCategory({ modelId: "gemini-4-neon" }, "gemini", "google");
    expect(effortMenuForDisplay(neon, neon.menu)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(reasoningBody(neon, "xhigh")).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: "XHIGH" } } });
    const argon = resolveThinkingCategory({ modelId: "gemini-4-argon" }, "gemini", "google");
    expect(effortMenuForDisplay(argon, argon.menu)).toEqual(["low", "medium", "high"]);
  });

  it("includes a price draft for every model and keeps published rate variants distinct", () => {
    const byId = new Map(FEE_GROUP_PRESETS.map((p) => [p.id, p.draft]));
    expect(byId.size).toBe(FEE_GROUP_PRESETS.length);
    for (const model of MODEL_PRESETS) {
      expect(FEE_GROUP_PRESETS.some((p) => p.id === model.id || p.id.startsWith(model.id + ":")), model.id).toBe(true);
    }
    expect(byId.get("gpt-6.2-sol:>272k")).toMatchObject({ inputPrice: 4, cacheInputPrice: 0.2, outputPrice: 15 });
    expect(byId.get("claude-opus-5-5")?.cacheInputPrice).toBe(0.2);
    expect(byId.get("qwen4-max")?.cacheInputPrice).toBe(0.075);
    expect(byId.get("gemini-4-carbon:≥2026-12-01")?.inputPrice).toBe(4);
    expect(byId.get("gemini-nano-banana-2.1")).toMatchObject({ outputPrice: 7.5, imageTokenPrices: { output: 30 } });
  });
});
