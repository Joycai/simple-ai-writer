import { describe, it, expect } from "vitest";
import {
  planContextBudget,
  reflowMemoryBudget,
  fixedContextChars,
  outputReserveTokens,
  measureCharsPerToken,
  FALLBACK_CHARS_PER_TOKEN,
  BOOK_PRIOR_BUDGET_CHARS,
  CONTEXT_UTILIZATION_MAX,
  type ContextBudgetInput,
} from "../context/budget";
import { estimateTextTokens } from "../ai/tokenEstimate";
import { MEMORY_BUDGET_CHARS } from "../context/memory";

/** Default fixture uses charsPerToken = 1 (the CJK case) for round numbers. */
function input(overrides: Partial<ContextBudgetInput> = {}): ContextBudgetInput {
  return {
    contextSize: 128_000,
    utilization: 0.5,
    loreBudgetTokens: 600,
    fixedChars: 3_000,
    hasMemory: true,
    includeBookContext: true,
    charsPerToken: 1,
    ...overrides,
  };
}

describe("measureCharsPerToken", () => {
  it("returns the safe fallback when there's too little text to measure", () => {
    expect(measureCharsPerToken("短文本")).toBe(FALLBACK_CHARS_PER_TOKEN);
    expect(measureCharsPerToken("")).toBe(FALLBACK_CHARS_PER_TOKEN);
  });

  it("reports ~1 char/token for Chinese prose", () => {
    const ratio = measureCharsPerToken("他推开门，风雪灌了进来。".repeat(40));
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.3);
  });

  it("reports ~4 chars/token for Latin-script prose", () => {
    const ratio = measureCharsPerToken("He pushed the door open and the snow came in. ".repeat(20));
    expect(ratio).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThanOrEqual(4);
  });

  it("agrees with the pre-flight estimator, so a full plan can't be rejected", () => {
    // The whole point of measuring: chars planned ÷ ratio must not undercount
    // what lib/ai/tokenEstimate will charge for the same text.
    const prose = "夜色深沉，长街寂寂，只有更夫的梆子声。".repeat(50);
    const ratio = measureCharsPerToken(prose);
    const plannedTokens = prose.length / ratio;
    expect(plannedTokens).toBeGreaterThanOrEqual(estimateTextTokens(prose) * 0.95);
  });
});

describe("outputReserveTokens", () => {
  it("floors at 2000 tokens for tasks that declare no reply length", () => {
    expect(outputReserveTokens(0, 1)).toBe(2_000);
  });

  it("scales past the floor for long requested replies", () => {
    // 6000 CJK chars ≈ 6000 tokens, doubled for estimate slop.
    expect(outputReserveTokens(6_000, 1)).toBe(12_000);
  });

  it("charges a Latin manuscript less for the same reply length", () => {
    expect(outputReserveTokens(6_000, 4)).toBe(3_000);
  });
});

describe("planContextBudget — static fallback", () => {
  it("uses the historical constants when the model declares no window", () => {
    const plan = planContextBudget(input({ contextSize: undefined }));
    expect(plan.dynamic).toBe(false);
    expect(plan.memoryChars).toBe(MEMORY_BUDGET_CHARS);
    expect(plan.bookPriorChars).toBe(BOOK_PRIOR_BUDGET_CHARS);
    // The author's lore setting still applies — it never depended on the window.
    expect(plan.loreChars).toBe(600);
  });

  it("zeroes the book layer for non-continuation tasks", () => {
    const plan = planContextBudget(input({ contextSize: 0, includeBookContext: false }));
    expect(plan.bookPriorChars).toBe(0);
    expect(plan.memoryChars).toBe(MEMORY_BUDGET_CHARS);
  });
});

