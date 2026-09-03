/**
 * lib/search/globalSearch — the ⌘K palette's matching, ranking and windowing.
 *
 * What is pinned here is the *order* things come back in and *where* the
 * highlight lands, because those are the two things a reader of the palette
 * judges a search by — and both are invisible to the type checker.
 */
import { describe, expect, it } from "vitest";
import {
  matchText,
  parseQuery,
  recentLocations,
  searchFiles,
  searchLines,
  searchLore,
  windowAround,
  type FileNodeLike,
} from "../search/globalSearch";

describe("parseQuery", () => {
  it("reads a leading prefix as the scope and strips it from the term", () => {
    expect(parseQuery("/艾尔登")).toEqual({ scope: "lore", term: "艾尔登", prefix: "/" });
    expect(parseQuery("  # ch3 ")).toEqual({ scope: "files", term: "ch3", prefix: "#" });
    expect(parseQuery("?为什么")).toEqual({ scope: "ai", term: "为什么", prefix: "?" });
  });

  it("is scope all with no prefix, and a bare prefix has an empty term", () => {
    expect(parseQuery(" 雪地 ")).toEqual({ scope: "all", term: "雪地", prefix: null });
    expect(parseQuery("/")).toEqual({ scope: "lore", term: "", prefix: "/" });
    expect(parseQuery("")).toEqual({ scope: "all", term: "", prefix: null });
  });
});

describe("matchText", () => {
  it("returns null for an empty term — no query is not a match for everything", () => {
    expect(matchText("anything", "")).toBeNull();
    expect(matchText("anything", "   ")).toBeNull();
  });

  it("ranks substring at start > at a word boundary > in the middle > subsequence", () => {
    const s = (text: string) => matchText(text, "ren")!.score;
    expect(s("renwu.md")).toBeGreaterThan(s("ch3/renwu.md"));
    expect(s("ch3/renwu.md")).toBeGreaterThan(s("karen.md"));
    expect(s("karen.md")).toBeGreaterThan(s("r-e-n.md"));
  });

  it("highlights the substring, case-insensitively, at its original position", () => {
    expect(matchText("Elden Ring", "ring")!.ranges).toEqual([{ start: 6, end: 10 }]);
  });

  it("falls back to a subsequence and reports each run as its own range", () => {
    const m = matchText("人物小传.md", "人传")!;
    expect(m.ranges).toEqual([{ start: 0, end: 1 }, { start: 3, end: 4 }]);
  });

  it("can be told not to accept subsequences", () => {
    expect(matchText("人物小传", "人传", { subsequence: false })).toBeNull();
    expect(matchText("人物小传", "小传", { subsequence: false })).not.toBeNull();
  });

  it("requires every whitespace-separated token and merges overlapping ranges", () => {
    expect(matchText("第三章 人物小传", "人物 第三")).not.toBeNull();
    expect(matchText("第三章 人物小传", "人物 第四")).toBeNull();
    expect(matchText("abcd", "abc bcd")!.ranges).toEqual([{ start: 0, end: 4 }]);
  });
});

describe("windowAround", () => {
  it("leaves a short line alone", () => {
    expect(windowAround("short", [{ start: 0, end: 2 }], 80)).toEqual({ text: "short", ranges: [{ start: 0, end: 2 }] });
  });

  it("opens a window around the first hit, marks the cut ends and shifts the ranges", () => {
    const text = "x".repeat(100) + "HIT" + "y".repeat(100);
    const w = windowAround(text, [{ start: 100, end: 103 }], 30);
    expect(w.text.startsWith("…")).toBe(true);
    expect(w.text.endsWith("…")).toBe(true);
    expect(w.text.length).toBe(32);
    const r = w.ranges[0];
    expect(w.text.slice(r.start, r.end)).toBe("HIT");
  });

  it("does not run past the end when the hit is near it", () => {
    const text = "y".repeat(50) + "HIT";
    const w = windowAround(text, [{ start: 50, end: 53 }], 20);
    expect(w.text.endsWith("HIT")).toBe(true);
    expect(w.text.slice(w.ranges[0].start, w.ranges[0].end)).toBe("HIT");
  });
});

const ROOT = "/proj";
const tree: FileNodeLike[] = [
  { name: "第三章", path: "/proj/第三章", is_dir: true, children: [
    { name: "人物小传.md", path: "/proj/第三章/人物小传.md", is_dir: false },
    { name: "雪地.md", path: "/proj/第三章/雪地.md", is_dir: false },
    { name: "assets", path: "/proj/第三章/assets", is_dir: true, children: [
      { name: "雪地.png", path: "/proj/第三章/assets/雪地.png", is_dir: false },
    ] },
  ] },
  { name: "人物.md", path: "/proj/人物.md", is_dir: false },
  { name: "notes.txt", path: "/proj/notes.txt", is_dir: false },
];

