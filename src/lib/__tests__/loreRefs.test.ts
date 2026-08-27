/**
 * The `[[lore:…]]` reference graph, scan side.
 *
 * `LoreEntity.refs` is what turns an author's citation into a retrieval edge
 * (see lib/context/loreSelect's L3 pass). It is harvested during the scan
 * because the bytes are already in hand there — index.md and every facet file
 * are read for their frontmatter anyway — so the graph costs one string scan
 * and no extra IO.
 *
 * docs/feature/lore/lore-retrieval-plan.md §4.1
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dirs = new Map<string, { name: string; isDirectory: boolean }[]>();
const files = new Map<string, string>();

vi.mock("../fs/fileio", () => ({
  readDir: async (path: string) => {
    const entries = dirs.get(path);
    if (!entries) throw new Error(`no such directory: ${path}`);
    return entries;
  },
  readFile: async (path: string) => {
    const content = files.get(path);
    if (content == null) throw new Error(`no such file: ${path}`);
    return content;
  },
  fileExists: async (path: string) => files.has(path) || dirs.has(path),
  writeFile: vi.fn(),
  writeBinaryFile: vi.fn(),
  makeDir: vi.fn(),
  renamePath: vi.fn(),
  removeFile: vi.fn(),
}));

import { scanLore } from "../lore";
import { resetActiveWorkspace } from "../profile";

const ROOT = "/proj";
const LORE = ROOT + "/.ai-writer/lore";

/** One entity folder with the given files, under `characters`. */
function entityWith(id: string, contents: Record<string, string>): void {
  dirs.set(LORE, [{ name: "characters", isDirectory: true }]);
  dirs.set(LORE + "/characters", [{ name: id, isDirectory: true }]);
  const dir = LORE + "/characters/" + id;
  dirs.set(dir, Object.keys(contents).map((name) => ({ name, isDirectory: false })));
  for (const [name, text] of Object.entries(contents)) files.set(dir + "/" + name, text);
}

beforeEach(() => {
  dirs.clear();
  files.clear();
  resetActiveWorkspace();
});

describe("scanLore — refs", () => {
  it("收集 index.md 正文里的引用", async () => {
    entityWith("nagisa", {
      "index.md": "---\nname: 渚\n---\n她握着 [[lore:星辉之杖]]。",
    });
    const index = await scanLore(ROOT);
    expect(index.characters[0].refs).toEqual(["星辉之杖"]);
  });

  it("特征正文里的引用同样算数，并与 index.md 的合并去重", async () => {
    entityWith("nagisa", {
      "index.md": "---\nname: 渚\n---\n见 [[lore:星辉之杖]]。",
      "outfit.md": "---\nfacet: 战斗服\n---\n配 [[lore:星辉之杖]] 与 [[lore:变身器]]。",
    });
    const index = await scanLore(ROOT);
    expect(index.characters[0].refs).toEqual(["星辉之杖", "变身器"]);
  });

  it("frontmatter 不参与采集", async () => {
    // 正文才是作者写引用的地方；把 frontmatter 也扫进来，一个恰好含
    // "[[lore:" 的 summary 就会凭空长出一条边。
    entityWith("nagisa", {
      "index.md": "---\nname: 渚\nsummary: 见 [[lore:不该被收的]]\n---\n正文没有引用。",
    });
    const index = await scanLore(ROOT);
    expect(index.characters[0].refs).toEqual([]);
  });

  it("没有引用的条目得到空数组，不是 undefined", async () => {
    entityWith("nagisa", { "index.md": "---\nname: 渚\n---\n平平无奇。" });
    const index = await scanLore(ROOT);
    expect(index.characters[0].refs).toEqual([]);
  });

  it("读不动的特征文件不影响其余引用", async () => {
    entityWith("nagisa", {
      "index.md": "---\nname: 渚\n---\n见 [[lore:星辉之杖]]。",
    });
    // 目录里报了这个文件，但内容不存在——扫描要当它是惰性附件跳过。
    dirs.set(LORE + "/characters/nagisa", [
      { name: "index.md", isDirectory: false },
      { name: "gone.md", isDirectory: false },
    ]);
    const index = await scanLore(ROOT);
    expect(index.characters[0].refs).toEqual(["星辉之杖"]);
  });
});
