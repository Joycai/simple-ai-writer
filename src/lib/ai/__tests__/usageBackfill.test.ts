/**
 * lib/ai/usageBackfill —— 给老用量行补分项的那一趟。
 *
 * 这个模块动的是**历史数据**，而它的每一种错法都是静默的：口径差一点就把
 * 一批行的分法写歪，重算和存下来的总额对不上却照写，或者一批全是对不上的
 * 行时原地打转再也退不出来。所以闸门、游标、幂等每一条都单独钉住。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` 被提到文件顶上，工厂里不能碰后面才初始化的 const——`vi.hoisted`
// 把这个 mock 一起提上去，两者的时序才对得上。
const { txMock } = vi.hoisted(() => ({
  txMock: vi.fn(async (_dbPath: string, _statements: { sql: string; values: number[] }[]) => {}),
}));
vi.mock("../../sqlTx", () => ({ sqlTransaction: txMock }));

import { backfillUsageParts, rowToBilled, type BackfillResult } from "../usageBackfill";

type Row = Record<string, unknown>;
type Db = Parameters<typeof backfillUsageParts>[0];

/** `sqlTransaction(dbPath, statements)` —— 语句在第二个参数上。 */
function statementsOf(callIndex = 0): { sql: string; values: number[] }[] {
  return txMock.mock.calls[callIndex][1];
}

/** 一条 UPDATE 的六段 + id，按 `UPDATE_SQL` 的占位符顺序。 */
function segsOf(stmt: { values: number[] }) {
  const [input, cache, output, count, duration, other, id] = stmt.values;
  return { input, cache, output, count, duration, other, id };
}

/**
 * 一个假库：`select` 每次按「`cost_input IS NULL` 且 `id > after`」过滤，
 * 真的照着 SQL 的语义走，这样游标推进与幂等才测得出来。
 */
function fakeDb(rows: Row[]) {
  const select = vi.fn(async (_sql: string, params: unknown[]) => {
    const [after, limit] = params as [number, number];
    return rows
      .filter((r) => r.cost_input == null && (r.id as number) > after)
      .sort((a, b) => (a.id as number) - (b.id as number))
      .slice(0, limit);
  });
  return { db: { select } as unknown as Db, select };
}

/** 一行按 token 计费的行，钱对得上。 */
const tokenRow = (over: Row = {}): Row => ({
  id: 1,
  billing_mode: "token",
  prompt_tokens: 1000, cached_tokens: 400, completion_tokens: 200,
  input_price: 3, cache_price: 0.3, output_price: 15,
  cost_usd: (600 * 3 + 400 * 0.3 + 200 * 15) / 1e6,
  cost_input: null,
  ...over,
});

beforeEach(() => {
  txMock.mockClear();
  txMock.mockImplementation(async () => {});
});


describe("rowToBilled", () => {
  it("把表的口径换成算钱的口径：prompt 含缓存，Billed 的两段不重叠", () => {
    const b = rowToBilled({ prompt_tokens: 1000, cached_tokens: 400 });
    expect(b.inputTokens).toBe(600);
    expect(b.cacheTokens).toBe(400);
  });

  it("缓存比 prompt 还多时夹住，不算出负的输入", () => {
    const b = rowToBilled({ prompt_tokens: 100, cached_tokens: 500 });
    expect(b.inputTokens).toBe(0);
    expect(b.cacheTokens).toBe(100);
  });

  it("缓存价为空回退到输入价——缓存价存在之前写的行就是这么读的", () => {
    expect(rowToBilled({ input_price: 3, cache_price: null }).cachePrice).toBe(3);
    // 但填了 0 就是真免费，不能被当成「没填」。
    expect(rowToBilled({ input_price: 3, cache_price: 0 }).cachePrice).toBe(0);
  });

  it("上游报价：空 ≠ 零", () => {
    expect(rowToBilled({ reported_cost: null }).reportedCost).toBeNull();
    expect(rowToBilled({ reported_cost: 0 }).reportedCost).toBe(0);
  });

  it("未知的 billing_mode 按 token 读——那是这个应用历史上唯一的解释", () => {
    expect(rowToBilled({ billing_mode: null }).billingMode).toBe("token");
    expect(rowToBilled({ billing_mode: "spec" }).billingMode).toBe("spec");
  });
});

