import { describe, it, expect } from "vitest";
import {
  planContextBudget,
  reflowMemoryBudget,
  fixedContextChars,
  outputReserveTokens,
  measureCharsPerToken,
  FALLBACK_CHARS_PER_TOKEN,
  BOOK_PRIOR_BUDGET_CHARS,
  RECENT_WINDOW_MIN_CHARS,
  STATIC_LORE_BUDGET_MAX_TOKENS,
  CONTEXT_UTILIZATION_MAX,
  CONTEXT_UTILIZATION_MIN,
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

// 128k × 0.5 = 64k, minus a 2k reply reserve = 62k input tokens = 62k chars at
// ratio 1; minus 3k fixed = 59k to divide, minus the 2.4k verbatim floor and the
// 600-char lore setting = 56k of true leftover, half of which grows the window.
const CEILING = 62_000;
const LEFTOVER = CEILING - 3_000 - RECENT_WINDOW_MIN_CHARS - 600;
const RECAP_POOL = LEFTOVER - Math.floor(LEFTOVER * 0.5);

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

  it("never reserves more than the model can actually emit", () => {
    // A 128k-window model capped at 4k output gains nothing from a 12k reserve;
    // the surplus is window the prompt could have used.
    expect(outputReserveTokens(6_000, 1, 4_096)).toBe(4_096);
  });

  it("lets the cap win over the floor for a very short-output model", () => {
    expect(outputReserveTokens(0, 1, 1_000)).toBe(1_000);
  });

  it("ignores an unset or nonsensical cap", () => {
    expect(outputReserveTokens(0, 1, undefined)).toBe(2_000);
    expect(outputReserveTokens(0, 1, 0)).toBe(2_000);
  });

  it("does not inflate a reserve that is already below the cap", () => {
    expect(outputReserveTokens(0, 1, 65_536)).toBe(2_000);
  });
});

describe("planContextBudget — max-output cap", () => {
  it("hands the unreservable surplus back to the prompt", () => {
    const uncapped = planContextBudget(input({ contextSize: 100_000, replyChars: 20_000 }));
    const capped = planContextBudget(
      input({ contextSize: 100_000, replyChars: 20_000, maxOutputTokens: 4_096 }),
    );
    expect(uncapped.reservedOutputTokens).toBe(40_000);
    expect(capped.reservedOutputTokens).toBe(4_096);
    expect(capped.inputCeilingTokens).toBe(uncapped.inputCeilingTokens + 35_904);
  });
});

describe("planContextBudget — static fallback", () => {
  it("uses the historical constants when the model declares no window", () => {
    const plan = planContextBudget(input({ contextSize: undefined }));
    expect(plan.dynamic).toBe(false);
    expect(plan.memoryChars).toBe(MEMORY_BUDGET_CHARS);
    expect(plan.bookPriorChars).toBe(BOOK_PRIOR_BUDGET_CHARS);
    expect(plan.recentWindowChars).toBe(RECENT_WINDOW_MIN_CHARS);
    // The author's lore setting still applies — it never depended on the window.
    expect(plan.loreChars).toBe(600);
  });

  it("zeroes the book layer for non-continuation tasks", () => {
    const plan = planContextBudget(input({ contextSize: 0, includeBookContext: false }));
    expect(plan.bookPriorChars).toBe(0);
    expect(plan.memoryChars).toBe(MEMORY_BUDGET_CHARS);
  });

  it("caps lore hard — nothing downstream gates a request with no declared window", () => {
    // lib/ai/index.ts only pre-flights when contextSize > 0, so an uncapped
    // 32k-token lore setting here would build a prompt no endpoint accepts.
    const plan = planContextBudget(input({ contextSize: undefined, loreBudgetTokens: 32_000 }));
    expect(plan.loreChars).toBe(STATIC_LORE_BUDGET_MAX_TOKENS);
  });

  it("still honors a setting below the static cap", () => {
    const plan = planContextBudget(input({ contextSize: undefined, loreBudgetTokens: 900 }));
    expect(plan.loreChars).toBe(900);
  });

  it("honors an explicit verbatim-window choice", () => {
    const plan = planContextBudget(input({ contextSize: undefined, recentWindowChars: 500 }));
    expect(plan.recentWindowChars).toBe(500);
  });
});

