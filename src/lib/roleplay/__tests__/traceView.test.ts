/**
 * 取材条的取数层。
 *
 * 这一层错了**不会报错**——它只会让作者对着一个错的数字去改一份没问题的设定。
 * 所以设计稿 13 里每一条「几条算一条」的口径都在这里各占一条用例。
 */

import { describe, expect, it } from "vitest";
import type { LoreActivationReport, LoreEntityReport } from "../../context/loreSelect";
import type { ResidentPiece, TurnContextTrace } from "../trace";
import {
  blockedChars, budgetPressed, dropRows, foldHits, hitRows, keywordLine,
  residentRows, summarize,
} from "../traceView";

function entity(over: Partial<LoreEntityReport> = {}): LoreEntityReport {
  return {
    name: "铁鳞甲", aliases: "", dirPath: `/lore/world/${over.name ?? "armor"}`,
    reason: "auto", layers: [], droppedFacets: [], ...over,
  };
}

function report(entities: LoreEntityReport[], used = 0, budget = 6400): LoreActivationReport {
  return { entities, usedChars: used, budgetChars: budget };
}

function piece(over: Partial<ResidentPiece> = {}): ResidentPiece {
  return {
    kind: "bound-core", name: "沈砚", dirPath: "/lore/characters/shen",
    facetTitle: null, chars: 400, unexpanded: false, ...over,
  };
}

function trace(over: Partial<TurnContextTrace> = {}): TurnContextTrace {
  return {
    resident: [], stalePaths: [], lore: null, area: null, refs: [],
    charsPerToken: 1, ...over,
  };
}

describe("收起行的三个数", () => {
  /**
   * 收起行写「常驻 5 · 本轮 6」，展开是 3 + 2 + 1。**两个数必须对得上**，
   * 否则展开的那一刻整条就失去信任。
   */
  it("「本轮」是三段之和：知识库 + 记忆区 + 引用", () => {
    const hit = (n: string) => entity({ name: n, dirPath: `/lore/${n}`, layers: [{ kind: "core", chars: 100 }] });
    const t = trace({
      resident: [piece(), piece({ name: "口癖" })],
      lore: report([hit("a"), hit("b"), hit("c")], 2500),
      area: report([hit("m1"), hit("m2")], 400),
      refs: [{ name: "雪原三月", dirPath: "/doc" }],
    });
    const s = summarize(t);
    expect(s.residentCount).toBe(2);
    expect(s.turnCount).toBe(3 + 2 + 1);
    expect(hitRows(t.lore).length + hitRows(t.area).length + t.refs.length).toBe(s.turnCount);
  });

  /**
   * 常驻上一轮就装订好了，这一轮不必重复计。把它并进「本轮 2,480 字」，作者每
   * 一轮都会看到一个虚高的数，并据此去调一个没问题的预算。
   */
  it("常驻的字数不计进本轮", () => {
    const s = summarize(trace({
      resident: [piece({ chars: 9999 }), piece({ chars: 9999 })],
      lore: report([], 2500),
      area: report([], 400),
    }));
    expect(s.turnChars).toBe(2900);
  });

  /**
   * `coreResident`（0 字）的那些**要算进本轮**。
   *
   * 它的意思是「命中了，但正文已经在常驻段里，去重后不重复装」——把它滤掉，
   * 作者会以为这一句话没能唤起这个条目，然后去给一个工作正常的条目加关键字。
   * 设计稿把「0 字」列为五句不能互相代替的话之一，就是这个原因。
   */
  it("0 字的条目（coreResident）算进本轮，但不加字数", () => {
    const t = trace({
      lore: report([
        entity({ name: "已常驻", coreResident: true, layers: [] }),
        entity({ name: "真命中", dirPath: "/lore/x", layers: [{ kind: "summary", chars: 40 }] }),
      ], 40),
    });
    expect(summarize(t).turnCount).toBe(2);
    expect(summarize(t).turnChars).toBe(40);
    const rows = hitRows(t.lore);
    expect(rows.map((r) => [r.name, r.chars])).toEqual([["真命中", 40], ["已常驻", 0]]);
    expect(rows[1].coreResident).toBe(true);
  });

  /** 引用**算一条**（它确实在上下文里），但 refs 没有 chars，所以不加字数。 */
  it("引用算一条，但不进字数合计", () => {
    const s = summarize(trace({
      lore: report([], 500),
      refs: [{ name: "雪原三月", dirPath: "/doc/a" }, { name: "军械册", dirPath: "/doc/b" }],
    }));
    expect(s.turnCount).toBe(2);
    expect(s.turnChars).toBe(500);
  });

  /**
   * 「只进了标题」要报到收起行。这是作者最容易误判的一种——清单里明明有它，
   * 角色却对它一无所知，而不展开就看不见。
   */
  it("只进了标题的常驻项单独计数", () => {
    const s = summarize(trace({
      resident: [piece(), piece({ name: "旧城地图", unexpanded: true, chars: 18 })],
    }));
    expect(s.residentCount).toBe(2);
    expect(s.unexpandedCount).toBe(1);
  });

  it("落选与失效各自成一个数", () => {
    const s = summarize(trace({
      stalePaths: ["/lore/gone", "/lore/gone2"],
      lore: report([entity({
        droppedFacets: [
          { file: "a.md", title: "产地", reason: "group-lost" },
          { file: "b.md", title: "旧伤", reason: "no-key" },
        ],
        droppedImages: 2,
      })]),
    }));
    expect(s.droppedCount).toBe(3); // 两条特征 + 一组没装下的配图
    expect(s.staleCount).toBe(2);
  });
});

