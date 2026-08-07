/**
 * lib/ai/usage — the read side of `token_usage`.
 *
 * The table had four writers and no readers, so nothing ever exercised what
 * comes back out of it. The two things that actually bite are covered here:
 * `SUM()` over an empty group returns NULL (which used to become `NaN` the
 * moment it was added to anything), and the rollup must agree with the rows it
 * is a rollup of.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  formatTokenCount,
  formatUsd,
  rowToBucket,
  sortBuckets,
  sumBuckets,
  windowStartSeconds,
  type UsageBucket,
} from "../ai/usage";

const bucket = (over: Partial<UsageBucket>): UsageBucket => ({
  key: "k",
  calls: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  costUsd: 0,
  ...over,
});

describe("windowStartSeconds", () => {
  // 2026-08-07T00:00:00Z, in the unix seconds the insert sites write.
  const NOW_MS = 1_785_974_400_000;
  const NOW_S = Math.floor(NOW_MS / 1000);

  it("counts back whole days from now", () => {
    expect(windowStartSeconds("7d", NOW_MS)).toBe(NOW_S - 7 * 86_400);
    expect(windowStartSeconds("30d", NOW_MS)).toBe(NOW_S - 30 * 86_400);
  });

  it("returns 0 for 'all', so both callers can use one `created_at >= ?`", () => {
    expect(windowStartSeconds("all", NOW_MS)).toBe(0);
  });

  it("clamps rather than producing a negative cutoff on a badly set clock", () => {
    expect(windowStartSeconds("30d", 0)).toBe(0);
  });
});

describe("rowToBucket", () => {
  it("reads a normal aggregate row", () => {
    expect(
      rowToBucket({
        key: "m1",
        calls: 3,
        prompt_tokens: 100,
        cached_tokens: 20,
        completion_tokens: 50,
        cost_usd: 0.125,
      }),
    ).toEqual(bucket({ key: "m1", calls: 3, promptTokens: 100, cachedTokens: 20, completionTokens: 50, costUsd: 0.125 }));
  });

  it("coerces the NULLs SUM() returns for an empty group instead of letting them become NaN", () => {
    const b = rowToBucket({
      key: "m1",
      calls: 0,
      prompt_tokens: null,
      cached_tokens: null,
      completion_tokens: null,
      cost_usd: null,
    });
    expect(b).toEqual(bucket({ key: "m1" }));
    expect(Number.isNaN(b.costUsd + 1)).toBe(false);
  });

  it("survives a row whose key is missing rather than rendering 'undefined'", () => {
    expect(rowToBucket({ calls: 1 }).key).toBe("");
  });
});

describe("sumBuckets", () => {
  it("adds every column and takes the given key", () => {
    const total = sumBuckets("total", [
      bucket({ key: "a", calls: 2, promptTokens: 10, cachedTokens: 4, completionTokens: 6, costUsd: 0.5 }),
      bucket({ key: "b", calls: 1, promptTokens: 5, cachedTokens: 0, completionTokens: 1, costUsd: 0.25 }),
    ]);
    expect(total).toEqual(
      bucket({ key: "total", calls: 3, promptTokens: 15, cachedTokens: 4, completionTokens: 7, costUsd: 0.75 }),
    );
  });

  it("is zero, not undefined, with nothing recorded", () => {
    expect(sumBuckets("total", [])).toEqual(bucket({ key: "total" }));
  });
});

describe("sortBuckets", () => {
  it("puts the most expensive first", () => {
    const order = sortBuckets([
      bucket({ key: "cheap", costUsd: 0.01 }),
      bucket({ key: "dear", costUsd: 5 }),
      bucket({ key: "mid", costUsd: 1 }),
    ]).map((b) => b.key);
    expect(order).toEqual(["dear", "mid", "cheap"]);
  });

  it("falls back to output tokens so unpriced models still order usefully", () => {
    const order = sortBuckets([
      bucket({ key: "small", completionTokens: 10 }),
      bucket({ key: "big", completionTokens: 9_000 }),
    ]).map((b) => b.key);
    expect(order).toEqual(["big", "small"]);
  });

  it("is total, so identical rows always render in the same order", () => {
    const order = sortBuckets([bucket({ key: "b" }), bucket({ key: "a" })]).map((b) => b.key);
    expect(order).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [bucket({ key: "a", costUsd: 1 }), bucket({ key: "b", costUsd: 2 })];
    sortBuckets(input);
    expect(input.map((b) => b.key)).toEqual(["a", "b"]);
  });
});

describe("formatting", () => {
  it("keeps token counts compact", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_500)).toBe("1.5k");
    expect(formatTokenCount(42_000)).toBe("42k");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
    expect(formatTokenCount(12_000_000)).toBe("12M");
  });

  it("never renders a real sub-cent cost as $0.00", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(0.00001)).toBe("<$0.0001");
    expect(formatUsd(12.5)).toBe("$12.50");
  });

  it("treats a NaN that slipped through as zero rather than printing it", () => {
    expect(formatTokenCount(NaN)).toBe("0");
    expect(formatUsd(NaN)).toBe("$0");
  });
});
