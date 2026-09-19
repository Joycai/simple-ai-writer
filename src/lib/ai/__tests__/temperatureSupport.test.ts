/**
 * The `temperature` capability — the single rule behind both the Anthropic
 * adapter's decision to send a temperature and the model editor's decision to
 * show the control at all (the rule row in lib/ai/capabilities.ts).
 *
 * Worth pinning as a unit, separate from the wire tests in aiClient: those
 * prove what the adapter sends, and this proves the *editor* asks the same
 * question the adapter answers. A drift between them is a control that quietly
 * stops matching what the request does — which is the failure the shared rule
 * exists to prevent.
 *
 * Both askers pass the *resolved* category, so this does too; the table reads
 * an absent one as the family default (thinking), which one case below pins.
 */
import { describe, expect, it } from "vitest";
import { hasCapability } from "../capabilities";
import { wireOf } from "../platforms";
import { resolveThinkingCategory, type ThinkingCategoryId } from "../reasoning";
import type { ApiStandard } from "../types";

function temperatureReaches(standard: ApiStandard, thinkingCategory?: ThinkingCategoryId): boolean {
  const category = resolveThinkingCategory({ thinkingCategory }, standard);
  return hasCapability("temperature", wireOf({ baseUrl: "", standard }), { thinkingCategory: category.id });
}

describe("temperature", () => {
  it("is true for every non-Anthropic family, whatever the category", () => {
    for (const s of ["openai", "openai_compat", "gemini", "gemini_compat", "openai_responses"] as ApiStandard[]) {
      expect(temperatureReaches(s)).toBe(true);
      expect(temperatureReaches(s, "qwen-budget")).toBe(true);
      expect(temperatureReaches(s, "off")).toBe(true);
    }
  });

  it("is false for an undeclared Anthropic model — the ordinary Claude case", () => {
    // An unset category resolves to claude-adaptive, so "no declaration" means
    // thinking is on and the Messages API accepts only temperature 1.
    expect(temperatureReaches("anthropic")).toBe(false);
    expect(temperatureReaches("anthropic_compat")).toBe(false);
  });

  it("is false for every Anthropic category that leaves thinking on", () => {
    for (const c of ["claude-adaptive", "claude-budget", "minimax"] as const) {
      expect(temperatureReaches("anthropic", c)).toBe(false);
    }
  });

  it("reads an unresolved (absent) category as thinking — the safe default", () => {
    expect(hasCapability("temperature", { platform: "anthropic", standard: "anthropic" })).toBe(false);
  });

  it("is true only once the author declares the model doesn't think", () => {
    expect(temperatureReaches("anthropic", "off")).toBe(true);
    expect(temperatureReaches("anthropic_compat", "off")).toBe(true);
  });
});