describe("null 报告和空报告是两回事", () => {
  /**
   * 设计稿把「本轮 0」和「无记录」并列为三句不能混的话里的两句。在数据层，
   * 区分它们的就是 `null` 与空数组——`hitRows` 两边都返回 `[]`，所以**组件必须
   * 看报告本身**，这条用例把这件事钉住。
   */
  it("跑了没命中和根本没跑，聚合结果一样，但报告分得清", () => {
    const ranNothing = trace({ lore: report([], 0) });
    const neverRan = trace({ lore: null });
    expect(hitRows(ranNothing.lore)).toEqual([]);
    expect(hitRows(neverRan.lore)).toEqual([]);
    expect(summarize(ranNothing).turnCount).toBe(0);
    expect(summarize(neverRan).turnCount).toBe(0);
    // 只有这一处分得清，所以组件要读它而不是读上面两个 0。
    expect(ranNothing.lore).not.toBeNull();
    expect(neverRan.lore).toBeNull();
  });
});

describe("命中的一条", () => {
  it("特征各自成行，其余的层折成芯片", () => {
    const [row] = hitRows(report([entity({
      layers: [
        { kind: "summary", chars: 40 },
        { kind: "core", chars: 1200, truncated: true, sourceChars: 2840 },
        { kind: "facet", title: "战甲", chars: 400, matchedKeys: ["甲片"] },
        { kind: "gallery", chars: 60, count: 2 },
      ],
    })]));
    expect(row.chips.map((c) => c.kind)).toEqual(["summary", "core", "gallery"]);
    expect(row.facets.map((f) => f.title)).toEqual(["战甲"]);
    expect(row.chars).toBe(1700);
    const core = row.chips.find((c) => c.kind === "core")!;
    expect(core.truncated).toBe(true);
    expect(core.sourceChars).toBe(2840);
  });

  /**
   * 「随条目进入」这一行必须能推出来：留空会被读成「不知道为什么进来的」，而它
   * 恰恰是设定里最确定的一类（`mode: "always"`）。
   */
  it("没有关键词、也不是 pin 的特征 = 随条目进入", () => {
    const [row] = hitRows(report([entity({
      layers: [
        { kind: "facet", title: "口癖", chars: 100 },
        { kind: "facet", title: "战甲", chars: 400, matchedKeys: ["甲片"] },
        { kind: "facet", title: "钉住的", chars: 200, pinned: true },
      ],
    })]));
    const by = Object.fromEntries(row.facets.map((f) => [f.title, f.ridesAlong]));
    expect(by["口癖"]).toBe(true);
    expect(by["战甲"]).toBe(false);
    expect(by["钉住的"]).toBe(false); // pin 有自己的记号
  });

  /** 窄栏折叠留下的应当是最大的那几条，宽窄两种读法必须是同一个顺序。 */
  it("按注入量从大到小", () => {
    const mk = (name: string, chars: number) =>
      entity({ name, dirPath: `/lore/${name}`, layers: [{ kind: "core", chars }] });
    expect(hitRows(report([mk("小", 100), mk("大", 900), mk("中", 500)])).map((r) => r.name))
      .toEqual(["大", "中", "小"]);
  });
});