describe("backfillUsageParts · 对账闸门", () => {
  it("对得上账就写下去，六段加起来等于行上的总额", async () => {
    const { db } = fakeDb([tokenRow()]);
    const r: BackfillResult = await backfillUsageParts(db, "/db");
    expect(r).toEqual({ filled: 1, skipped: 0 });
    const { input, cache, output, count, duration, other, id } = segsOf(statementsOf()[0]);
    expect(id).toBe(1);
    expect(input + cache + output + count + duration + other)
      .toBeCloseTo(tokenRow().cost_usd as number, 12);
    expect(input).toBeCloseTo(600 * 3 / 1e6, 12);
    expect(output).toBeCloseTo(200 * 15 / 1e6, 12);
  });

  // 快照列出现之前的远古行：价全缺，重算出来是 0，但行上记着真实花销。
  // 这种行**保持 NULL**，在用量页里是「未分项」——宁可留白，不可编一个分法出来。
  it("对不上账就跳过，一个字都不写", async () => {
    const ancient: Row = {
      id: 7, billing_mode: null, prompt_tokens: 1000, completion_tokens: 200,
      input_price: null, output_price: null, cost_usd: 0.42, cost_input: null,
    };
    const { db } = fakeDb([ancient]);
    const r = await backfillUsageParts(db, "/db");
    expect(r).toEqual({ filled: 0, skipped: 1 });
    expect(txMock).not.toHaveBeenCalled();
  });

  it("一批里混着对得上和对不上的，各行其是", async () => {
    const ancient: Row = { id: 2, cost_usd: 0.42, cost_input: null };
    const { db } = fakeDb([tokenRow({ id: 1 }), ancient, tokenRow({ id: 3 })]);
    const r = await backfillUsageParts(db, "/db");
    expect(r).toEqual({ filled: 2, skipped: 1 });
    expect(statementsOf().map((s) => segsOf(s).id)).toEqual([1, 3]);
  });

  // 没配价的模型：重算是 0，行上也是 0。两边都是 0 算对得上——这一行的
  // 分法就是「六段全 0」，它和「分不出来」是两回事。
  it("零费用的行算对得上，写六个 0 而不是留空", async () => {
    const free: Row = {
      id: 5, billing_mode: "token", prompt_tokens: 100, completion_tokens: 50,
      input_price: 0, output_price: 0, cost_usd: 0, cost_input: null,
    };
    const { db } = fakeDb([free]);
    expect(await backfillUsageParts(db, "/db")).toEqual({ filled: 1, skipped: 0 });
  });
});

describe("backfillUsageParts · 游标与幂等", () => {
  it("写过的行不再命中，跑第二遍什么都不做", async () => {
    const rows = [tokenRow({ id: 1 }), tokenRow({ id: 2 })];
    const { db } = fakeDb(rows);
    // 第一遍之后把写进去的行标成已有分项，模拟库里真的落了盘。
    txMock.mockImplementation(async (_path, stmts) => {
      for (const s of stmts) {
        const row = rows.find((r) => r.id === segsOf(s).id);
        if (row) row.cost_input = segsOf(s).input;
      }
    });
    expect(await backfillUsageParts(db, "/db")).toEqual({ filled: 2, skipped: 0 });
    txMock.mockClear();
    expect(await backfillUsageParts(db, "/db")).toEqual({ filled: 0, skipped: 0 });
    expect(txMock).not.toHaveBeenCalled();
  });

  // 对不上账的行永远写不进去，所以它们会被每一次 SELECT 重新选中。游标不推进
  // 的话，一整批都对不上时循环就再也退不出来——这是这个模块唯一会挂死的地方。
  it("一整批都对不上时靠游标退出，不原地打转", async () => {
    const many: Row[] = Array.from({ length: 2500 }, (_, i) => ({
      id: i + 1, cost_usd: 0.42, cost_input: null,
    }));
    const { db, select } = fakeDb(many);
    const r = await backfillUsageParts(db, "/db");
    expect(r).toEqual({ filled: 0, skipped: 2500 });
    // 1000 + 1000 + 500：最后一批不满一批就收工，不多花一次往返去确认空。
    expect(select).toHaveBeenCalledTimes(3);
    expect(txMock).not.toHaveBeenCalled();
  });

  // commit-4 的 review 构造出来的挂死：一整批 1000 行的 `id` 全读不成数字
  // （`num()` 把它们读成 0），且全部对不上账 → 游标不推进、行又永远写不进去
  // → 同一批被无限重取。这一趟挂在 openProject 的 await 链上，`try/catch`
  // 捕获抛错但捕获不了挂死，表现是**项目再也开不出来且没有任何征兆**。
  it("游标推不动时收工，不无限重取同一批", async () => {
    const rows: Row[] = Array.from({ length: 1000 }, () => ({
      id: "坏格", cost_usd: 0.42, cost_input: null,
    }));
    const select = vi.fn(async () => rows.slice(0, 1000));
    const db = { select } as unknown as Db;
    const r = await backfillUsageParts(db, "/db");
    expect(r.filled).toBe(0);
    // **收工了**——这是这条测试的全部意义。第一趟游标从 -1 的哨兵挪到 0
    // （`num("坏格")` 读成 0）算推进过，第二趟才发现推不动、收工；所以是
    // 两批而不是一批。要紧的是它有限，不是它等于几。
    expect(select).toHaveBeenCalledTimes(2);
    expect(r.skipped).toBe(2000);
  });

  it("空表不炸", async () => {
    const { db } = fakeDb([]);
    expect(await backfillUsageParts(db, "/db")).toEqual({ filled: 0, skipped: 0 });
    expect(txMock).not.toHaveBeenCalled();
  });
});

