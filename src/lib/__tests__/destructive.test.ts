/**
 * Which approved lore steps still stop and ask (设计稿 02h 1g / 1i).
 *
 * Pinned: the ratio is of the body, not the frontmatter; a correction does not
 * stop, a replacement does; a stub being filled in never stops; citations are
 * resolved the way the renderer resolves them; and this card is never covered
 * by 本次都批准.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = new Map<string, string>();

vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!fs.has(p)) throw new Error(`ENOENT: ${p}`);
    return fs.get(p)!;
  }),
}));

vi.mock("../project", () => ({
  readDirRecursive: vi.fn(async (dir: string) => {
    interface Node { name: string; path: string; is_dir: boolean; children?: Node[] }
    const roots: Node[] = [];
    const dirs = new Map<string, Node>();
    for (const path of fs.keys()) {
      if (!path.startsWith(dir + "/")) continue;
      const segments = path.slice(dir.length + 1).split("/");
      if (segments.some((s) => s.startsWith("."))) continue;
      let parent: Node[] = roots;
      let prefix = dir;
      for (let i = 0; i < segments.length; i++) {
        prefix += "/" + segments[i];
        const leaf = i === segments.length - 1;
        if (leaf) {
          parent.push({ name: segments[i], path: prefix, is_dir: false });
        } else {
          let node = dirs.get(prefix);
          if (!node) {
            node = { name: segments[i], path: prefix, is_dir: true, children: [] };
            dirs.set(prefix, node);
            parent.push(node);
          }
          parent = node.children!;
        }
      }
    }
    return roots;
  }),
}));

import {
  MAJOR_REWRITE_MIN_CHARS,
  bodyOf,
  citingDocuments,
  isMajorRewrite,
  rewriteRatio,
} from "../agent/destructive";
import { isAutoApprovable } from "../agent/autoApprove";
import type { LoreEntity, LoreIndex } from "../lore";

const P = "/proj";
const LONG = "旧码头是港口东侧废弃的木栈桥。".repeat(20);

describe("bodyOf / rewriteRatio", () => {
  it("measures the body, not the frontmatter", () => {
    const before = `---\nname: 旧码头\nsummary: "废弃"\n---\n\n${LONG}`;
    const after = `---\nname: 旧码头\nsummary: "重新启用了"\n---\n\n${LONG}`;
    expect(bodyOf(before)).toBe(`\n${LONG}`);
    // Only the summary changed, and that is metadata, not 正文.
    expect(rewriteRatio(before, after).removed).toBe(0);
  });
});

describe("isMajorRewrite", () => {
  it("does not stop a correction threaded through a long entry", () => {
    const after = LONG.replace("废弃", "荒废");
    expect(isMajorRewrite(LONG, after)).toBe(false);
  });

  it("stops when most of a long entry is replaced", () => {
    const after = "港口西侧新修了石砌的码头，能停三艘大船。".repeat(15);
    expect(isMajorRewrite(LONG, after)).toBe(true);
  });

  it("stops when an entry is emptied", () => {
    expect(isMajorRewrite(LONG, "")).toBe(true);
  });

  it("never stops a stub being filled in", () => {
    // 「待补充」 becoming three paragraphs replaces 100% of nothing worth keeping.
    const stub = "待补充";
    expect(stub.length).toBeLessThan(MAJOR_REWRITE_MIN_CHARS);
    expect(isMajorRewrite(stub, LONG)).toBe(false);
  });
});

describe("citingDocuments", () => {
  const pier = {
    id: "old-pier",
    category: "places",
    name: "旧码头",
    aliases: ["东码头"],
    dirPath: `${P}/.ai-writer/lore/places/old-pier`,
  } as unknown as LoreEntity;
  const harbour = {
    id: "harbour",
    category: "places",
    name: "港口",
    aliases: [],
    dirPath: `${P}/.ai-writer/lore/places/harbour`,
  } as unknown as LoreEntity;
  const index = { places: [pier, harbour] } as unknown as LoreIndex;

  beforeEach(() => fs.clear());

  it("finds citations by name and by alias, and only of this entity", async () => {
    fs.set(`${P}/第一章.md`, "他们在 [[lore:旧码头]] 碰头。");
    fs.set(`${P}/大纲.md`, "第三幕回到 [[lore:东码头|码头]]。");
    fs.set(`${P}/第二章.md`, "[[lore:港口]] 的灯亮了。");
    fs.set(`${P}/随笔.md`, "旧码头这个名字我一直记得。");

    const { documents, complete } = await citingDocuments(P, pier, index);
    expect(documents.sort()).toEqual(["大纲.md", "第一章.md"]);
    expect(complete).toBe(true);
  });

  it("says nothing cites it when nothing does", async () => {
    fs.set(`${P}/第一章.md`, "没有引用。");
    expect((await citingDocuments(P, pier, index)).documents).toEqual([]);
  });
});

describe("the step card and standing grants", () => {
  it("is never covered by 本次都批准", () => {
    // The plan already was the author's grant for the pass; this card exists
    // for the two steps that grant was never meant to cover.
    expect(isAutoApprovable("loreStep")).toBe(false);
  });
});