describe("激活词", () => {
  it("至多平铺三个，其余折成一个数", () => {
    expect(keywordLine(["铁鳞", "甲片", "鳞纹", "锈", "缝"]))
      .toEqual({ shown: ["铁鳞", "甲片", "鳞纹"], rest: 2 });
    expect(keywordLine(["铁鳞"])).toEqual({ shown: ["铁鳞"], rest: 0 });
  });

  it("展开之后就地续写成全部，不再折", () => {
    expect(keywordLine(["a", "b", "c", "d"], true))
      .toEqual({ shown: ["a", "b", "c", "d"], rest: 0 });
  });
});

describe("没进去", () => {
  /** 「超预算」是五种里唯一有解的一种，而这一组的段底挂着预算入口。 */
  it("超预算排最前", () => {
    const rows = dropRows(report([entity({
      droppedFacets: [
        { file: "a.md", title: "产地", reason: "group-lost", winner: "战甲" },
        { file: "b.md", title: "正文", reason: "budget", neededChars: 600 },
      ],
    })]));
    expect(rows[0].reason).toBe("budget");
    expect(rows[0].neededChars).toBe(600);
    expect(rows[1].winner).toBe("战甲");
  });

  it("行头是「条目名 · 那一段」", () => {
    const [row] = dropRows(report([entity({
      name: "铁鳞甲",
      droppedFacets: [{ file: "a.md", title: "产地", reason: "no-key" }],
    })]));
    expect(row.label).toBe("铁鳞甲 · 产地");
  });

  it("被挡下的合计 = 提高预算能拿回多少", () => {
    const rows = dropRows(report([entity({
      droppedFacets: [
        { file: "a.md", title: "一", reason: "budget", neededChars: 600 },
        { file: "b.md", title: "二", reason: "budget", neededChars: 900 },
        { file: "c.md", title: "三", reason: "no-key" },
      ],
    })]));
    expect(blockedChars(rows)).toBe(1500);
  });

  /** 预算没满就不该有个亮按钮劝你调它（设计稿 1f）。 */
  it("没有「超预算」那一类时不画预算条", () => {
    const rows = dropRows(report([entity({
      droppedFacets: [
        { file: "a.md", title: "一", reason: "no-key" },
        { file: "b.md", title: "二", reason: "manual-only" },
      ],
    })]));
    expect(budgetPressed(rows)).toBe(false);
    expect(budgetPressed(dropRows(report([entity({
      droppedFacets: [{ file: "c.md", title: "三", reason: "budget", neededChars: 1 }],
    })])))).toBe(true);
  });
});

describe("窄栏折叠", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) =>
    entity({ name: `e${i}`, dirPath: `/lore/e${i}`, layers: [{ kind: "core", chars: (n - i) * 100 }] }));

  it("超过 6 条才折，折起来的是最小的那些", () => {
    const folded = foldHits(hitRows(report(many(9))));
    expect(folded.shown).toHaveLength(6);
    expect(folded.restCount).toBe(3);
    // 剩下三条是 300 + 200 + 100。
    expect(folded.restChars).toBe(600);
  });

  it("正好 6 条不折", () => {
    expect(foldHits(hitRows(report(many(6)))).restCount).toBe(0);
  });
});

describe("常驻的行头", () => {
  it("特征绑定写成「条目 · 那一段」，整条绑定只写条目名", () => {
    const rows = residentRows(trace({
      resident: [
        piece({ kind: "primary", name: "沈砚" }),
        piece({ kind: "bound-facet", name: "沈砚", facetTitle: "外套" }),
      ],
    }));
    expect(rows.map((r) => r.label)).toEqual(["沈砚", "沈砚 · 外套"]);
  });
});
