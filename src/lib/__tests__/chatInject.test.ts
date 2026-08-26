/**
 * PR3 of chat-memory compaction (docs/feature/agent/chat-memory-plan.md §5): per-turn
 * retrieval with the injection ledger — dedup, content-change re-injection,
 * carrier-based eviction on fold, and the summary render skipping carriers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCompactedHistory,
  createSessionMeta,
  entityVersion,
  excludeDirsFor,
  injectionCarriers,
  clearCarrier,
  coreDoneFor,
  injectedFacetsFor,
  noteTurnStart,
  planFold,
  recordInjection,
  recordInjections,
  recordInjectionsFromReport,
  renderTurnsForSummary,
  segmentHistory,
} from "../agent/compact";
import { assembleTurnInjection } from "../context/rag";
import { selectLore } from "../context/loreSelect";
import type { LoreEntity, LoreIndex } from "../lore";
import type { StreamMessage } from "../ai/types";

vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));

const files = new Map<string, string>();
vi.mock("../fs/fileio", () => ({
  readFile: async (path: string) => {
    const content = files.get(path);
    if (content == null) throw new Error(`no such file: ${path}`);
    return content;
  },
}));

function entity(name: string, dir: string, summary = ""): LoreEntity {
  return {
    name, aliases: [], dirPath: dir, summary,
  } as unknown as LoreEntity;
}

function makeIndex(): LoreIndex {
  return {
    characters: [
      entity("Aria", "/proj/lore/characters/aria", "a bard"),
      entity("Bran", "/proj/lore/characters/bran", "a smith"),
    ],
  } as unknown as LoreIndex;
}

beforeEach(() => {
  files.clear();
  files.set("/proj/lore/characters/aria/index.md", "Aria is a bard.");
  files.set("/proj/lore/characters/bran/index.md", "Bran is a smith.");
});

describe("selectLore excludeDirs", () => {
  it("skips excluded dirs during auto-match but honors pins", async () => {
    const excluded = await selectLore("Aria met Bran", makeIndex(), [], undefined, {
      excludeDirs: new Set(["/proj/lore/characters/aria"]),
    });
    expect(excluded.text).not.toContain("Aria is a bard.");
    expect(excluded.text).toContain("Bran is a smith.");

    // A pin is the author insisting — exclusion does not apply.
    const pinned = await selectLore("nothing matches", makeIndex(),
      ["/proj/lore/characters/aria"], undefined,
      { excludeDirs: new Set(["/proj/lore/characters/aria"]) });
    expect(pinned.text).toContain("Aria is a bard.");
  });
});

describe("injection ledger", () => {
  it("excludes unchanged entities and re-admits changed ones", () => {
    const meta = createSessionMeta();
    const idx = makeIndex();
    const aria = idx.characters[0];
    const carrier: StreamMessage = { role: "user", content: "inj" };
    recordInjections(meta, [aria], carrier);

    expect(excludeDirsFor(meta, idx)).toEqual(new Set([aria.dirPath]));

    // The author edits Aria's summary — the fingerprint no longer matches.
    const edited = { ...idx, characters: [entity("Aria", aria.dirPath, "a *retired* bard"), idx.characters[1]] } as LoreIndex;
    expect(excludeDirsFor(meta, edited).size).toBe(0);

    // Re-injecting records the new version.
    recordInjections(meta, [edited.characters[0]], carrier);
    expect(excludeDirsFor(meta, edited)).toEqual(new Set([aria.dirPath]));
    expect(meta.injected.get(aria.dirPath)!.version).toBe(entityVersion(edited.characters[0]));
  });

  it("evicts entries when their carrier is folded away, keeping live ones", () => {
    const meta = createSessionMeta();
    const idx = makeIndex();
    const history: StreamMessage[] = [{ role: "system", content: "sys" }];
    // Turn 0 carries Aria via an injection message; turn 2 carries Bran.
    const mkTurn = (i: number, carried?: LoreEntity) => {
      const msgs: StreamMessage[] = [];
      if (carried) {
        const injMsg: StreamMessage = { role: "user", content: `inj-${carried.name}` };
        recordInjections(meta, [carried], injMsg);
        msgs.push(injMsg);
      }
      const start: StreamMessage = { role: "user", content: `q${i}` + "设".repeat(1500) };
      noteTurnStart(meta, start);
      msgs.push(start, { role: "assistant", content: `a${i}` + "设".repeat(1500) });
      return msgs;
    };
    // Injection messages precede the question they accompany, i.e. they sit at
    // the tail of the previous turn — mkTurn models the same order.
    history.push(...mkTurn(0), ...mkTurn(1), ...mkTurn(2, idx.characters[0]), ...mkTurn(3, idx.characters[1]));

    const plan = planFold(history, meta, 15_000)!;
    expect(plan).not.toBeNull();
    // Aria's carrier (tail of turn 1) folds; Bran's (tail of turn 2) survives.
    expect(plan.fold.length).toBeGreaterThanOrEqual(2);
    expect(plan.fold.length).toBeLessThan(4);

    buildCompactedHistory(history, meta, plan, "s");
    expect(meta.injected.has(idx.characters[0].dirPath)).toBe(false);
    expect(meta.injected.has(idx.characters[1].dirPath)).toBe(true);
    expect(excludeDirsFor(meta, idx)).toEqual(new Set([idx.characters[1].dirPath]));
  });

  it("keeps injection carriers out of the summarizer input", () => {
    const meta = createSessionMeta();
    const injMsg: StreamMessage = { role: "user", content: "【设定资料】Aria is a bard." };
    recordInjections(meta, [makeIndex().characters[0]], injMsg);
    const start: StreamMessage = { role: "user", content: "q1" };
    noteTurnStart(meta, start);
    const history: StreamMessage[] = [
      { role: "system", content: "sys" }, start, injMsg,
      { role: "assistant", content: "a1" },
    ];
    const rendered = renderTurnsForSummary(
      segmentHistory(history, meta).turns,
      injectionCarriers(meta),
    );
    expect(rendered).toContain("[user] q1");
    expect(rendered).toContain("[assistant] a1");
    expect(rendered).not.toContain("设定资料");
  });
});

describe("assembleTurnInjection", () => {
  it("returns empty text when nothing net-new matches", async () => {
    const idx = makeIndex();
    const inj = await assembleTurnInjection({
      loreIndex: idx,
      matchTarget: "Aria again",
      excludeDirs: new Set(["/proj/lore/characters/aria"]),
    });
    expect(inj.text).toBe("");
    expect(inj.matchedEntities).toHaveLength(0);
  });

  it("injects net-new lore with the standard section label", async () => {
    const inj = await assembleTurnInjection({
      loreIndex: makeIndex(),
      matchTarget: "tell me about Bran",
      excludeDirs: new Set(),
    });
    // i18n is mocked to echo keys: the preamble key + the profile label key.
    expect(inj.text).toContain("ai.instructions.chatInjection");
    expect(inj.text).toContain("Bran is a smith.");
    expect(inj.text).not.toContain("Aria is a bard.");
    expect(inj.matchedEntities.map((e) => e.name)).toEqual(["Bran"]);
    expect(inj.loreReport.entities).toHaveLength(1);
    expect(inj.docChars).toBe(0);
  });

  it("adds file, recap and window blocks when the turn asks for the body", async () => {
    const memory = {
      sourcePath: "writing/ch2.md",
      coveredChars: 5000,
      updatedAt: "",
      segments: [{ from: 0, to: 5000, hash: "h", summary: "前情：主角进城。" }],
    };
    const doc = "y".repeat(3000) + "新章节的近期正文。";
    const inj = await assembleTurnInjection({
      loreIndex: makeIndex(),
      matchTarget: "没有实体匹配",
      excludeDirs: new Set(),
      doc: {
        filePath: "/proj/writing/ch2.md",
        body: { documentText: doc, memory, contextChars: 500, memoryBudgetChars: 1000 },
      },
    });
    expect(inj.text).toContain("/proj/writing/ch2.md");
    expect(inj.text).toContain("前情：主角进城。");
    expect(inj.text).toContain("新章节的近期正文。");
    expect(inj.docChars).toBe(500);
    expect(inj.memoryChars).toBeGreaterThan(0);
    expect(inj.loreReport.entities).toHaveLength(0);
  });

  it("names the document without its text when only a brief is sent", async () => {
    // The default on a document switch: the assistant is told where the author
    // is, and reads the file itself if the question turns out to be about it.
    const inj = await assembleTurnInjection({
      loreIndex: makeIndex(),
      matchTarget: "没有实体匹配",
      excludeDirs: new Set(),
      doc: {
        filePath: "writing/ch2.md",
        brief: "标题: 第二章\n篇幅: 约 3,000 字",
      },
    });
    expect(inj.text).toContain("writing/ch2.md");
    expect(inj.text).toContain("第二章");
    expect(inj.docChars).toBe(0);
    expect(inj.memoryChars).toBe(0);
  });
});

/**
 * 账本的分层（docs/feature/roleplay/11-lore-binding-lld.md §4.3）。
 *
 * 从前账本按条目记：一个条目进过上下文，它就整体退出后续检索——于是第 2 轮
 * 提过 Aria 之后，第 8 轮问「她那件外套」永远拿不到 `outfit.md`。正文和特征
 * 的寿命本来就不同（正文可能住在一个永不折叠的块里，特征挂在某一轮上），
 * 一个共享的 carrier 只可能对其中一个是对的。
 */
