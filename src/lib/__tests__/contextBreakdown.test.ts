/**
 * The composer's context bar. What is pinned here is that the bar can't lie
 * about the two things it exists to answer: what the context is made of, and
 * how close it is to compaction.
 */
import { describe, expect, it } from "vitest";
import {
  createSessionMeta, noteTurnStart, planFold, recordInjections, COMPACT_TRIGGER,
} from "../agent/compact";
import {
  computeContextBreakdown, computePreflightBreakdown,
} from "../agent/contextBreakdown";
import { estimateMessagesTokens } from "../ai/tokenEstimate";
import type { StreamMessage } from "../ai/types";
import type { LoreEntity } from "../lore/model";

function entity(dirPath: string): LoreEntity {
  return {
    dirPath,
    name: dirPath,
    category: "characters",
    aliases: [],
    summary: "",
    facets: [],
  } as unknown as LoreEntity;
}

function session() {
  const meta = createSessionMeta();
  const system: StreamMessage = { role: "system", content: "系统提示".repeat(20) };
  const seed: StreamMessage = { role: "user", content: "【知识库】".repeat(40) };
  const question: StreamMessage = { role: "user", content: "接着写" };
  const answer: StreamMessage = { role: "assistant", content: "好的".repeat(30) };
  meta.seedContext = seed;
  recordInjections(meta, [entity("lore/characters/a")], seed);
  noteTurnStart(meta, question);
  return { meta, system, seed, question, answer, history: [system, seed, question, answer] };
}

describe("computeContextBreakdown", () => {
  it("splits the history by the identities chatMeta records", () => {
    const { meta, history, seed, system } = session();
    const b = computeContextBreakdown(history, meta, 0, 100_000, 128_000);
    const by = Object.fromEntries(b.segments.map((s) => [s.key, s.tokens]));

    expect(by.system).toBe(estimateMessagesTokens([system]));
    expect(by.seed).toBe(estimateMessagesTokens([seed]));
    // The seed carries the injections, so its tokens must not be counted twice.
    expect(by.injected).toBe(0);
    expect(by.conversation).toBeGreaterThan(0);
  });

  it("counts a later turn's injection block separately from the conversation", () => {
    const { meta, history } = session();
    const inj: StreamMessage = { role: "user", content: "【知识库】".repeat(50) };
    history.push(inj);
    recordInjections(meta, [entity("lore/characters/b")], inj);

    const b = computeContextBreakdown(history, meta, 0, 100_000, 128_000);
    const by = Object.fromEntries(b.segments.map((s) => [s.key, s.tokens]));
    expect(by.injected).toBe(estimateMessagesTokens([inj]));
  });

  it("adds the tool schemas to the fixed cost — the pre-flight gate counts them too", () => {
    const { meta, history } = session();
    const without = computeContextBreakdown(history, meta, 0, 100_000, 128_000);
    const with_ = computeContextBreakdown(history, meta, 3_000, 100_000, 128_000);
    expect(with_.usedTokens - without.usedTokens).toBe(3_000);
  });

  it("accounts for every token: the used segments sum to usedTokens, and the bar to the ceiling", () => {
    const { meta, history } = session();
    const b = computeContextBreakdown(history, meta, 1_200, 100_000, 128_000);
    const used = b.segments.filter((s) => s.key !== "free").reduce((n, s) => n + s.tokens, 0);
    const free = b.segments.find((s) => s.key === "free")!.tokens;
    expect(used).toBe(b.usedTokens);
    expect(used + free).toBe(100_000);
  });

  it("puts the compaction mark where compaction actually fires", () => {
    const { meta, history } = session();
    const b = computeContextBreakdown(history, meta, 0, 100_000, 128_000);
    // Under the ceiling the bar spans the ceiling, so the mark sits at the raw
    // trigger share — not at some fraction of the model's whole window.
    expect(b.compactMarkerPct).toBeCloseTo(COMPACT_TRIGGER * 100, 5);
    expect(b.over).toBe(false);
  });

  it("packs full and slides the mark left once the history outgrows the ceiling", () => {
    const { meta, history } = session();
    const ceiling = 10;
    const b = computeContextBreakdown(history, meta, 0, ceiling, 128_000);
    expect(b.usedTokens).toBeGreaterThan(ceiling);
    expect(b.over).toBe(true);
    expect(b.segments.find((s) => s.key === "free")!.tokens).toBe(0);
    expect(b.compactMarkerPct).toBeCloseTo((ceiling * COMPACT_TRIGGER * 100) / b.usedTokens, 5);
  });

  it("reports the tool cost on a session that has not run yet", () => {
    const b = computeContextBreakdown(null, null, 4_000, 64_000, 128_000);
    expect(b.usedTokens).toBe(4_000);
    expect(b.segments.find((s) => s.key === "free")!.tokens).toBe(60_000);
  });

  it("warns the moment the mark is crossed, not once the bar is packed", () => {
    const { meta, history } = session();
    const used = computeContextBreakdown(history, meta, 0, 100_000, 128_000).usedTokens;

    // Below the trigger: calm on both counts.
    const calm = computeContextBreakdown(history, meta, 0, used * 2, 128_000);
    expect(calm.willCompact).toBe(false);
    expect(calm.over).toBe(false);

    // Between the trigger and the ceiling — the bar stands past its own line.
    // This is the band the old `over`-only state left unmarked.
    const ceiling = Math.floor(used / (COMPACT_TRIGGER + 0.1));
    expect(used).toBeGreaterThan(ceiling * COMPACT_TRIGGER);
    expect(used).toBeLessThanOrEqual(ceiling);
    const warned = computeContextBreakdown(history, meta, 0, ceiling, 128_000);
    expect(warned.willCompact).toBe(true);
    expect(warned.over).toBe(false);

    // Past the ceiling both hold — over implies willCompact.
    const packed = computeContextBreakdown(history, meta, 0, 10, 128_000);
    expect(packed.willCompact).toBe(true);
    expect(packed.over).toBe(true);
  });

  it("stays calm on an empty session with no ceiling to cross", () => {
    const b = computeContextBreakdown(null, null, 0, 0, 0);
    expect(b.willCompact).toBe(false);
  });
});

