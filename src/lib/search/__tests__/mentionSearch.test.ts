/**
 * lib/search/mentionSearch — the `@` picker's scoping, ranking and the
 * empty-query interleave.
 *
 * Pinned here is what the old `includes` filter got wrong: that an alias or a
 * group path can find a candidate, that a name hit outranks both, that an
 * empty query shows both kinds, and that a scope is a hard filter.
 */
import { describe, expect, it } from "vitest";
import {
  availableScopes,
  countByScope,
  cycleScope,
  hasHits,
  mentionSub,
  scopeOf,
  searchMentions,
  type MentionLike,
} from "../mentionSearch";

const ROOT = "/p";
const lore = (name: string, aliases: string[] = []): MentionLike => ({ type: "lore", entity: { name, aliases } });
const file = (rel: string, kind: "text" | "image" | "media" = "text"): MentionLike => ({
  type: "file",
  file: { name: rel.split("/").pop()!, path: `${ROOT}/${rel}`, kind },
});
const names = (r: { items: MentionLike[] }) =>
  r.items.map((i) => (i.type === "lore" ? i.entity.name : i.file.name));

describe("scopeOf / availableScopes", () => {
  it("puts recordings with documents — the scopes say file or entry", () => {
    expect(scopeOf(file("a.m4a", "media"))).toBe("text");
    expect(scopeOf(file("a.png", "image"))).toBe("image");
    expect(scopeOf(lore("甲"))).toBe("lore");
  });

  it("offers only the kinds that are present, all first", () => {
    expect(availableScopes([lore("甲"), file("a.md")])).toEqual(["all", "lore", "text"]);
    expect(availableScopes([lore("甲"), file("a.md"), file("b.png", "image")])).toEqual(["all", "lore", "text", "image"]);
    // A file of any kind keeps the document chip: the row's shape must not
    // depend on whether this project happens to have pictures.
    expect(availableScopes([file("b.png", "image")])).toEqual(["all", "text", "image"]);
    expect(availableScopes([lore("甲")])).toEqual(["all", "lore"]);
  });
});

describe("cycleScope", () => {
  it("steps through the offered scopes and wraps", () => {
    const scopes = ["all", "lore", "text"] as const;
    expect(cycleScope(scopes, "all", 1)).toBe("lore");
    expect(cycleScope(scopes, "text", 1)).toBe("all");
    expect(cycleScope(scopes, "all", -1)).toBe("text");
    // The image scope vanished with the last picture: start over.
    expect(cycleScope(scopes, "image", 1)).toBe("all");
  });

  it("from an empty list, skips the chips that are empty too — «Tab 切过去» is one press", () => {
    const scopes = ["all", "lore", "text", "image"] as const;
    const onlyImages = { lore: 0, text: 0, image: 2 };
    expect(cycleScope(scopes, "lore", 1, onlyImages)).toBe("image");
    expect(cycleScope(scopes, "lore", -1, onlyImages)).toBe("all");
    // Nothing anywhere: the plain step, so Tab still moves.
    expect(cycleScope(scopes, "lore", 1, { lore: 0, text: 0, image: 0 })).toBe("text");
  });
});

describe("mentionSub", () => {
  it("is the document's group path, nothing at the root and nothing for an entry", () => {
    expect(mentionSub(file("正文/第一卷/第三章.md"), ROOT)).toBe("正文/第一卷");
    expect(mentionSub(file("大纲.md"), ROOT)).toBeNull();
    expect(mentionSub(lore("甲"), ROOT)).toBeNull();
    expect(mentionSub(file("正文/第三章.md"), null)).toBeNull();
  });
});

