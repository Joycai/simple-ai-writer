/**
 * `resolveThinkingCategory` — the single seam that turns an author's declared
 * category, or a legacy `thinkingDialect` on a model configured before
 * categories existed, into a concrete `ThinkingCategory`.
 *
 * Pinned as a unit because two invariants ride on it and neither shows up in
 * the wire tests: (1) a migrated `switch`+OpenAI model must land on
 * `qwen-budget` so it stays byte-identical to the old switch, and (2) a legacy
 * dialect must only migrate to a category of the **same protocol family** — a
 * cross-family map would emit e.g. Anthropic `output_config` onto an OpenAI
 * request. See reasoning.ts.
 */
import { describe, expect, it } from "vitest";
import {
  categoriesForFamily,
  defaultCategoryId,
  parseThinkingCategory,
  forcesToolChoiceAuto,
  isOnOffCategory,
  onEffort,
  reasoningBody,
  resolveThinkingCategory,
  THINKING_CATEGORIES,
  thinkingBody,
  thinkingIsOn,
} from "../reasoning";
import type { ApiStandard } from "../types";

describe("resolveThinkingCategory", () => {
  it("prefers an explicitly declared category over any legacy dialect", () => {
    const cat = resolveThinkingCategory(
      { thinkingCategory: "glm", thinkingDialect: "adaptive" },
      "openai_compat",
    );
    expect(cat.id).toBe("glm");
  });

  it("ignores an unknown declared category and falls back to migration/default", () => {
    // parseThinkingCategory would have nulled a bad column, but guard here too.
    const cat = resolveThinkingCategory(
      { thinkingCategory: "nope" as never },
      "gemini",
    );
    expect(cat.id).toBe("gemini3");
  });

  it("migrates the legacy dialects to their same-family category", () => {
    expect(resolveThinkingCategory({ thinkingDialect: "adaptive" }, "anthropic").id)
      .toBe("claude-adaptive");
    expect(resolveThinkingCategory({ thinkingDialect: "extended" }, "anthropic_compat").id)
      .toBe("claude-budget");
    expect(resolveThinkingCategory({ thinkingDialect: "switch" }, "anthropic").id)
      .toBe("minimax");
    // switch on the OpenAI family → qwen-budget, and the budget is left unset by
    // the caller so it emits only enable_thinking (byte-identical to old switch).
    expect(resolveThinkingCategory({ thinkingDialect: "switch" }, "openai_compat").id)
      .toBe("qwen-budget");
  });

  it("maps the `none` dialect to `off` on any family", () => {
    for (const s of ["openai", "gemini", "anthropic"] as ApiStandard[]) {
      expect(resolveThinkingCategory({ thinkingDialect: "none" }, s).id).toBe("off");
    }
  });

  it("does NOT migrate an Anthropic-only dialect onto a non-Anthropic family", () => {
    // The cross-family guard: an OpenAI/Gemini model carrying `adaptive` or
    // `extended` (only reachable via an imported/hand-edited bundle) must fall
    // to its own family default, never to a Claude category.
    expect(resolveThinkingCategory({ thinkingDialect: "adaptive" }, "openai_compat").id)
      .toBe("openai-generic");
    expect(resolveThinkingCategory({ thinkingDialect: "extended" }, "gemini").id)
      .toBe("gemini3");
    expect(resolveThinkingCategory({ thinkingDialect: "adaptive" }, "gemini_compat").family)
      .toBe("gemini");
  });

  it("falls back to the family default when nothing is declared", () => {
    expect(resolveThinkingCategory({}, "openai").id).toBe("openai-generic");
    expect(resolveThinkingCategory({}, "gemini").id).toBe("gemini3");
    expect(resolveThinkingCategory({}, "anthropic").id).toBe("claude-adaptive");
  });

  it("always resolves to a category of the provider's own family", () => {
    const cases: [ApiStandard, string][] = [
      ["openai", "openai"], ["openai_compat", "openai"],
      ["gemini", "gemini"], ["gemini_compat", "gemini"],
      ["anthropic", "anthropic"], ["anthropic_compat", "anthropic"],
    ];
    for (const [standard, family] of cases) {
      // `off` is the one family-agnostic category; every other resolution must
      // match the provider family so the adapter never emits foreign fields.
      const cat = resolveThinkingCategory({}, standard);
      expect(cat.family).toBe(family);
    }
  });
});

