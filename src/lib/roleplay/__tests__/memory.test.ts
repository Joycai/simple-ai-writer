import { describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n", () => ({
  default: {
    language: "zh-CN",
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string) ?? key,
  },
}));

import {
  MEMORY_BLOCK_CHAR_CAP, addRecord, dropRecordsFrom, dropSceneRecords, parseMemory, renderMemory,
  renderMemoryBlock, reviseRecord, takeSinkable, type MemoryDoc,
} from "../memory";
import type { MemoryKind, MemoryRecord } from "../model";

const AGENT = "rp-a-0001";

function rec(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1", kind: "pact", title: "雪停了一起去塔下", body: "他答应了。",
    status: "open", turn: 12, scene: 0, subject: null, updatedAt: 0, keys: [], ...over,
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

  it("keeps the scene number across a round-trip", () => {
    const source = doc([rec({ scene: 3, turn: 19 })], 2);
    const parsed = parseMemory(renderMemory(AGENT, source));
    expect(parsed.records[0].scene).toBe(3);
    expect(parsed.records[0].turn).toBe(19);
  });

  /**
   * subject 是「剩下那个字段」，所以每加一个具名字段都要同时加进它的排除表。
   * `keys=` 踩过一次；`scene N` 是第二个。装错的样子是一条记忆的主语变成
   * 「scene 3」——不报错，只是从此再也匹配不上任何人。
   */
  it("does not mistake the scene field for a subject", () => {
    const parsed = parseMemory(renderMemory(AGENT, doc([rec({ scene: 3, subject: null })], 2)));
    expect(parsed.records[0].subject).toBeNull();
    expect(parsed.records[0].scene).toBe(3);
  });

  it("still reads the subject when a scene number is present", () => {
    const source = doc([rec({ scene: 5, subject: "林", keys: ["塔", "雪"] })], 2);
    const parsed = parseMemory(renderMemory(AGENT, source));
    expect(parsed.records[0].subject).toBe("林");
    expect(parsed.records[0].scene).toBe(5);
    expect(parsed.records[0].keys).toEqual(["塔", "雪"]);
  });

  /**
   * 改动之前的文件没有这个字段。读回来是 0，重写之后**逐字相同**——不迁移、
   * 也不会因为多出一个 `scene 0` 而显得被动过。
   */
  it("reads a pre-scene file as scene 0 and rewrites it byte-identically", () => {
    const before = "<!-- roleplay-memory v1 agent=rp-a-0001 next=2 -->\n\n"
      + "## 约定 <!-- pact -->\n\n### [m1] 雪停了一起去塔下 · open · turn 12\n他答应了。\n";
    const parsed = parseMemory(before);
    expect(parsed.records[0].scene).toBe(0);
    expect(renderMemory(AGENT, parsed)).toBe(before);
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
    // 预算刚好装得下两条，装不下三条——于是排序决定谁被挤出去。正文已经不进
    // 这一块了，所以能撑爆预算的只剩标题本身。
    const long = "凑字数".repeat(100);
    const block = renderMemoryBlock([
      rec({ id: "m1", kind: "event", title: `早先的事${long}` }),
      rec({ id: "m2", kind: "pact", title: `还欠着的承诺${long}` }),
      rec({ id: "m3", kind: "todo", title: `打算做的事${long}` }),
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

  /**
   * 两级：这一块只放标题。正文曾经和标题一起进来，只有一个总上限兜着，超出的
   * 记录整条不列——那样的两级是「列出 / 完全不列」，而一条重大事件整条消失的
   * 意思是角色连它发生过都不知道。
   */
  it("carries titles only, never the body", () => {
    const block = renderMemoryBlock([rec({ title: "雪停就去塔下", body: "她说了三遍。" })]);
    expect(block).toContain("雪停就去塔下");
    expect(block).not.toContain("她说了三遍");
  });

  // 不给记号，模型无从判断哪条值得多花一次工具调用去展开。
  it("marks the records that still have detail", () => {
    const block = renderMemoryBlock([
      rec({ id: "m1", title: "有细节的", body: "很长的正文" }),
      rec({ id: "m2", title: "没细节的", body: "" }),
    ]);
    expect(block).toContain("有细节的…");
    expect(block).toContain("没细节的\n");
  });

  // 一条带正文的都没有时，「细节在哪」那句话是纯噪音——而它每一轮都在上下文里。
  it("stays silent about recall when nothing has detail", () => {
    expect(renderMemoryBlock([rec({ body: "" })])).not.toMatch(/recall/);
    expect(renderMemoryBlock([rec({ body: "有" })])).toMatch(/recall/);
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

/**
 * 转场分拣。
 *
 * 最要紧的断言是**幂等**：沉降是「移出」，不是「标 void 留档」。后者曾经是实现
 * ——而这个过滤器对 void 记录永远命中，于是每转一场，全部历史记录都被再灌进
 * 记忆区一遍，条目随转场次数平方级膨胀。
 */
describe("dropSceneRecords", () => {
  it("drops exactly the records from that scene", () => {
    const source = doc([
      rec({ id: "m1", scene: 1, title: "第一场记的" }),
      rec({ id: "m2", scene: 2, title: "第二场记的" }),
      rec({ id: "m3", scene: 2, title: "第二场也记的" }),
    ], 4);
    const { doc: kept, dropped } = dropSceneRecords(source, 2);
    expect(dropped.map((r) => r.id)).toEqual(["m2", "m3"]);
    expect(kept.records.map((r) => r.id)).toEqual(["m1"]);
  });

  /**
   * 这一条是「另起一场」不会误伤的保证。`scene: 0` 是这个字段出现之前记下的
   * 记录，属于哪一场谁也不知道——猜一个「就是本场」，等于替作者删掉他没打算
   * 删的东西，而记忆里删掉的东西是找不回来的。
   */
  it("never touches records with an unknown scene", () => {
    const source = doc([rec({ id: "m1", scene: 0 }), rec({ id: "m2", scene: 3 })], 3);
    const { doc: kept, dropped } = dropSceneRecords(source, 3);
    expect(dropped.map((r) => r.id)).toEqual(["m2"]);
    expect(kept.records.map((r) => r.id)).toEqual(["m1"]);
  });

  // id 只增不重用，哪怕整整一场作废了。
  it("does not rewind the id counter", () => {
    const source = doc([rec({ id: "m1", scene: 1 }), rec({ id: "m2", scene: 1 })], 3);
    expect(dropSceneRecords(source, 1).doc.next).toBe(3);
  });

  it("returns the same document when nothing matches", () => {
    const source = doc([rec({ id: "m1", scene: 1 })], 2);
    const out = dropSceneRecords(source, 9);
    expect(out.doc).toBe(source);
    expect(out.dropped).toEqual([]);
  });
});

describe("takeSinkable", () => {
  it("欠着的约定/待办和关系留下，其余移出", () => {
    const before = doc([
      rec({ id: "m1", kind: "pact", status: "open" }),          // 留
      rec({ id: "m2", kind: "todo", status: "open" }),          // 留
      rec({ id: "m3", kind: "bond", status: "open" }),          // 留（关系恒常驻）
      rec({ id: "m4", kind: "pact", status: "done" }),          // 沉（已兑现）
      rec({ id: "m5", kind: "event", status: "open" }),         // 沉
      rec({ id: "m6", kind: "note", status: "open" }),          // 沉
      rec({ id: "m7", kind: "scene", status: "open" }),         // 沉（旧前情）
      rec({ id: "m8", kind: "todo", status: "void" }),          // 沉（已作废）
    ], 9);
    const { doc: after, sinking } = takeSinkable(before);
    expect(after.records.map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
    expect(sinking.map((r) => r.id)).toEqual(["m4", "m5", "m6", "m7", "m8"]);
    expect(after.next).toBe(9);
  });

  it("是幂等的：沉过一次的第二次不再出现", () => {
    const before = doc([
      rec({ id: "m1", kind: "pact", status: "open" }),
      rec({ id: "m2", kind: "event" }),
    ], 3);
    const first = takeSinkable(before);
    expect(first.sinking).toHaveLength(1);
    // 第二场结束再分拣：这次没有新东西可沉。
    const second = takeSinkable(first.doc);
    expect(second.sinking).toEqual([]);
    expect(second.doc).toBe(first.doc);
  });

  it("模拟三次转场，沉降总量等于记录数，不随次数增长", () => {
    let current = doc([
      rec({ id: "m1", kind: "event" }),
      rec({ id: "m2", kind: "note" }),
      rec({ id: "m3", kind: "pact", status: "open" }),
    ], 4);
    let sunkTotal = 0;
    for (let i = 0; i < 3; i++) {
      const { doc: after, sinking } = takeSinkable(current);
      sunkTotal += sinking.length;
      current = after;
    }
    expect(sunkTotal).toBe(2);
    expect(current.records.map((r) => r.id)).toEqual(["m3"]);
  });

  it("没有可沉的就原样返回同一个对象", () => {
    const before = doc([rec({ id: "m1", kind: "pact", status: "open" })], 2);
    const { doc: after, sinking } = takeSinkable(before);
    expect(after).toBe(before);
    expect(sinking).toEqual([]);
  });
});

/**
 * 关键字往返。
 *
 * 它现在还没人读（记忆区是下一期），但**已经在往盘上写**——写错了要到那一期才
 * 发现，而那时受影响的是所有已经攒下的前情。所以格式先守起来。
 */
describe("keys 的往返", () => {
  it("写出去再读回来还是同一组", () => {
    const before = doc([rec({ id: "m1", kind: "scene", keys: ["塔", "雪", "沈砚"] })], 2);
    const after = parseMemory(renderMemory("rp-a-0001", before));
    expect(after.records[0].keys).toEqual(["塔", "雪", "沈砚"]);
  });

  it("关键字里的分隔符被清掉，否则这一行读不回来", () => {
    const before = doc([rec({ id: "m1", keys: ["西厢 · 夜", "塔,雪"] })], 2);
    const after = parseMemory(renderMemory("rp-a-0001", before));
    expect(after.records[0].keys).toEqual(["西厢 夜", "塔 雪"]);
    expect(after.records[0].subject).toBeNull();
  });

  it("没有关键字时不写这个字段，老文件读出来是空数组", () => {
    const md = renderMemory("rp-a-0001", doc([rec({ id: "m1", keys: [] })], 2));
    expect(md).not.toContain("keys=");
    expect(parseMemory(md).records[0].keys).toEqual([]);
  });

  it("带关键字时主语仍然认得出来", () => {
    const before = doc([rec({ id: "m1", subject: "桐谷萤", keys: ["塔"] })], 2);
    const after = parseMemory(renderMemory("rp-a-0001", before));
    expect(after.records[0].subject).toBe("桐谷萤");
    expect(after.records[0].keys).toEqual(["塔"]);
  });
});

/**
 * 字段行与结构行的往返加固：标题/主语和关键字同一条纪律（分隔符不能出现在
 * 字段里），正文行不能长得像本文件的结构行。
 */
describe("round-trip 加固", () => {
  it("标题里的 · 被清洗，不会把这一行劈成标题+主语", () => {
    const before = doc([rec({ id: "m1", title: "西厢 · 夜谈", subject: null })], 2);
    const parsed = parseMemory(renderMemory(AGENT, before));
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].title).toBe("西厢 夜谈");
    expect(parsed.records[0].subject).toBeNull();
  });

  it("主语里的 · 同样被清洗", () => {
    const before = doc([rec({ id: "m1", subject: "林 · 桐谷萤" })], 2);
    const parsed = parseMemory(renderMemory(AGENT, before));
    expect(parsed.records[0].subject).toBe("林 桐谷萤");
    expect(parsed.records[0].status).toBe("open");
  });

  it("正文里长得像记录头的行不会被解析成一条新记录", () => {
    const before = doc([rec({ id: "m1", body: "他留了张字条：\n### [m9] 假的记录头 · open · turn 3\n下面还有一行。" })], 2);
    const parsed = parseMemory(renderMemory(AGENT, before));
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].body).toContain("假的记录头");
    expect(parsed.records[0].body).toContain("下面还有一行");
    // 计数器也没被假 id 抬高。
    expect(parsed.next).toBe(2);
  });
});