describe("planContextBudget — dynamic", () => {
  it("honors the lore setting and splits the leftover 60/40", () => {
    const plan = planContextBudget(input());
    expect(plan.dynamic).toBe(true);
    expect(plan.loreChars).toBe(600);

    // 128k × 0.5 = 64k, minus a 2k reply reserve = 62k input tokens.
    expect(plan.inputCeilingTokens).toBe(62_000);
    expect(plan.reservedOutputTokens).toBe(2_000);

    const leftover = 62_000 - 3_000 - 600;
    expect(plan.bookPriorChars).toBe(Math.floor(leftover * 0.4));
    expect(plan.memoryChars).toBe(leftover - Math.floor(leftover * 0.4));
  });

  it("gives a Latin manuscript proportionally more chars for the same window", () => {
    const cjk = planContextBudget(input({ charsPerToken: 1 }));
    const latin = planContextBudget(input({ charsPerToken: 4 }));
    expect(latin.memoryChars).toBeGreaterThan(cjk.memoryChars * 3);
    expect(latin.loreChars).toBe(2_400); // 600 tokens × 4 chars
  });

  it("grows the recap layers with the window", () => {
    const small = planContextBudget(input({ contextSize: 16_384 }));
    const large = planContextBudget(input({ contextSize: 1_048_576 }));
    expect(large.memoryChars).toBeGreaterThan(small.memoryChars * 10);
    expect(large.bookPriorChars).toBeGreaterThan(small.bookPriorChars * 10);
  });

  it("caps total spend at the utilization setting", () => {
    const half = planContextBudget(input({ utilization: 0.5 }));
    const nearly = planContextBudget(input({ utilization: CONTEXT_UTILIZATION_MAX }));
    expect(nearly.inputCeilingTokens).toBeGreaterThan(half.inputCeilingTokens);
    expect(half.inputCeilingTokens).toBe(Math.floor(128_000 * 0.5) - 2_000);
  });

  it("clamps an out-of-range utilization instead of trusting it", () => {
    const plan = planContextBudget(input({ utilization: 99 }));
    expect(plan.inputCeilingTokens).toBe(
      Math.floor(128_000 * CONTEXT_UTILIZATION_MAX) - 2_000,
    );
  });

  it("gives the whole leftover to memory when there is no book context", () => {
    const plan = planContextBudget(input({ includeBookContext: false }));
    expect(plan.bookPriorChars).toBe(0);
    expect(plan.memoryChars).toBe(62_000 - 3_000 - 600);
  });

  it("gives the whole leftover to the book layer when the document has no memory", () => {
    const plan = planContextBudget(input({ hasMemory: false }));
    expect(plan.memoryChars).toBe(0);
    expect(plan.bookPriorChars).toBe(62_000 - 3_000 - 600);
  });

  it("trims lore rather than overflowing when the window can't hold it", () => {
    // 16k × 0.25 = 4096, minus the 2k reserve = 2096 tokens of room, of which
    // 1000 is fixed cost — far less than the 32k-token lore request.
    const plan = planContextBudget(
      input({ contextSize: 16_384, utilization: 0.25, loreBudgetTokens: 32_000, fixedChars: 1_000 }),
    );
    expect(plan.loreChars).toBe(1_096);
    expect(plan.memoryChars).toBe(0);
    expect(plan.bookPriorChars).toBe(0);
  });

  it("never returns negative budgets when fixed costs alone exceed the window", () => {
    const plan = planContextBudget(input({ contextSize: 16_384, fixedChars: 500_000 }));
    expect(plan.loreChars).toBe(0);
    expect(plan.memoryChars).toBe(0);
    expect(plan.bookPriorChars).toBe(0);
  });
});

describe("reflowMemoryBudget", () => {
  it("hands the book layer's unspent share to memory", () => {
    const plan = planContextBudget(input());
    const reflowed = reflowMemoryBudget(plan, 1_000);
    expect(reflowed).toBe(plan.memoryChars + plan.bookPriorChars - 1_000);
  });

  it("adds nothing when the book layer spent its whole share", () => {
    const plan = planContextBudget(input());
    expect(reflowMemoryBudget(plan, plan.bookPriorChars)).toBe(plan.memoryChars);
  });

  it("does not go negative if the book layer overshot", () => {
    const plan = planContextBudget(input());
    expect(reflowMemoryBudget(plan, plan.bookPriorChars + 5_000)).toBe(plan.memoryChars);
  });

  it("leaves static plans alone — their budgets aren't a shared pool", () => {
    const plan = planContextBudget(input({ contextSize: undefined }));
    expect(reflowMemoryBudget(plan, 0)).toBe(MEMORY_BUDGET_CHARS);
  });
});

describe("fixedContextChars", () => {
  it("sums every non-plannable part, treating omitted ones as zero", () => {
    expect(
      fixedContextChars({
        systemPromptChars: 100,
        recentWindowChars: 2_400,
        taskInstructionChars: 50,
        selectionChars: 10,
      }),
    ).toBe(2_560);

    expect(
      fixedContextChars({
        systemPromptChars: 100,
        recentWindowChars: 2_400,
        taskInstructionChars: 50,
        selectionChars: 10,
        outlineChars: 200,
        knowledgeChars: 300,
        prevChapterTailChars: 2_500,
      }),
    ).toBe(5_560);
  });
});