describe("searchMentions — typed query", () => {
  const items: MentionLike[] = [
    file("正文/潮汐门篇/第五章 归途.md"),
    lore("沈砚", ["阿砚"]),
    file("第三章 潮汐门.md"),
    lore("潮汐门"),
    file("封面.png", "image"),
  ];

  it("finds an entry by alias and a document by its group path", () => {
    expect(names(searchMentions(items, "阿砚", "all", ROOT))).toEqual(["沈砚"]);
    expect(names(searchMentions(items, "潮汐门篇", "all", ROOT))).toEqual(["第五章 归途.md"]);
  });

  it("ranks a name hit above a path hit for the same word", () => {
    const r = searchMentions(items, "潮", "all", ROOT);
    expect(names(r)).toEqual(["潮汐门", "第三章 潮汐门.md", "第五章 归途.md"]);
    // The highlight lands where the hit was: name, name, then the sub line.
    expect(r.hits.get(0)?.label).toEqual([{ start: 0, end: 1 }]);
    expect(r.hits.get(1)?.label).toEqual([{ start: 4, end: 5 }]);
    expect(r.hits.get(2)?.label).toEqual([]);
    expect(r.hits.get(2)?.sub).toEqual([{ start: 3, end: 4 }]);
  });

  it("finds a document by 分组/名字 in one word — the form a host can actually type", () => {
    // A space ends a mention, so the picker never sends two tokens; the `/`
    // is how one word names both the group and the document.
    const r = searchMentions(items, "潮汐门篇/第五", "all", ROOT);
    expect(names(r)).toEqual(["第五章 归途.md"]);
    // Ranges split back onto the two lines, the `/` on neither.
    expect(r.hits.get(0)?.sub).toEqual([{ start: 3, end: 7 }]);
    expect(r.hits.get(0)?.label).toEqual([{ start: 0, end: 2 }]);
    // The word after the `/` need not open the title: the group plus any
    // word of the name, as an author remembers a chapter.
    const mid = searchMentions(items, "潮汐门篇/归途", "all", ROOT);
    expect(names(mid)).toEqual(["第五章 归途.md"]);
    expect(mid.hits.get(0)?.sub).toEqual([{ start: 3, end: 7 }]);
    expect(mid.hits.get(0)?.label).toEqual([{ start: 4, end: 6 }]);
    // But the left side is still held to the group, exactly: no subsequence.
    expect(names(searchMentions(items, "潮篇/归途", "all", ROOT))).toEqual([]);
    // A bare `/` at either end is no split — the path tier alone decides.
    expect(names(searchMentions(items, "/第五", "all", ROOT))).toEqual(["第五章 归途.md"]);
    expect(names(searchMentions(items, "潮汐门篇/", "all", ROOT))).toEqual(["第五章 归途.md"]);
  });

  it("never matches the group path or the full path by subsequence — a hit here has teeth", () => {
    const docs = [file("正文/小镇/李家.md"), file("正文/小镇/第一章 李家.md")];
    // `@小李` before Enter must not turn into `@[李家.md]` plus an attachment.
    expect(names(searchMentions(docs, "小李", "all", ROOT))).toEqual([]);
    expect(countByScope(docs, "小李", ROOT)).toEqual({ lore: 0, text: 0, image: 0 });
    // Substring and word start on the group still count.
    expect(names(searchMentions(docs, "小镇", "all", ROOT))).toEqual(["李家.md", "第一章 李家.md"]);
  });

  it("lets each word hit a different field, as ⌘K does (lib-level parity; a host sends one word)", () => {
    expect(names(searchMentions(items, "潮汐门篇 归途", "all", ROOT))).toEqual(["第五章 归途.md"]);
    const r = searchMentions(items, "潮汐门篇 归途", "all", ROOT);
    expect(r.hits.get(0)?.label).toEqual([{ start: 4, end: 6 }]);
    expect(r.hits.get(0)?.sub).toEqual([{ start: 3, end: 7 }]);
    expect(countByScope(items, "潮汐门篇 归途", ROOT)).toEqual({ lore: 0, text: 1, image: 0 });
  });

  it("takes the best field per word, so a whole-word alias beats a scattered name", () => {
    const pair = [lore("潮网汐路门"), lore("门前潮", ["潮汐门"])];
    expect(names(searchMentions(pair, "潮汐门", "all", ROOT))).toEqual(["门前潮", "潮网汐路门"]);
    expect(searchMentions(pair, "潮汐门", "all", ROOT).hits.get(0)?.alias).toBe("潮汐门");
  });

  it("reports which alias matched, and where in it, so the row can show it", () => {
    const r = searchMentions(items, "砚", "all", ROOT);
    // The name itself has 砚 — the alias is not consulted.
    expect(r.hits.get(0)?.alias).toBeNull();
    const byAlias = searchMentions(items, "阿", "all", ROOT);
    expect(byAlias.hits.get(0)?.alias).toBe("阿砚");
    expect(byAlias.hits.get(0)?.aliasRanges).toEqual([{ start: 0, end: 1 }]);
    expect(byAlias.hits.get(0)?.label).toEqual([]);
  });

  it("matches anywhere in the name, case-insensitively, and by subsequence", () => {
    const docs = [file("Chapter Three.md"), file("Notes.md")];
    expect(names(searchMentions(docs, "three", "all", ROOT))).toEqual(["Chapter Three.md"]);
    expect(names(searchMentions(docs, "chth", "all", ROOT))).toEqual(["Chapter Three.md"]);
  });

  it("a scope is a hard filter", () => {
    expect(names(searchMentions(items, "潮", "lore", ROOT))).toEqual(["潮汐门"]);
    expect(names(searchMentions(items, "潮", "text", ROOT))).toEqual(["第三章 潮汐门.md", "第五章 归途.md"]);
    expect(names(searchMentions(items, "潮", "image", ROOT))).toEqual([]);
  });

  it("cuts at the limit after ranking", () => {
    const many = Array.from({ length: 30 }, (_, i) => lore(`条目${i}`));
    expect(searchMentions(many, "条目", "all", ROOT, 10).items).toHaveLength(10);
    expect(searchMentions(many, "条目", "all", ROOT).items).toHaveLength(10);
  });
});

