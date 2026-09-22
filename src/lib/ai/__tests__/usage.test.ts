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
  sortUsageBuckets,
  sumBuckets,
  windowStartSeconds,
  type UsageBucket,
} from "../usage";

const bucket = (over: Partial<UsageBucket>): UsageBucket => ({
  key: "k",
  calls: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  outputUnits: 0,
  uncovered: 0,
  costUsd: 0,
  costInput: 0,
  costCache: 0,
  costOutput: 0,
  costCount: 0,
  costDuration: 0,
  costOther: 0,
  costUnsplit: 0,
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

  it("snaps 'today' to local midnight rather than counting back 24 hours", () => {
    const midnight = new Date(NOW_MS);
    midnight.setHours(0, 0, 0, 0);
    const start = windowStartSeconds("today", NOW_MS);
    expect(start).toBe(Math.floor(midnight.getTime() / 1000));
    // A run from earlier the same local day is inside the window; one from
    // just before midnight is not.
    expect(start).toBeLessThanOrEqual(Math.floor(NOW_MS / 1000));
    expect(windowStartSeconds("today", midnight.getTime() - 1000)).toBeLessThan(start);
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

  it("reads the six cost segments and the unsplit remainder", () => {
    const b = rowToBucket({
      key: "m1", calls: 4, cost_usd: 1,
      cost_input: 0.2, cost_cache: 0.05, cost_output: 0.5,
      cost_count: 0.1, cost_duration: 0.05, cost_other: 0.02,
      cost_unsplit: 0.08,
    });
    expect(b.costInput).toBe(0.2);
    expect(b.costCache).toBe(0.05);
    expect(b.costOutput).toBe(0.5);
    expect(b.costCount).toBe(0.1);
    expect(b.costDuration).toBe(0.05);
    expect(b.costOther).toBe(0.02);
    expect(b.costUnsplit).toBe(0.08);
  });

  // 一个全是老行的桶：六列都没有，钱全在 `cost_unsplit` 里。NULL 要读成 0，
  // 否则每一段都变成 NaN，条的 flexGrow 就全塌了。
  it("coerces the segment NULLs an all-legacy group returns", () => {
    const b = rowToBucket({
      key: "m1", calls: 9, cost_usd: 2,
      cost_input: null, cost_cache: null, cost_output: null,
      cost_count: null, cost_duration: null, cost_other: null,
      cost_unsplit: 2,
    });
    expect(b.costInput + b.costCache + b.costOutput + b.costCount + b.costDuration + b.costOther)
      .toBe(0);
    expect(b.costUnsplit).toBe(2);
    expect(Number.isNaN(b.costInput + 1)).toBe(false);
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

  // 抬头那个总数是从 `byModel` 加出来的，所以这里漏掉一个分项字段，抬头的条
  // 就会和它下面那几行对不上——而那种对不上不报错。
  it("adds the cost segments too, not just the total", () => {
    const total = sumBuckets("total", [
      bucket({ key: "a", costUsd: 0.6, costInput: 0.1, costCache: 0.05, costOutput: 0.3, costCount: 0.1, costDuration: 0.05, costOther: 0 }),
      bucket({ key: "b", costUsd: 0.4, costInput: 0.2, costCache: 0, costOutput: 0.1, costCount: 0, costDuration: 0, costOther: 0.05, costUnsplit: 0.05 }),
    ]);
    expect(total.costInput).toBeCloseTo(0.3, 12);
    expect(total.costCache).toBeCloseTo(0.05, 12);
    expect(total.costOutput).toBeCloseTo(0.4, 12);
    expect(total.costCount).toBeCloseTo(0.1, 12);
    expect(total.costDuration).toBeCloseTo(0.05, 12);
    expect(total.costOther).toBeCloseTo(0.05, 12);
    expect(total.costUnsplit).toBeCloseTo(0.05, 12);
  });

  // 守恒律：六段 + 分不出段的那份 === 总额。条按六段画、行尾印的是总额，
  // 两者对不上就是条比金额短一截或长一截。
  it("keeps segments + unsplit equal to the total", () => {
    const parts = [
      bucket({ key: "a", costUsd: 1, costInput: 0.2, costCache: 0.1, costOutput: 0.5, costCount: 0.15, costDuration: 0.05, costOther: 0 }),
      bucket({ key: "b", costUsd: 0.5, costUnsplit: 0.5 }),
      bucket({ key: "c", costUsd: 0.25, costOther: 0.25 }),
    ];
    const total = sumBuckets("total", parts);
    const split = total.costInput + total.costCache + total.costOutput
      + total.costCount + total.costDuration + total.costOther + total.costUnsplit;
    expect(split).toBeCloseTo(total.costUsd, 12);
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

describe("sortUsageBuckets", () => {
  const id = (k: string) => k;
  const rows = [
    bucket({ key: "a", calls: 5, promptTokens: 100, cachedTokens: 80, completionTokens: 10, costUsd: 0.1 }),
    bucket({ key: "b", calls: 2, promptTokens: 200, cachedTokens: 20, completionTokens: 90, costUsd: 0.9 }),
    bucket({ key: "c", calls: 9, promptTokens: 50, cachedTokens: 0, completionTokens: 40, costUsd: 0 }),
  ];

  it("sorts descending by a numeric column", () => {
    expect(sortUsageBuckets(rows, "calls", "desc", id).map((b) => b.key)).toEqual(["c", "a", "b"]);
    expect(sortUsageBuckets(rows, "output", "desc", id).map((b) => b.key)).toEqual(["b", "c", "a"]);
    expect(sortUsageBuckets(rows, "cost", "desc", id).map((b) => b.key)).toEqual(["b", "a", "c"]);
  });

  it("reverses on ascending", () => {
    expect(sortUsageBuckets(rows, "calls", "asc", id).map((b) => b.key)).toEqual(["b", "a", "c"]);
  });

  it("sorts input by the uncached difference, not raw prompt tokens", () => {
    // fresh input: a=20, b=180, c=50 → desc is b, c, a
    expect(sortUsageBuckets(rows, "input", "desc", id).map((b) => b.key)).toEqual(["b", "c", "a"]);
  });

  it("sorts name by the resolved label, not the raw id", () => {
    const nameOf = (k: string) => ({ a: "Zeta", b: "Alpha", c: "Mu" })[k] ?? k;
    expect(sortUsageBuckets(rows, "name", "asc", nameOf).map((b) => b.key)).toEqual(["b", "c", "a"]);
  });

  it("breaks cost ties on output tokens so unpriced rows still order", () => {
    const unpriced = [
      bucket({ key: "small", completionTokens: 10 }),
      bucket({ key: "big", completionTokens: 9_000 }),
    ];
    expect(sortUsageBuckets(unpriced, "cost", "desc", id).map((b) => b.key)).toEqual(["big", "small"]);
  });

  it("does not mutate its input", () => {
    const input = [bucket({ key: "a", calls: 1 }), bucket({ key: "b", calls: 2 })];
    sortUsageBuckets(input, "calls", "desc", id);
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
