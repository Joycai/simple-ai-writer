import { describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n", () => ({
  default: {
    language: "zh-CN",
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string) ?? key,
  },
}));

import {
  MEMORY_BLOCK_CHAR_CAP, addRecord, dropRecordsFrom, parseMemory, renderMemory,
  renderMemoryBlock, reviseRecord, type MemoryDoc,
} from "../memory";
import type { MemoryKind, MemoryRecord } from "../model";

const AGENT = "rp-a-0001";

function rec(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1", kind: "pact", title: "雪停了一起去塔下", body: "他答应了。",
    status: "open", turn: 12, subject: null, updatedAt: 0, ...over,
  };
}

const doc = (records: MemoryRecord[], next: number): MemoryDoc => ({ records, next });

describe("parseMemory / renderMemory", () => {
  it("round-trips records through the file format", () => {
    const source = doc([
      rec({ id: "m1", kind: "pact" }),
      rec({ id: "m2", kind: "bond", title: "对 林", subject: "林", body: "从戒备转为勉强的信任。" }),
    ], 3);
    const parsed = parseMemory(renderMemory(AGENT, source));
    expect(parsed.next).toBe(3);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]).toMatchObject({ id: "m1", kind: "pact", status: "open", turn: 12 });
    expect(parsed.records[1]).toMatchObject({ id: "m2", kind: "bond", subject: "林" });
    expect(parsed.records[1].body).toBe("从戒备转为勉强的信任。");
  });

  it("keeps status and turn across a round-trip", () => {
    const source = doc([rec({ status: "void", turn: 19 })], 2);
    const parsed = parseMemory(renderMemory(AGENT, source));
    expect(parsed.records[0].status).toBe("void");
    expect(parsed.records[0].turn).toBe(19);
  });

  /**
   * id 永不复用：transcript 和对话里对某条记忆的引用必须永远指向同一件事。
   * 作者手删中间一条之后，计数器不能回退。
   */
  it("never lets the id counter go backwards after a record is deleted by hand", () => {
    const full = renderMemory(AGENT, doc([rec({ id: "m1" }), rec({ id: "m2" }), rec({ id: "m3" })], 4));
    // 作者手删了 m2 和 m3，但没有改机器头。
    const trimmed = full.split("### [m2]")[0];
    expect(parseMemory(trimmed).next).toBe(4);
  });

  it("recovers the counter from the highest id when the header is gone", () => {
    const md = "## 约定 <!-- pact -->\n\n### [m7] 只此一条 · open · turn 3\n正文\n";
    expect(parseMemory(md).next).toBe(8);
  });

  // 作者手改这个文件是被允许的行为，不是错误。
  it("never throws, and keeps text it cannot classify", () => {
    const md = "作者在开头写的备注\n\n### [m1] 没有分组的一条\n正文在这里\n";
    const parsed = parseMemory(md);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].kind).toBe("note");
    expect(parsed.records[0].body).toBe("正文在这里");
    expect(() => parseMemory("### [] · · ·\n## 乱七八糟")).not.toThrow();
  });

  it("reads an empty file as an empty notebook", () => {
    expect(parseMemory("")).toEqual({ records: [], next: 1 });
  });
});

describe("addRecord", () => {
  it("assigns a fresh id and advances the counter", () => {
    const { doc: next, record } = addRecord(
      doc([], 1), { kind: "pact", title: "t", body: "b", turn: 3, subject: null }, 100,
    );
    expect(record.id).toBe("m1");
    expect(record.status).toBe("open");
    expect(next.next).toBe(2);
  });

  it("does not reuse an id even when earlier records are gone", () => {
    const { record } = addRecord(
      doc([], 8), { kind: "todo", title: "t", body: "", turn: 1, subject: null }, 100,
    );
    expect(record.id).toBe("m8");
  });
});

describe("reviseRecord", () => {
  it("returns null for an unknown id instead of quietly creating one", () => {
    // 静默新建会让模型以为改成功了，而作者会看到两条互相矛盾的记录。
    expect(reviseRecord(doc([rec()], 2), "m9", { status: "done" }, 1)).toBeNull();
  });

  it("voids without destroying the text", () => {
    const out = reviseRecord(doc([rec({ body: "原文还在" })], 2), "m1", { status: "void" }, 1);
    expect(out?.record.status).toBe("void");
    expect(out?.record.body).toBe("原文还在");
  });

  it("leaves the other records untouched", () => {
    const out = reviseRecord(doc([rec({ id: "m1" }), rec({ id: "m2" })], 3), "m2", { body: "改了" }, 1);
    expect(out?.doc.records[0].body).toBe("他答应了。");
    expect(out?.doc.records[1].body).toBe("改了");
  });
});

