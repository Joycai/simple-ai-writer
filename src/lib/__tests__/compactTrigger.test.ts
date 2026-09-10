/**
 * The author-set compaction trigger (docs/feature/agent/compact-threshold-plan.md
 * §B.0): the lowest of three lines, the post-fold target that scales with it,
 * and the two consumers that must agree on the number — `planFold` (where the
 * fold fires) and `computeContextBreakdown` (where the bar draws the mark).
 */
import { describe, expect, it } from "vitest";
import {
  COMPACT_TRIGGER,
  RETAIN_TARGET,
  compactTriggerFor,
  createSessionMeta,
  noteTurnStart,
  planFold,
  retainTargetFor,
  type ChatSessionMeta,
} from "../agent/compact";
import { computeContextBreakdown } from "../agent/contextBreakdown";
import {
  COMPACT_TRIGGER_RATIO_DEFAULT,
  COMPACT_TRIGGER_TOKENS_DEFAULT,
} from "../context/budget";
import { estimateMessagesTokens } from "../ai/tokenEstimate";
import type { StreamMessage } from "../ai/types";

const DEFAULTS = {
  triggerTokens: COMPACT_TRIGGER_TOKENS_DEFAULT,
  triggerRatio: COMPACT_TRIGGER_RATIO_DEFAULT,
};

describe("compactTriggerFor", () => {
  it("at the slider defaults the classic line wins — behaviour unchanged", () => {
    const t = compactTriggerFor({ contextSize: 200_000, messageCeiling: 95_000, ...DEFAULTS });
    expect(t).toEqual({ tokens: Math.floor(95_000 * COMPACT_TRIGGER), boundBy: "ceiling" });
  });

  it("the ratio line wins on a 256k model at 50% when the ceiling allows it", () => {
    // 窗口占用 90%: message ceiling ≈ 230k → classic line 161k > 128k.
    const t = compactTriggerFor({
      contextSize: 256_000, messageCeiling: 230_000, triggerTokens: 512_000, triggerRatio: 0.5,
    });
    expect(t).toEqual({ tokens: 128_000, boundBy: "ratio" });
  });

  it("the token line wins on a 1M model set to 256k", () => {
    const t = compactTriggerFor({
      contextSize: 1_000_000, messageCeiling: 900_000, triggerTokens: 256_000, triggerRatio: 0.5,
    });
    expect(t).toEqual({ tokens: 256_000, boundBy: "tokens" });
  });

  it("under the default 窗口占用 of 50% the ratio slider's whole range loses (§2.3)", () => {
    // 200k window × 0.5 utilization − reserve − schemas ≈ 95k → classic line 66.5k.
    // Even the slider's floor (50% → 100k) sits above that.
    const t = compactTriggerFor({
      contextSize: 200_000, messageCeiling: 95_000, triggerTokens: 512_000, triggerRatio: 0.5,
    });
    expect(t.boundBy).toBe("ceiling");
    expect(t.tokens).toBeLessThan(100_000);
  });

  it("without a declared window only tokens and ceiling compete", () => {
    const assumed = compactTriggerFor({ messageCeiling: 30_000, triggerTokens: 512_000, triggerRatio: 0.5 });
    expect(assumed).toEqual({ tokens: 21_000, boundBy: "assumed" });
    const low = compactTriggerFor({ contextSize: 0, messageCeiling: 30_000, triggerTokens: 8_192, triggerRatio: 0.5 });
    expect(low).toEqual({ tokens: 8_192, boundBy: "tokens" });
  });

  it("a non-positive ceiling yields a zero line rather than a negative one", () => {
    expect(compactTriggerFor({ contextSize: 8_000, messageCeiling: 0, ...DEFAULTS }).tokens).toBe(0);
  });
});

describe("retainTargetFor", () => {
  it("keeps the classic 0.70 → 0.45 gap as a ratio of the trigger", () => {
    const ceiling = 100_000;
    const classic = ceiling * COMPACT_TRIGGER;
    expect(retainTargetFor(classic)).toBeCloseTo(ceiling * RETAIN_TARGET, 6);
    // Pulled down to 16k the target follows, staying under the trigger.
    expect(retainTargetFor(16_000)).toBeLessThan(16_000);
    expect(retainTargetFor(16_000)).toBeCloseTo(16_000 * (RETAIN_TARGET / COMPACT_TRIGGER), 6);
  });
});

// ── planFold + the bar read the same number ──────────────────────────────────

