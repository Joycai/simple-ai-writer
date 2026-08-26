import { describe, it, expect } from "vitest";
import {
  digestPath,
  serializeDigest,
  parseDigest,
  digestStatus,
  buildDigestInput,
  type CollectionDigest,
  type DigestSourceItem,
} from "../context/collectionDigest";
import { hashText, type DocMemory } from "../context/memory";
import { matchEntitiesInText } from "../lore/match";
import type { LoreEntity, LoreIndex } from "../lore/model";

function digestOf(volume: string, chapters: { rel: string; content: string }[]): CollectionDigest {
  return {
    volume,
    chapters: chapters.map((c) => ({ rel: c.rel, hash: hashText(c.content) })),
    updatedAt: "2026-08-17T00:00:00.000Z",
    summary: "一段摘要",
  };
}

describe("digestPath", () => {
  it("nests the digest file inside the volume's own directory", () => {
    expect(digestPath("D:/proj", "写作/第一部")).toBe(
      "D:/proj/.ai-writer/collections/写作/第一部/digest.md",
    );
  });

  it("puts the root volume's digest directly under collections/", () => {
    expect(digestPath("D:\\proj", "")).toBe("D:/proj/.ai-writer/collections/digest.md");
  });
});

describe("serialize / parse round trip", () => {
  it("keeps metadata and a multi-line summary intact", () => {
    const digest = digestOf("卷一", [
      { rel: "卷一/第1章.md", content: "甲" },
      { rel: "卷一/第2章.md", content: "乙" },
    ]);
    digest.summary = "第一行。\n\n第二段，含 ## 井号开头也无妨。";
    const parsed = parseDigest(serializeDigest(digest));
    expect(parsed).toEqual(digest);
  });

  it("returns null for a file without the metadata comment", () => {
    expect(parseDigest("just some text")).toBeNull();
  });

  it("returns null for corrupt metadata JSON", () => {
    expect(parseDigest("<!-- ai-writer-digest\n{oops\n-->\n\nsummary")).toBeNull();
  });
});

describe("digestStatus", () => {
  const chapters = [
    { rel: "v/1.md", content: "第一章内容" },
    { rel: "v/2.md", content: "第二章内容" },
  ];

  it("is none without a digest", () => {
    expect(digestStatus(null, chapters)).toBe("none");
  });

  it("is fresh when the chapter list and hashes match", () => {
    expect(digestStatus(digestOf("v", chapters), chapters)).toBe("fresh");
  });

  it("goes stale when a chapter's content changes", () => {
    const digest = digestOf("v", chapters);
    const edited = [chapters[0], { rel: "v/2.md", content: "改写过的第二章" }];
    expect(digestStatus(digest, edited)).toBe("stale");
  });

  it("goes stale when a chapter is added or removed", () => {
    const digest = digestOf("v", chapters);
    expect(digestStatus(digest, chapters.slice(0, 1))).toBe("stale");
    expect(digestStatus(digest, [...chapters, { rel: "v/3.md", content: "三" }])).toBe("stale");
  });

  it("goes stale on reorder — the digest narrates an arc", () => {
    const digest = digestOf("v", chapters);
    expect(digestStatus(digest, [chapters[1], chapters[0]])).toBe("stale");
  });
});

describe("buildDigestInput", () => {
  const mem = (summaries: string[]): DocMemory => ({
    sourcePath: "v/1.md",
    coveredChars: 100,
    updatedAt: "",
    segments: summaries.map((s, i) => ({ from: i * 10, to: i * 10 + 10, hash: "x", summary: s })),
  });
  const item = (over: Partial<DigestSourceItem>): DigestSourceItem => ({
    title: "第1章",
    content: "正文内容",
    memory: null,
    memoryFresh: false,
    ...over,
  });

  it("prefers a fresh story memory's summaries over the raw content", () => {
    const input = buildDigestInput(
      [item({ memory: mem(["摘要一", "摘要二"]), memoryFresh: true })],
      10_000,
    );
    expect(input).toContain("摘要一\n摘要二");
    expect(input).not.toContain("正文内容");
  });

  it("falls back to content when the memory is stale", () => {
    const input = buildDigestInput(
      [item({ memory: mem(["旧摘要"]), memoryFresh: false })],
      10_000,
    );
    expect(input).toContain("正文内容");
    expect(input).not.toContain("旧摘要");
  });

  it("labels every item with its title", () => {
    const input = buildDigestInput(
      [item({ title: "序章" }), item({ title: "第2章", content: "更多内容" })],
      10_000,
    );
    expect(input).toContain("## 序章");
    expect(input).toContain("## 第2章");
  });

  it("shrinks over-budget items to an equal share", () => {
    const long = "长".repeat(5000);
    const input = buildDigestInput(
      [item({ content: long }), item({ title: "第2章", content: long })],
      2000,
    );
    // Each item gets ~1000 chars (above the 400 floor), plus the ellipsis.
    expect(input.length).toBeLessThan(2400);
    expect(input).toContain("…");
  });

  it("never shrinks an item below the floor even when the budget says so", () => {
    const long = "长".repeat(5000);
    const items = Array.from({ length: 10 }, (_, i) => item({ title: `第${i}章`, content: long }));
    const input = buildDigestInput(items, 1000); // 100 chars/item < 400 floor
    for (const line of input.split("\n\n")) {
      if (line.startsWith("## ")) continue;
      expect(line.length).toBeGreaterThanOrEqual(400);
    }
  });

  it("returns empty for no items", () => {
    expect(buildDigestInput([], 1000)).toBe("");
  });
});

describe("matchEntitiesInText", () => {
  const entity = (name: string, aliases: string[] = []): LoreEntity => ({
    id: name,
    category: "characters",
    dirPath: `/lore/characters/${name}`,
    name,
    aliases,
    summary: "",
    avatarPath: null,
    collections: [],
    mdFiles: [],
    images: [],
    facets: [],
  });
  const index: LoreIndex = {
    characters: [entity("林远", ["远哥"]), entity("Elden", ["老皇帝"])],
    world: [entity("落霞城")],
  };

  it("matches by name and by alias, across categories", () => {
    const found = matchEntitiesInText("远哥带人进了落霞城。", index);
    expect(found.map((e) => e.name).sort()).toEqual(["林远", "落霞城"]);
  });

  it("is case-insensitive for latin names", () => {
    const found = matchEntitiesInText("elden 登基了", index);
    expect(found.map((e) => e.name)).toEqual(["Elden"]);
  });

  it("returns nothing for empty text or no mentions", () => {
    expect(matchEntitiesInText("", index)).toEqual([]);
    expect(matchEntitiesInText("无关内容", index)).toEqual([]);
  });
});