/**
 * 折叠线画在哪。
 *
 * 上面那组把 `toolTokens` 一律传 0——而在 0 上，旧口径和真实触发点恰好重合，
 * 所以整组绿着，条却一直画错。这一组的每个用例都带一份真实大小的工具 schema，
 * 并且**不自己复述阈值公式**：它跑真的 `planFold`，问它到底折不折。
 *
 * 差在哪：条的横轴是整个请求（schema 计入），而 `planFold` 拿 messages 去比一个
 * **已经扣掉 schema** 的上限（`messageCeilingFor`）。展开成对 messages 的阈值，
 * 一个是 `0.7C − 1.0T`，一个是 `0.7C − 0.7T`——前者更小，所以条比压缩**早**
 * 警告，那道线也偏左。1M 窗口上是个舍入误差，8k 的本地模型上是十五个百分点。
 */
describe("折叠线 vs planFold 的真实触发点", () => {
  /** 一段有头有尾的对话：system 进 prelude，turns 足够多，planFold 不会因轮数退出。 */
  function conversation(turns: number, charsPerTurn: number) {
    const meta = createSessionMeta();
    const history: StreamMessage[] = [{ role: "system", content: "系统提示" }];
    for (let i = 0; i < turns; i++) {
      const q: StreamMessage = { role: "user", content: "问".repeat(charsPerTurn) };
      noteTurnStart(meta, q);
      history.push(q, { role: "assistant", content: "答".repeat(charsPerTurn) });
    }
    return { history, meta };
  }

  it("带着真实工具开销逐点扫过去，willCompact 和 planFold 从不分家", () => {
    const TOOLS = 4_900;
    const { history, meta } = conversation(8, 120);
    const messages = estimateMessagesTokens(history);

    for (let ceiling = TOOLS + 50; ceiling <= TOOLS + messages * 2; ceiling += 37) {
      const bar = computeContextBreakdown(history, meta, TOOLS, ceiling, 128_000);
      const fold = planFold(history, meta, ceiling - TOOLS);
      expect({ ceiling, willCompact: bar.willCompact })
        .toEqual({ ceiling, willCompact: fold !== null });
    }
  });

  /**
   * 这一条是漂移本身：messages 落在 `(0.7C − T, 0.7C − 0.7T)` 这一段时，旧口径
   * 已经变黄、竖线也被越过，而 `planFold` 什么都不做。条上写着「越过此处将折叠
   * 最早的对话」，越过了，然后没有任何事发生。
   */
  it("旧口径会在这一段变黄，而压缩根本不会发生", () => {
    const TOOLS = 4_900;
    const C = 10_000;
    const { history, meta } = conversation(6, 190);
    const messages = estimateMessagesTokens(history);

    // 先证明这段历史确实落在那个窗口里，否则下面两条断言可能只是碰巧成立。
    expect(messages).toBeGreaterThan(COMPACT_TRIGGER * C - TOOLS);
    expect(messages).toBeLessThan(COMPACT_TRIGGER * (C - TOOLS));

    const bar = computeContextBreakdown(history, meta, TOOLS, C, 128_000);
    expect(bar.willCompact).toBe(false);
    expect(planFold(history, meta, C - TOOLS)).toBeNull();
    // 竖线也跟着挪到了真实触发点，不再是死板的 70%。
    expect(bar.compactMarkerPct).toBeCloseTo(70 + 30 * (TOOLS / C), 5);
    // 旧口径下 used 已经越过 0.7C——条会变黄、线会被越过，而上面刚证明不折。
    expect(bar.usedTokens).toBeGreaterThan(COMPACT_TRIGGER * C);
    // 新口径下它还没够到那条线。
    expect(bar.usedTokens).toBeLessThan((bar.compactMarkerPct / 100) * C);
  });

  it("没有工具的界面上，线仍然正好在 70%——这次改动不动它们", () => {
    const { history, meta } = conversation(4, 50);
    const bar = computeContextBreakdown(history, meta, 0, 100_000, 128_000);
    expect(bar.compactMarkerPct).toBeCloseTo(COMPACT_TRIGGER * 100, 5);
  });

  /**
   * schema 自己就吃光了上限。`planFold` 遇到非正的 ceiling 直接退出，所以压缩
   * 帮不上任何忙——但条**不能**因此一脸平静：那正是警示存在的理由。
   */
  it("工具 schema 吃光上限时压缩救不了，可条不能装作没事", () => {
    const { history, meta } = conversation(4, 50);
    const bar = computeContextBreakdown(history, meta, 9_000, 8_000, 128_000);
    expect(bar.over).toBe(true);
    expect(bar.willCompact).toBe(true);
    expect(planFold(history, meta, 8_000 - 9_000)).toBeNull();
  });
});