function session(turnCount: number, charsPerMessage: number) {
  const meta: ChatSessionMeta = createSessionMeta();
  const history: StreamMessage[] = [{ role: "system", content: "系统提示" }];
  for (let i = 0; i < turnCount; i++) {
    const q: StreamMessage = { role: "user", content: "问".repeat(charsPerMessage) };
    noteTurnStart(meta, q);
    history.push(q, { role: "assistant", content: "答".repeat(charsPerMessage) });
  }
  return { history, meta };
}

describe("planFold with an author-set trigger", () => {
  it("fires under a line the classic trigger would have left alone, and folds to the scaled target", () => {
    const { history, meta } = session(12, 800); // ≈ 20k tokens of CJK
    const ceiling = 100_000;
    expect(estimateMessagesTokens(history)).toBeLessThan(ceiling * COMPACT_TRIGGER);
    expect(planFold(history, meta, ceiling)).toBeNull();

    const plan = planFold(history, meta, ceiling, { triggerTokens: 16_000 });
    expect(plan).not.toBeNull();
    expect(plan!.fold.length).toBeGreaterThan(0);
    // The walk-back un-folds turns only while the *scaled* target has room —
    // at the classic 45k target it would keep everything and fold nothing.
    expect(plan!.projectedTokens).toBeLessThanOrEqual(retainTargetFor(16_000) + 1);
  });

  it("with the trigger at the classic line the plan is the classic plan", () => {
    const { history, meta } = session(30, 800);
    const ceiling = 40_000;
    const classic = planFold(history, meta, ceiling);
    const explicit = planFold(history, meta, ceiling, { triggerTokens: ceiling * COMPACT_TRIGGER });
    expect(explicit?.fold.length).toBe(classic?.fold.length);
    expect(explicit?.projectedTokens).toBe(classic?.projectedTokens);
  });

  it("force ignores the trigger entirely", () => {
    const { history, meta } = session(4, 10);
    expect(planFold(history, meta, 100_000, { triggerTokens: 512_000 })).toBeNull();
    expect(planFold(history, meta, 100_000, { triggerTokens: 512_000, force: true })).not.toBeNull();
  });
});

describe("computeContextBreakdown with compaction prefs", () => {
  const TOOLS = 3_000;

  it("draws the mark at the resolved line and warns against it", () => {
    const { history, meta } = session(6, 600);
    const ceiling = 60_000;
    const messageCeiling = ceiling - TOOLS;
    const prefs = { autoCompact: true, triggerTokens: 8_192, triggerRatio: 0.8 };
    const ctx = computeContextBreakdown(history, meta, TOOLS, ceiling, 128_000, prefs);
    const trigger = compactTriggerFor({ contextSize: 128_000, messageCeiling, ...prefs });
    expect(trigger.boundBy).toBe("tokens");
    expect(ctx.compactBoundBy).toBe("tokens");
    // Mark = schemas + trigger, on an axis that spans the ceiling.
    const span = Math.max(ctx.usedTokens, ceiling);
    expect(ctx.compactMarkerPct).toBeCloseTo(((TOOLS + trigger.tokens) * 100) / span, 6);
    // The warning keys on the same line the mark is drawn at.
    const messageTokens = ctx.usedTokens - TOOLS;
    expect(ctx.willCompact).toBe(messageTokens > trigger.tokens);
  });

  it("autoCompact off keeps the mark and the warning, and says so", () => {
    const { history, meta } = session(6, 600);
    const on = computeContextBreakdown(history, meta, TOOLS, 60_000, 128_000,
      { autoCompact: true, triggerTokens: 8_192, triggerRatio: 0.8 });
    const off = computeContextBreakdown(history, meta, TOOLS, 60_000, 128_000,
      { autoCompact: false, triggerTokens: 8_192, triggerRatio: 0.8 });
    expect(off.compactMarkerPct).toBe(on.compactMarkerPct);
    expect(off.willCompact).toBe(on.willCompact);
    expect(off.autoCompact).toBe(false);
    expect(on.autoCompact).toBe(true);
  });

  it("without prefs the bar is the classic bar", () => {
    const { history, meta } = session(6, 600);
    const ctx = computeContextBreakdown(history, meta, TOOLS, 60_000, 128_000);
    const messageCeiling = 60_000 - TOOLS;
    const span = Math.max(ctx.usedTokens, 60_000);
    expect(ctx.compactMarkerPct).toBeCloseTo(((TOOLS + messageCeiling * COMPACT_TRIGGER) * 100) / span, 6);
    expect(ctx.autoCompact).toBe(true);
    expect(ctx.compactBoundBy).toBe("ceiling");
  });
});