describe("defaultCategoryId / categoriesForFamily", () => {
  it("defaults each family to its current-generation category", () => {
    expect(defaultCategoryId("openai_compat")).toBe("openai-generic");
    expect(defaultCategoryId("gemini")).toBe("gemini3");
    expect(defaultCategoryId("anthropic")).toBe("claude-adaptive");
  });

  it("gives the Responses family its own category, never a Chat Completions one", () => {
    // `openai-generic` would put Chat Completions' `reasoning_effort` on a
    // wire that spells it `reasoning.effort`.
    expect(defaultCategoryId("openai_responses")).toBe("responses-effort");
    expect(defaultCategoryId("openai_responses_compat")).toBe("responses-effort");
    expect(categoriesForFamily("responses")).toEqual(["responses-effort", "off"]);
    expect(categoriesForFamily("openai")).not.toContain("responses-effort");
  });

  it("drops a declared category from another family, keeping only `off` across families", () => {
    // A provider whose standard was switched under an existing model, or an
    // imported row: the declared category must not carry its wire fields over.
    expect(resolveThinkingCategory({ thinkingCategory: "openai-generic" }, "openai_responses").id)
      .toBe("responses-effort");
    expect(resolveThinkingCategory({ thinkingCategory: "responses-effort" }, "openai_compat").id)
      .toBe("openai-generic");
    expect(resolveThinkingCategory({ thinkingCategory: "openai-generic" }, "anthropic").id)
      .toBe("claude-adaptive");
    expect(resolveThinkingCategory({ thinkingCategory: "off" }, "openai_responses").id).toBe("off");
    // Same family is still honoured as declared.
    expect(resolveThinkingCategory({ thinkingCategory: "deepseek" }, "openai_compat").id).toBe("deepseek");
  });

  it("offers only the family's own categories, plus the always-present `off`", () => {
    const openai = categoriesForFamily("openai");
    expect(openai).toContain("openai-generic");
    expect(openai).toContain("deepseek");
    expect(openai).toContain("off");
    expect(openai).not.toContain("claude-adaptive");
    expect(openai).not.toContain("gemini3");
    // `off` is appended, never in the middle.
    expect(openai[openai.length - 1]).toBe("off");

    const anthropic = categoriesForFamily("anthropic");
    expect(anthropic).toEqual(["claude-adaptive", "claude-budget", "minimax", "doubao-switch", "off"]);
  });

  it("parseThinkingCategory narrows a free-text column, else undefined", () => {
    expect(parseThinkingCategory("minimax")).toBe("minimax");
    expect(parseThinkingCategory("off")).toBe("off");
    expect(parseThinkingCategory("bogus")).toBeUndefined();
    expect(parseThinkingCategory(42)).toBeUndefined();
    expect(parseThinkingCategory(undefined)).toBeUndefined();
  });
});

// 火山方舟's Doubao Seed (landscape.md §7 第十二个样本): off must be the disable
// switch *alone* — the endpoint 400s on `reasoning_effort:"high"` next to
// `thinking:{type:"disabled"}` — and `medium` is a real level there.
describe("doubao category", () => {
  const cat = THINKING_CATEGORIES.doubao;
  it("offers medium and sends the switch alone for off", () => {
    expect(cat.menu).toEqual(["off", "low", "medium", "high"]);
    expect(reasoningBody(cat, "off")).toEqual({ thinking: { type: "disabled" } });
    expect(reasoningBody(cat, "medium")).toEqual({ reasoning_effort: "medium" });
    expect(reasoningBody(cat, "default")).toBeUndefined();
  });
  it("is an openai-family category", () => {
    expect(categoriesForFamily("openai")).toContain("doubao");
    expect(categoriesForFamily("anthropic")).not.toContain("doubao");
  });
});

// The Anthropic-route twin: the MiniMax switch's two spellings, without
// MiniMax's ban on a forced tool (a named tool_choice ran with thinking on).
describe("doubao-switch category", () => {
  const cat = THINKING_CATEGORIES["doubao-switch"];
  it("sends disabled for off and adaptive for on", () => {
    expect(thinkingBody(cat.dialect, 1024, "off")).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingBody(cat.dialect, 1024, "high")).toEqual({ thinking: { type: "adaptive" } });
  });
  it("keeps a forced tool_choice, unlike MiniMax", () => {
    expect(forcesToolChoiceAuto(cat, "high")).toBe(false);
    expect(forcesToolChoiceAuto(THINKING_CATEGORIES.minimax, "high")).toBe(true);
  });
  it("is offered only on the Anthropic family", () => {
    expect(categoriesForFamily("anthropic")).toContain("doubao-switch");
    expect(categoriesForFamily("openai")).not.toContain("doubao-switch");
  });
});

// GLM before 5.3 on 智谱's own endpoint (landscape.md §7 第十四个样本): thinks by
// default, ignores reasoning_effort, so the switch is the whole control.
describe("glm-switch category", () => {
  const cat = THINKING_CATEGORIES["glm-switch"];
  it("sends the switch alone, never reasoning_effort", () => {
    expect(reasoningBody(cat, "off")).toEqual({ thinking: { type: "disabled" } });
    expect(reasoningBody(cat, onEffort(cat))).toEqual({ thinking: { type: "enabled" } });
    expect(reasoningBody(cat, "default")).toBeUndefined();
    expect(reasoningBody(cat, undefined)).toBeUndefined();
  });
  it("is an on/off toggle that reads on while unset — the endpoint's own default", () => {
    expect(isOnOffCategory(cat)).toBe(true);
    expect(thinkingIsOn(cat, undefined)).toBe(true);
    expect(thinkingIsOn(cat, "off")).toBe(false);
    // Qwen's switch still reads off while unset.
    expect(thinkingIsOn(THINKING_CATEGORIES["qwen-budget"], undefined)).toBe(false);
  });
  it("keeps forcing to the platform, not the category", () => {
    expect(forcesToolChoiceAuto(cat, "high")).toBe(false);
  });
  it("is offered only on the OpenAI family", () => {
    expect(categoriesForFamily("openai")).toContain("glm-switch");
    expect(categoriesForFamily("anthropic")).not.toContain("glm-switch");
  });
});

// GLM-5.2 (landscape.md §7 第十四个样本): `none` keeps thinking, so off is the
// switch; low/medium fold into high, so the menu is off · high · max.
describe("glm-effort category", () => {
  const cat = THINKING_CATEGORIES["glm-effort"];
  it("sends the switch alone for off and reasoning_effort otherwise", () => {
    expect(cat.menu).toEqual(["off", "high", "max"]);
    expect(reasoningBody(cat, "off")).toEqual({ thinking: { type: "disabled" } });
    expect(reasoningBody(cat, "max")).toEqual({ reasoning_effort: "max" });
    expect(reasoningBody(cat, "default")).toBeUndefined();
  });
});