describe("injection ledger — 分层", () => {
  const ARIA_DIR = "/proj/lore/characters/aria";

  function facetIndex(summary = "a bard"): LoreIndex {
    return {
      characters: [{
        name: "Aria", aliases: [], dirPath: ARIA_DIR, summary,
        facets: [
          { file: "outfit.md", title: "外套", slot: null, keys: ["外套"], group: null, priority: 0, mode: "auto", charCount: 12 },
          { file: "voice.md", title: "语气", slot: null, keys: ["语气"], group: null, priority: 0, mode: "auto", charCount: 15 },
        ],
      }],
    } as unknown as LoreIndex;
  }
  const ariaOf = (idx: LoreIndex) => idx.characters![0] as LoreEntity;

  beforeEach(() => {
    files.set(`${ARIA_DIR}/outfit.md`, "A grey coat.");
    files.set(`${ARIA_DIR}/voice.md`, "Speaks tersely.");
  });

  it("第 8 轮问「那件外套」：正文不重发，特征补进来", async () => {
    const meta = createSessionMeta();
    const idx = facetIndex();

    // 第 2 轮：提到 Aria，正文进上下文。
    const first = await assembleTurnInjection({ loreIndex: idx, matchTarget: "Aria 走进来。" });
    expect(first.text).toContain("Aria is a bard.");
    recordInjectionsFromReport(meta, first.loreReport, idx, { role: "user", content: first.text });

    // 第 8 轮：问那件外套——从前这里什么都拿不到。
    const second = await assembleTurnInjection({
      loreIndex: idx,
      matchTarget: "Aria 那件外套呢？",
      coreDone: coreDoneFor(meta, idx),
      excludeFacets: injectedFacetsFor(meta, idx),
    });
    expect(second.text).toContain("A grey coat.");
    expect(second.text).not.toContain("Aria is a bard.");
    expect(second.text).not.toContain("> a bard");
    recordInjectionsFromReport(meta, second.loreReport, idx, { role: "user", content: second.text });

    // 第 9 轮：外套已经在上下文里了，不再重发；另一段照常补。
    const third = await assembleTurnInjection({
      loreIndex: idx,
      // 名字仍要出现——条目不命中，特征就无从谈起（这道门槛是 G1，扮演侧在 PR-3 用 pin 绕开）。
      matchTarget: "Aria 的外套和语气都变了。",
      coreDone: coreDoneFor(meta, idx),
      excludeFacets: injectedFacetsFor(meta, idx),
    });
    expect(third.text).not.toContain("A grey coat.");
    expect(third.text).toContain("Speaks tersely.");
  });

  it("只有摘要挤进预算时，正文不算已送", async () => {
    const meta = createSessionMeta();
    const idx = facetIndex();
    // L0 摘要是保底层，预算耗尽也会进；正文没进就不能记成「已经给过了」，
    // 否则它这辈子都到不了模型面前。
    const tiny = await assembleTurnInjection({
      loreIndex: idx, matchTarget: "Aria 走进来。", loreBudgetChars: 10,
    });
    expect(tiny.text).toContain("a bard");
    expect(tiny.text).not.toContain("Aria is a bard.");
    recordInjectionsFromReport(meta, tiny.loreReport, idx, { role: "user", content: tiny.text });
    expect(coreDoneFor(meta, idx).size).toBe(0);
  });

  it("正文和特征各记各的 carrier，互不覆盖", () => {
    const meta = createSessionMeta();
    const idx = facetIndex();
    const bound: StreamMessage = { role: "user", content: "【绑定设定】…" };
    const turn: StreamMessage = { role: "user", content: "【设定资料】…" };

    recordInjection(meta, ariaOf(idx), bound, { core: true });
    recordInjection(meta, ariaOf(idx), turn, { facets: ["outfit.md"] });

    const rec = meta.injected.get(ARIA_DIR)!;
    expect(rec.coreCarrier).toBe(bound);
    expect(rec.facetCarriers.get("outfit.md")).toBe(turn);

    // 作者改了条目：旧账目描述的是一份已经被改写的文本，整条作废。
    recordInjection(meta, ariaOf(facetIndex("a *retired* bard")), turn, { facets: ["outfit.md"] });
    expect(meta.injected.get(ARIA_DIR)!.coreCarrier).toBeNull();
  });

  it("clearCarrier 只忘掉这一条消息带来的东西", () => {
    const meta = createSessionMeta();
    const idx = facetIndex();
    const bound: StreamMessage = { role: "user", content: "【绑定设定】…" };
    const turn: StreamMessage = { role: "user", content: "【设定资料】…" };
    recordInjection(meta, ariaOf(idx), bound, { core: true, facets: ["outfit.md"] });
    recordInjection(meta, ariaOf(idx), turn, { facets: ["voice.md"] });

    clearCarrier(meta, bound);

    const rec = meta.injected.get(ARIA_DIR)!;
    expect(rec.coreCarrier).toBeNull();
    expect(rec.facetCarriers.has("outfit.md")).toBe(false);
    expect(rec.facetCarriers.get("voice.md")).toBe(turn); // 别人带来的不动

    clearCarrier(meta, turn);
    expect(meta.injected.has(ARIA_DIR)).toBe(false); // 空了就整条忘掉
  });

  it("折叠只带走挂在那一轮上的特征，prelude 里的正文原地不动", () => {
    const meta = createSessionMeta();
    const idx = facetIndex();
    // 正文住在 prelude 的一个常驻块里（扮演的绑定块就是这个形状），
    // 特征挂在某一轮的尾部。
    const bound: StreamMessage = { role: "user", content: "【绑定设定】Aria is a bard." };
    recordInjection(meta, ariaOf(idx), bound, { core: true });

    const history: StreamMessage[] = [{ role: "system", content: "sys" }, bound];
    const mkTurn = (i: number, facet?: string) => {
      const msgs: StreamMessage[] = [];
      if (facet) {
        const injMsg: StreamMessage = { role: "user", content: `inj-${facet}` };
        recordInjection(meta, ariaOf(idx), injMsg, { facets: [facet] });
        msgs.push(injMsg);
      }
      const start: StreamMessage = { role: "user", content: `q${i}` + "设".repeat(1500) };
      noteTurnStart(meta, start);
      msgs.push(start, { role: "assistant", content: `a${i}` + "设".repeat(1500) });
      return msgs;
    };
    history.push(...mkTurn(0), ...mkTurn(1), ...mkTurn(2, "outfit.md"), ...mkTurn(3));

    const plan = planFold(history, meta, 15_000)!;
    expect(plan).not.toBeNull();
    buildCompactedHistory(history, meta, plan, "s");

    const rec = meta.injected.get(ARIA_DIR)!;
    expect(rec.coreCarrier).toBe(bound);          // 块还在，正文就还在
    expect(rec.facetCarriers.size).toBe(0);       // 那一轮没了，特征也就没了
    expect(coreDoneFor(meta, idx)).toEqual(new Set([ARIA_DIR]));
    expect(injectedFacetsFor(meta, idx).size).toBe(0);
  });
});
