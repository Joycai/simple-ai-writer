/**
 * PR3 of chat-memory compaction (docs/chat-memory-plan.md §5): per-turn
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
  noteTurnStart,
  planFold,
  recordInjections,
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
