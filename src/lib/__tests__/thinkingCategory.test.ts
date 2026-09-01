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
  resolveThinkingCategory,
} from "../ai/reasoning";
import type { ApiStandard } from "../ai/types";

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
    expect(anthropic).toEqual(["claude-adaptive", "claude-budget", "minimax", "off"]);
  });

  it("parseThinkingCategory narrows a free-text column, else undefined", () => {
    expect(parseThinkingCategory("minimax")).toBe("minimax");
    expect(parseThinkingCategory("off")).toBe("off");
    expect(parseThinkingCategory("bogus")).toBeUndefined();
    expect(parseThinkingCategory(42)).toBeUndefined();
    expect(parseThinkingCategory(undefined)).toBeUndefined();
  });
});