describe("searchMentions — empty query", () => {
  it("interleaves kinds so a file shows even behind twenty entries", () => {
    const items = [
      ...Array.from({ length: 20 }, (_, i) => lore(`条目${i}`)),
      file("a.md"), file("b.md"), file("c.png", "image"),
    ];
    const r = searchMentions(items, "", "all", ROOT);
    expect(names(r)).toEqual([
      "条目0", "a.md", "c.png",
      "条目1", "b.md",
      "条目2", "条目3", "条目4", "条目5", "条目6",
    ]);
    expect(r.hits.size).toBe(0);
  });

  it("keeps the host's order inside a kind and honours the scope", () => {
    const items = [file("b.md"), lore("乙"), file("a.md"), lore("甲")];
    expect(names(searchMentions(items, "  ", "all", ROOT))).toEqual(["乙", "b.md", "甲", "a.md"]);
    expect(names(searchMentions(items, "", "text", ROOT))).toEqual(["b.md", "a.md"]);
  });
});

describe("countByScope", () => {
  const items: MentionLike[] = [lore("潮汐门"), lore("沈砚"), file("第三章 潮汐门.md"), file("封面.png", "image"), file("旁白.m4a", "media")];

  it("counts every kind for the query, never scoped and never cut", () => {
    expect(countByScope(items, "潮", ROOT)).toEqual({ lore: 1, text: 1, image: 0 });
    expect(countByScope(items, "", ROOT)).toEqual({ lore: 2, text: 2, image: 1 });
    expect(countByScope(items, "无", ROOT)).toEqual({ lore: 0, text: 0, image: 0 });
    expect(hasHits(countByScope(items, "无", ROOT))).toBe(false);
    expect(hasHits(countByScope(items, "潮", ROOT))).toBe(true);
  });
});