describe("renderMemoryBlock", () => {
  it("injects only the live records", () => {
    const block = renderMemoryBlock([
      rec({ id: "m1", title: "还欠着" }),
      rec({ id: "m2", title: "已兑现", status: "done" }),
      rec({ id: "m3", title: "已作废", status: "void" }),
    ]);
    expect(block).toContain("还欠着");
    expect(block).not.toContain("已兑现");
    expect(block).not.toContain("已作废");
  });

  it("is empty when nothing is live", () => {
    expect(renderMemoryBlock([rec({ status: "done" })])).toBe("");
    expect(renderMemoryBlock([])).toBe("");
  });

  it("carries the id so revise_memory has something to name", () => {
    expect(renderMemoryBlock([rec({ id: "m4" })])).toContain("(m4)");
  });

  /**
   * 约定和待办排在前面不是因为它们更重要，是因为它们**尚未了结**：一条没兑现的
   * 承诺被挤出上下文，角色就会失信；一件已发生的事被挤出去，最多是少一点色彩。
   */
  it("spends the budget on unfinished business first", () => {
    // 预算刚好装得下两条，装不下三条——于是排序决定谁被挤出去。
    const long = "凑字数".repeat(100);
    const block = renderMemoryBlock([
      rec({ id: "m1", kind: "event", title: "早先的事", body: long }),
      rec({ id: "m2", kind: "pact", title: "还欠着的承诺", body: long }),
      rec({ id: "m3", kind: "todo", title: "打算做的事", body: long }),
    ], 800);
    expect(block).toContain("还欠着的承诺");
    expect(block).toContain("打算做的事");
    expect(block).not.toContain("早先的事");
  });

  it("says how many it left out rather than dropping them silently", () => {
    const long = "凑字数".repeat(400);
    const block = renderMemoryBlock(
      Array.from({ length: 6 }, (_, i) => rec({ id: `m${i + 1}`, title: `第${i}条`, body: long })),
      1400,
    );
    expect(block).toMatch(/recall/);
  });

  it("stays within the cap", () => {
    const block = renderMemoryBlock(
      Array.from({ length: 60 }, (_, i) => rec({ id: `m${i}`, body: "正文".repeat(80) })),
    );
    expect(block.length).toBeLessThan(MEMORY_BLOCK_CHAR_CAP + 200);
  });

  it("folds a multi-line body onto one line so the block stays scannable", () => {
    const block = renderMemoryBlock([rec({ body: "第一行\n第二行" })]);
    expect(block).toContain("第一行 第二行");
  });
});

describe("kinds", () => {
  it("renders every kind without falling through", () => {
    const kinds: MemoryKind[] = ["pact", "todo", "event", "bond", "note"];
    const block = renderMemoryBlock(kinds.map((kind, i) => rec({ id: `m${i}`, kind, title: kind })));
    for (const kind of kinds) expect(block).toContain(kind);
  });
});

/**
 * 回退时丢掉在被撤销的那几轮里记下的东西。
 *
 * 「记忆只增改不删」防的是模型删自己不想要的记录；作者按下回退是另一回事——
 * 一条诞生于已被撤销的对话的约定，留着会让角色言之凿凿地提起一件没发生过的事。
 */
describe("dropRecordsFrom", () => {
  it("丢掉轮号 >= 目标的，留下更早的", () => {
    const before = doc([
      rec({ id: "m1", turn: 3 }), rec({ id: "m2", turn: 7 }), rec({ id: "m3", turn: 12 }),
    ], 4);
    const { doc: after, dropped } = dropRecordsFrom(before, 7);
    expect(after.records.map((r) => r.id)).toEqual(["m1"]);
    expect(dropped.map((r) => r.id)).toEqual(["m2", "m3"]);
  });

  it("作者自己写的（turn: 0）永远不动——它不属于任何一轮", () => {
    const before = doc([rec({ id: "m1", turn: 0 }), rec({ id: "m2", turn: 9 })], 3);
    const { doc: after } = dropRecordsFrom(before, 1);
    expect(after.records.map((r) => r.id)).toEqual(["m1"]);
  });

  it("没有可丢的就原样返回同一个对象", () => {
    const before = doc([rec({ id: "m1", turn: 3 })], 2);
    const { doc: after, dropped } = dropRecordsFrom(before, 20);
    expect(after).toBe(before);
    expect(dropped).toEqual([]);
  });

  it("next 不回退——id 只增不重用", () => {
    const before = doc([rec({ id: "m9", turn: 9 })], 10);
    expect(dropRecordsFrom(before, 1).doc.next).toBe(10);
  });
});
