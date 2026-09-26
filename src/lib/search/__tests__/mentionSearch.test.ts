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

  it("lets each word hit a different field, as ⌘K does", () => {
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

  it("reports which alias matched so the row can say so", () => {
    const r = searchMentions(items, "阿砚", "all", ROOT);
    expect(r.hits.get(0)?.alias).toBe("阿砚");
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
  });
});