describe("searchFiles", () => {
  it("never returns a folder and reports the folder-relative dir", () => {
    const { hits } = searchFiles(tree, ROOT, "章");
    expect(hits.map((h) => h.path)).not.toContain("/proj/第三章");
    expect(hits.find((h) => h.name === "人物小传.md")?.dir).toBe("第三章");
  });

  it("puts a name hit above a path-only hit, and a shorter path above a longer one", () => {
    const { hits } = searchFiles(tree, ROOT, "人物");
    expect(hits.map((h) => h.path)).toEqual(["/proj/人物.md", "/proj/第三章/人物小传.md"]);
    expect(hits[0].nameRanges).toEqual([{ start: 0, end: 2 }]);
  });

  it("lets one token land on the name and another on the dir, with ranges on each", () => {
    const { hits } = searchFiles(tree, ROOT, "三章 小传");
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe("/proj/第三章/人物小传.md");
    expect(hits[0].dirRanges).toEqual([{ start: 1, end: 3 }]);
    expect(hits[0].nameRanges).toEqual([{ start: 2, end: 4 }]);
  });

  it("counts every hit in total while returning only limit", () => {
    const r = searchFiles(tree, ROOT, "雪地", 1);
    expect(r.hits).toHaveLength(1);
    expect(r.total).toBe(2);
    expect(r.hits[0].path).toBe("/proj/第三章/雪地.md"); // shorter path first, same score
  });

  it("falls back to bare names when there is no root", () => {
    const { hits } = searchFiles(tree, null, "notes");
    expect(hits[0]).toMatchObject({ name: "notes.txt", dir: "" });
  });

  it("returns nothing for an empty term", () => {
    expect(searchFiles(tree, ROOT, "")).toEqual({ hits: [], total: 0 });
  });
});

describe("searchLore", () => {
  const lore = [
    { name: "艾尔登", aliases: ["老国王"] },
    { name: "艾尔登城", aliases: [] },
    { name: "玛丽卡", aliases: ["女王", "艾尔登之妻"] },
  ];

  it("ranks a name hit above an alias hit and says which alias matched", () => {
    const { hits, total } = searchLore(lore, "艾尔登");
    expect(total).toBe(3);
    expect(hits.map((h) => h.entity.name)).toEqual(["艾尔登", "艾尔登城", "玛丽卡"]);
    expect(hits[2]).toMatchObject({ via: "alias", alias: "艾尔登之妻" });
    expect(hits[0]).toMatchObject({ via: "name", alias: null, ranges: [{ start: 0, end: 3 }] });
  });

  it("picks the best alias when several match", () => {
    const { hits } = searchLore([{ name: "x", aliases: ["the king", "king"] }], "king");
    expect(hits[0].alias).toBe("king");
  });
});

describe("searchLines", () => {
  const doc = "第一行没有\n他在艾尔登城外的雪地里\n艾尔登\n又是雪地\n雪地雪地";

  it("returns document order, 1-based, only substrings, and counts the rest", () => {
    const r = searchLines(doc, "雪地", 2);
    expect(r.hits.map((h) => h.line)).toEqual([2, 4]);
    expect(r.total).toBe(3);
    expect(r.hits[0].ranges).toEqual([{ start: 8, end: 10 }]);
    expect(searchLines("人物小传", "人传").total).toBe(0);
  });
});

describe("recentLocations", () => {
  const past = [
    { kind: "editor", filePath: "/p/a.md" },
    { kind: "lore", entityDir: "/p/.ai-writer/lore/characters/elden" },
    { kind: "library" },
    { kind: "editor", filePath: null },
    { kind: "editor", filePath: "/p/b.md" },
    { kind: "editor", filePath: "/p/a.md" },
  ];

  it("is newest first, deduplicated, without the current location or address-less kinds", () => {
    const out = recentLocations(past, { kind: "editor", filePath: "/p/b.md" });
    expect(out).toEqual([
      { kind: "editor", filePath: "/p/a.md" },
      { kind: "lore", entityDir: "/p/.ai-writer/lore/characters/elden" },
    ]);
  });

  it("drops what no longer exists and honours the limit", () => {
    const out = recentLocations(past, null, { exists: (l) => l.kind === "editor", limit: 1 });
    expect(out).toEqual([{ kind: "editor", filePath: "/p/a.md" }]);
  });
});
