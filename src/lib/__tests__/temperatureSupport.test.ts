/**
 * `supportsTemperature` — the single rule behind both the Anthropic adapter's
 * decision to send a temperature and the model editor's decision to show the
 * control at all.
 *
 * Worth pinning as a unit, separate from the wire tests in aiClient: those
 * prove what the adapter sends, and this proves the *editor* asks the same
 * question the adapter answers. A drift between them is a control that quietly
 * stops matching what the request does — which is the failure this predicate
 * was extracted to prevent.
 */
import { describe, expect, it } from "vitest";
import { supportsTemperature } from "../ai/reasoning";
import type { ApiStandard } from "../ai/types";

describe("supportsTemperature", () => {
  it("is true for every non-Anthropic family, whatever the category", () => {
    for (const s of ["openai", "openai_compat", "gemini", "gemini_compat"] as ApiStandard[]) {
      expect(supportsTemperature(s)).toBe(true);
      expect(supportsTemperature(s, "qwen-budget")).toBe(true);
      expect(supportsTemperature(s, "off")).toBe(true);
    }
  });

  it("is false for an undeclared Anthropic model — the ordinary Claude case", () => {
    // An unset category resolves to claude-adaptive, so "no declaration" means
    // thinking is on and the Messages API accepts only temperature 1.
    expect(supportsTemperature("anthropic")).toBe(false);
    expect(supportsTemperature("anthropic_compat")).toBe(false);
  });

  it("is false for every Anthropic category that leaves thinking on", () => {
    for (const c of ["claude-adaptive", "claude-budget", "minimax"] as const) {
      expect(supportsTemperature("anthropic", c)).toBe(false);
    }
  });

  it("is true only once the author declares the model doesn't think", () => {
    expect(supportsTemperature("anthropic", "off")).toBe(true);
    expect(supportsTemperature("anthropic_compat", "off")).toBe(true);
  });
});
