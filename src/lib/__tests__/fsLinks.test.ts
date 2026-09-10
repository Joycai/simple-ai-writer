/**
 * Backlinks: which documents link to a file (设计稿 02h 1c).
 *
 * The rule being pinned is that only *links* count. A deletion card that says
 * 「被 12 个文档引用」 because the file is called 序.md and the word appears in a
 * dozen chapters is a card whose most important line nobody reads twice.
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

import { backlinksOf } from "../fs/links";

const P = "/proj";
const TARGET = `${P}/废稿/第五章旧版.md`;

beforeEach(() => {
  fs.clear();
  fs.set(TARGET, "# 第五章 · 旧版\n");
});

describe("backlinksOf", () => {
  it("finds a relative markdown link from another folder", async () => {
    fs.set(`${P}/大纲.md`, "见 [旧版](废稿/第五章旧版.md) 的写法。\n");
    const { byTarget } = await backlinksOf(P, [TARGET]);
    expect(byTarget.get(TARGET)).toEqual(["大纲.md"]);
  });

  it("resolves ../ out of a subfolder", async () => {
    fs.set(`${P}/正稿/第五章.md`, "旧版在 [这里](../废稿/第五章旧版.md)。\n");
    const { byTarget } = await backlinksOf(P, [TARGET]);
    expect(byTarget.get(TARGET)).toEqual(["正稿/第五章.md"]);
  });

  it("counts a wiki link, but not a knowledge-base citation", async () => {
    fs.set(`${P}/笔记.md`, "[[废稿/第五章旧版.md]] 还留着。\n");
    fs.set(`${P}/人物.md`, "[[lore:角色/莉安]] 的发色。\n");
    const { byTarget } = await backlinksOf(P, [TARGET]);
    expect(byTarget.get(TARGET)).toEqual(["笔记.md"]);
  });

  it("does not count a bare mention of the name", async () => {
    // The line this protects: 「被 12 个文档引用」 when the file is called 序.md.
    fs.set(`${P}/随笔.md`, "第五章旧版.md 我一直没删。\n");
    const { byTarget } = await backlinksOf(P, [TARGET]);
    expect(byTarget.get(TARGET)).toEqual([]);
  });

  it("ignores external links and the file's own", async () => {
    fs.set(TARGET, "[自己](第五章旧版.md)\n");
    fs.set(`${P}/外链.md`, "[站](https://example.com/废稿/第五章旧版.md)\n");
    const { byTarget } = await backlinksOf(P, [TARGET]);
    expect(byTarget.get(TARGET)).toEqual([]);
  });

  it("lists each linking document once, however many links it has", async () => {
    fs.set(`${P}/大纲.md`, "[一](废稿/第五章旧版.md) 和 [二](废稿/第五章旧版.md)\n");
    const { byTarget } = await backlinksOf(P, [TARGET]);
    expect(byTarget.get(TARGET)).toEqual(["大纲.md"]);
  });

  it("answers for several targets in one pass", async () => {
    const other = `${P}/废稿/人物表-旧.md`;
    fs.set(other, "旧表\n");
    fs.set(`${P}/大纲.md`, "[a](废稿/第五章旧版.md) [b](废稿/人物表-旧.md)\n");
    const { byTarget, complete } = await backlinksOf(P, [TARGET, other]);
    expect(byTarget.get(TARGET)).toEqual(["大纲.md"]);
    expect(byTarget.get(other)).toEqual(["大纲.md"]);
    expect(complete).toBe(true);
  });

  it("says nothing rather than guessing when there is nothing to scan", async () => {
    const { byTarget, complete } = await backlinksOf(P, []);
    expect(byTarget.size).toBe(0);
    expect(complete).toBe(true);
  });
});