/**
 * 预估态（设计稿 13 · 2h）。
 *
 * 它的全部设计是那个「**≥**」：发送之前算得出三块固定的（系统提示 / 绑定块 /
 * 记忆块），算不出检索会拿到什么——那取决于作者还没打出来的一句话。所以这条画
 * 的是**下界**，而这一组守的就是「下界」这件事没有被悄悄画成「总量」。
 */
describe("computePreflightBreakdown", () => {
  const pre = (systemTokens = 12_400, boundTokens = 1_100, memoryTokens = 1_700) =>
    ({ systemTokens, boundTokens, memoryTokens });

  it("工具 schema 也在下界里——第一条请求一样带着它们", () => {
    const b = computePreflightBreakdown(pre(12_400, 1_100, 1_700), 4_900, 524_000, 1_049_000);
    const by = Object.fromEntries(b.segments.map((s) => [s.key, s.tokens]));
    expect(by.system).toBe(12_400 + 4_900);
    expect(b.lowerBoundTokens).toBe(12_400 + 1_100 + 1_700 + 4_900);
  });

  /**
   * **折叠竖线必须没有。**
   *
   * 那道线的意思是「越过这里，下一轮开始把最早的对话折叠成摘要」；发送之前一条
   * 对话都没有，画它就是画一个不存在的风险。更糟的是位置会骗人——预估是下界，
   * 条只会往右长，作者看到「离竖线还很远」，发送后可能已经越过去了。
   *
   * 所以类型里根本没有 `compactMarkerPct` / `willCompact` 这两个字段：让它画不
   * 出来，比让它算出来再嘱咐别画可靠。
   */
  it("没有折叠竖线，只有下界刻线", () => {
    const b = computePreflightBreakdown(pre(), 0, 524_000, 1_049_000);
    expect(b).not.toHaveProperty("compactMarkerPct");
    expect(b).not.toHaveProperty("willCompact");
    // 下界刻线落在三块之和上，不是 70%。
    expect(b.lowerBoundPct).toBeCloseTo((15_200 * 100) / 524_000, 5);
  });

  it("右边那一段是「还不知道」，不是「空余」——它一直撑到上限", () => {
    const b = computePreflightBreakdown(pre(), 0, 524_000, 1_049_000);
    const unknown = b.segments.find((s) => s.key === "unknown")!;
    expect(unknown.tokens).toBe(524_000 - 15_200);
    expect(b.segments.map((s) => s.key)).toEqual(["system", "bound", "memory", "unknown"]);
  });

  /** 三块固定的就已经超了上限：检索还没跑，条已经满了——这时候必须能看出来。 */
  it("下界本身就超出上限时 over 为真，未定纹被挤没", () => {
    const b = computePreflightBreakdown(pre(9_000, 500, 500), 0, 8_000, 16_000);
    expect(b.over).toBe(true);
    expect(b.segments.find((s) => s.key === "unknown")!.tokens).toBe(0);
    expect(b.lowerBoundPct).toBe(100);
  });

  it("还没算过预估时是一条只有工具开销的下界，不是崩", () => {
    const b = computePreflightBreakdown(null, 4_900, 524_000, 1_049_000);
    expect(b.lowerBoundTokens).toBe(4_900);
    expect(b.over).toBe(false);
  });
});