describe("planContextBudget — dynamic", () => {
  it("honors the lore setting and splits the recap pool 60/40", () => {
    const plan = planContextBudget(input());
    expect(plan.dynamic).toBe(true);
    expect(plan.loreChars).toBe(600);
    expect(plan.inputCeilingTokens).toBe(CEILING);
    expect(plan.reservedOutputTokens).toBe(2_000);

    expect(plan.bookPriorChars).toBe(Math.floor(RECAP_POOL * 0.4));
    expect(plan.memoryChars).toBe(RECAP_POOL - Math.floor(RECAP_POOL * 0.4));
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

  it("gives the whole recap pool to memory when there is no book context", () => {
    const plan = planContextBudget(input({ includeBookContext: false }));
    expect(plan.bookPriorChars).toBe(0);
    expect(plan.memoryChars).toBe(RECAP_POOL);
  });

  it("gives the whole recap pool to the book layer when the document has no memory", () => {
    const plan = planContextBudget(input({ hasMemory: false }));
    expect(plan.memoryChars).toBe(0);
    expect(plan.bookPriorChars).toBe(RECAP_POOL);
  });

  it("trims lore rather than overflowing when the window can't hold it", () => {
    // 16k at the highest utilization the app offers, minus the 2k reserve; 1000
    // is fixed and 2400 is the verbatim floor, leaving far less than the
    // 32k-token lore request — so lore is cut to fit instead of blowing the
    // window.
    const plan = planContextBudget(
      input({
        contextSize: 16_384, utilization: CONTEXT_UTILIZATION_MAX,
        loreBudgetTokens: 32_000, fixedChars: 1_000,
      }),
    );
    const room = Math.floor(16_384 * CONTEXT_UTILIZATION_MAX) - 2_000 - 1_000 - RECENT_WINDOW_MIN_CHARS;
    expect(plan.loreChars).toBe(room);
    expect(plan.memoryChars).toBe(0);
    expect(plan.bookPriorChars).toBe(0);
  });

  it("keeps the verbatim window ahead of lore when the window is tiny", () => {
    // Continuing without the text you're continuing *from* is useless, so the
    // recent-window floor outranks the lore block — and is itself trimmed to fit.
    // 8k at the lowest utilization the app offers = a 4096-token ceiling.
    const plan = planContextBudget(
      input({
        contextSize: 8_192, utilization: CONTEXT_UTILIZATION_MIN,
        loreBudgetTokens: 32_000, fixedChars: 1_000,
      }),
    );
    expect(plan.recentWindowChars).toBe(1_096);
    expect(plan.loreChars).toBe(0);
    expect(plan.memoryChars).toBe(0);
  });

  it("never returns negative budgets when fixed costs alone exceed the window", () => {
    const plan = planContextBudget(input({ contextSize: 16_384, fixedChars: 500_000 }));
    expect(plan.loreChars).toBe(0);
    expect(plan.memoryChars).toBe(0);
    expect(plan.bookPriorChars).toBe(0);
    expect(plan.recentWindowChars).toBe(0);
  });
});

describe("planContextBudget — the verbatim recent window", () => {
  it("grows with the window when the task has no picker", () => {
    const plan = planContextBudget(input());
    expect(plan.recentWindowChars).toBeGreaterThan(RECENT_WINDOW_MIN_CHARS);
    expect(plan.recentWindowChars).toBe(RECENT_WINDOW_MIN_CHARS + Math.floor(LEFTOVER * 0.5));
  });

  it("prefers verbatim prose over a summary of it", () => {
    const plan = planContextBudget(input());
    expect(plan.recentWindowChars).toBeGreaterThan(plan.memoryChars);
  });

  it("honors an explicit picker value exactly and never grows it", () => {
    const plan = planContextBudget(input({ recentWindowChars: 500 }));
    expect(plan.recentWindowChars).toBe(500);
    // The space it declined goes to the recaps, not back to the window.
    expect(plan.memoryChars + plan.bookPriorChars).toBe(CEILING - 3_000 - 500 - 600);
  });

  it("treats an explicit 0 as 'send no recent context', not as unset", () => {
    const plan = planContextBudget(input({ recentWindowChars: 0 }));
    expect(plan.recentWindowChars).toBe(0);
  });

  it("never reserves more of the window than the document can fill", () => {
    const plan = planContextBudget(input({ availableRecentChars: 3_000 }));
    expect(plan.recentWindowChars).toBe(3_000);
    // …and the space it couldn't use is still spent, not lost.
    const pool = LEFTOVER - (3_000 - RECENT_WINDOW_MIN_CHARS);
    expect(plan.memoryChars + plan.bookPriorChars).toBe(pool);
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
        taskInstructionChars: 50,
        selectionChars: 10,
      }),
    ).toBe(160);

    expect(
      fixedContextChars({
        systemPromptChars: 100,
        taskInstructionChars: 50,
        selectionChars: 10,
        outlineChars: 200,
        knowledgeChars: 300,
        prevChapterTailChars: 2_500,
      }),
    ).toBe(3_160);
  });
});

describe("tool schemas as a budget layer", () => {
  it("comes off the message ceiling, not the input ceiling", () => {
    const plan = planContextBudget(input({ toolSchemaTokens: 8_000 }));
    // The denominator the panel draws against is unchanged — the toolset reads
    // as space taken, not as a ceiling that quietly shrank.
    expect(plan.inputCeilingTokens).toBe(CEILING);
    expect(plan.messageCeilingTokens).toBe(CEILING - 8_000);
    expect(plan.toolSchemaTokens).toBe(8_000);
  });

  it("shrinks the plannable layers by exactly what the tools cost", () => {
    const without = planContextBudget(input());
    const withTools = planContextBudget(input({ toolSchemaTokens: 8_000 }));
    const layers = (p: typeof without) =>
      p.loreChars + p.memoryChars + p.bookPriorChars + p.recentWindowChars;
    // charsPerToken is 1 in this fixture, so 8k tokens is 8k chars of layers.
    expect(layers(without) - layers(withTools)).toBe(8_000);
  });

  it("defaults to zero, so a toolless task plans exactly as before", () => {
    expect(planContextBudget(input())).toEqual(
      planContextBudget(input({ toolSchemaTokens: 0 })),
    );
  });

  it("clamps a toolset larger than the whole ceiling instead of going negative", () => {
    // Not a budget this planner can fix — the pre-flight context gate is where
    // that has to surface. All this must do is refuse to hand out char budgets
    // it doesn't have.
    const plan = planContextBudget(input({ toolSchemaTokens: 500_000 }));
    expect(plan.messageCeilingTokens).toBe(0);
    expect(plan.toolSchemaTokens).toBe(CEILING);
    expect(plan.loreChars).toBe(0);
    expect(plan.memoryChars).toBe(0);
    expect(plan.bookPriorChars).toBe(0);
    expect(plan.recentWindowChars).toBe(0);
  });

  it("reports zeros on the static fallback plan", () => {
    const plan = planContextBudget(input({ contextSize: 0, toolSchemaTokens: 8_000 }));
    expect(plan.dynamic).toBe(false);
    expect(plan.messageCeilingTokens).toBe(0);
    expect(plan.toolSchemaTokens).toBe(0);
  });
});
