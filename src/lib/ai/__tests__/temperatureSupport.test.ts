/**
 * The `temperature` capability — the single rule behind both the adapters'
 * decision to send a temperature and the model editor's decision to show the
 * control at all (the rule row in `capability/rules.ts`, the condition in
 * `capability/conditions.ts`).
 *
 * Worth pinning as a unit, separate from the wire tests in aiClient: those
 * prove what the adapter sends, and this proves the *editor* asks the same
 * question the adapter answers. A drift between them is a control that quietly
 * stops matching what the request does — which is the failure the shared rule
 * exists to prevent. Both ask `temperatureReaches`; the drawer passes the
 * category the form resolves to and the form's effort. The first case asks it
 * that way and compares, cell by cell, with what `planRequest` — where the
 * adapters read it — decides, so a planner that stops asking it goes red.
 */
import { describe, expect, it } from "vitest";
import { planRequest } from "../capability/plan";
import { hasCapability, resolveThinkingCategory, temperatureReaches } from "../capabilities";
import { wireOf } from "../platforms";
import { THINKING_CATEGORIES, type ReasoningEffort, type ThinkingCategoryId } from "../reasoning";
import type { ApiStandard } from "../types";

const CATEGORIES = [undefined, ...Object.keys(THINKING_CATEGORIES)] as (ThinkingCategoryId | undefined)[];
const EFFORTS: readonly ReasoningEffort[] = ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
const STANDARDS: readonly ApiStandard[] = [
  "openai", "openai_compat", "openai_responses", "gemini", "gemini_compat", "anthropic", "anthropic_compat",
];
const BASE = "https://gateway.example/v1";

/** The drawer's question: the category the form resolves to, the form's effort. */
function drawerShows(standard: ApiStandard, thinkingCategory: ThinkingCategoryId | undefined, effort: ReasoningEffort): boolean {
  const category = resolveThinkingCategory({ thinkingCategory }, standard);
  return temperatureReaches(wireOf({ baseUrl: BASE, standard }), {}, category, effort);
}

/** The adapters' answer: whether the plan carries the row's temperature. */
function planSends(standard: ApiStandard, thinkingCategory: ThinkingCategoryId | undefined, effort: ReasoningEffort): boolean {
  return planRequest({ standard, baseUrl: BASE, modelId: "house-model", thinkingCategory, reasoningEffort: effort, temperature: 0.4 })
    .temperature !== undefined;
}

describe("temperature", () => {
  it("the drawer shows the field exactly where the request sends it", () => {
    for (const s of STANDARDS) {
      for (const c of CATEGORIES) {
        for (const e of EFFORTS) expect(drawerShows(s, c, e), `${s} ${c ?? "auto"} ${e}`).toBe(planSends(s, c, e));
      }
    }
  });

  it("is sent on every non-Anthropic family, whatever the category and effort", () => {
    for (const s of ["openai", "openai_compat", "gemini", "gemini_compat", "openai_responses"] as ApiStandard[]) {
      for (const c of CATEGORIES) for (const e of EFFORTS) expect(planSends(s, c, e), `${s} ${c} ${e}`).toBe(true);
    }
  });

  it("is not sent for an undeclared Anthropic model — the ordinary Claude case", () => {
    // An unset category resolves to claude-adaptive: thinking is on, and the
    // Messages API accepts only temperature 1.
    for (const e of EFFORTS) expect(planSends("anthropic", undefined, e), e).toBe(false);
  });

  it("is not sent where the category thinks, or its off is only its lowest level", () => {
    for (const c of ["claude-adaptive", "claude-budget"] as const) {
      for (const e of EFFORTS) expect(planSends("anthropic_compat", c, e), `${c} ${e}`).toBe(false);
    }
  });

  it("is sent on the `off` category, and on an off that was measured heeding it", () => {
    for (const e of EFFORTS) expect(planSends("anthropic", "off", e), e).toBe(true);
    // 火山方舟's Anthropic route: 0.01 collapses the picks with thinking off,
    // nothing collapses with it on (landscape.md §7 第十二个样本「B6 补测」).
    expect(planSends("anthropic_compat", "doubao-switch", "off")).toBe(true);
    for (const e of EFFORTS.filter((x) => x !== "off")) expect(planSends("anthropic_compat", "doubao-switch", e), e).toBe(false);
  });

  it("is not sent on MiniMax's off — it switches thinking off and still ignores the value", () => {
    // Same spelling as doubao-switch; measured taking the field with a 200 and
    // no effect (landscape.md §7 第四个样本「B6 补测」).
    for (const e of EFFORTS) expect(planSends("anthropic_compat", "minimax", e), e).toBe(false);
  });

  it("reads an unresolved request as not heard — the safe default", () => {
    expect(hasCapability("temperature", { platform: "anthropic", standard: "anthropic" })).toBe(false);
  });

  it("has the heeded-while-off fact only on categories whose off really is off", () => {
    for (const cat of Object.values(THINKING_CATEGORIES)) {
      if (cat.temperatureWhenOff) expect(cat.offSpelling, cat.id).toBe("disable");
    }
  });
});