describe("backfillUsageParts · 口径与写入口一致", () => {
  // commit-4 的 review 点出的不对称：`buildUsageRow` 的 requests 默认 1，
  // `rowToBilled` 读 request_count 缺失时是 0。今天不会算错钱——request_count
  // 和 billing_mode 是同一个 commit 加的，缺前者的行后者也为 NULL，走 token
  // 分支根本不读 requests。但这份无害性是**借来的**，钉住它：哪天真出现
  // 半套快照，该拦住的是闸门，不是运气。
  it("按次的行缺 request_count 时算出 0，与行上记的钱对不上，被闸门拦下", async () => {
    const halfSnapshot: Row = {
      id: 1, billing_mode: "request", request_price: 0.04,
      // request_count 缺失
      cost_usd: 0.12, cost_input: null,
    };
    const { db } = fakeDb([halfSnapshot]);
    expect(await backfillUsageParts(db, "/db")).toEqual({ filled: 0, skipped: 1 });
    expect(txMock).not.toHaveBeenCalled();
  });

  it("按次的行带着 request_count 时对得上，照常补", async () => {
    const full: Row = {
      id: 1, billing_mode: "request", request_price: 0.04, request_count: 3,
      cost_usd: 0.12, cost_input: null,
    };
    const { db } = fakeDb([full]);
    expect(await backfillUsageParts(db, "/db")).toEqual({ filled: 1, skipped: 0 });
    // 按次的固定价五段装不下，进「其它」。
    expect(segsOf(statementsOf()[0]).other).toBeCloseTo(0.12, 12);
  });
});

describe("backfillUsageParts · 单位决定张数还是时长", () => {
  const specRow = (unit: unknown): Row => ({
    id: 1, billing_mode: "spec", output_units: 3, output_unit_price: 0.04,
    output_unit: unit, cost_usd: 0.12, cost_input: null,
  });

  it("按张：规格的钱落进「张数」", async () => {
    await backfillUsageParts(fakeDb([specRow("image")]).db, "/db");
    expect(segsOf(statementsOf()[0]).count).toBeCloseTo(0.12, 12);
  });

  it("按秒：落进「时长」", async () => {
    await backfillUsageParts(fakeDb([specRow("second")]).db, "/db");
    expect(segsOf(statementsOf()[0]).duration).toBeCloseTo(0.12, 12);
  });

  // 单位认不出来就不猜，归「其它」——画成中性的一段，比归进一个错的维度诚实。
  it("单位认不出来时归「其它」，不猜", async () => {
    await backfillUsageParts(fakeDb([specRow(null)]).db, "/db");
    expect(segsOf(statementsOf()[0]).other).toBeCloseTo(0.12, 12);
  });
});
