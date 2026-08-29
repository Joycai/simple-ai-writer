/**
 * 批量改分类（知识库墙多选之后的那一下）+ 置顶重指。
 *
 * 两条容易写错、且错了都**不报错**的地方：
 *   1. 搬家是搬文件夹，目标分类里已有同名 id 时必须让号（`ava` → `ava-2`），否则
 *      `renamePath` 会盖掉那一条——一次批量整理吃掉一个条目，作者不会立刻发现。
 *   2. 置顶按绝对路径存，搬完不重指就等于静默取消这一批的置顶，而这件事要等到下一次
 *      运行读到一段没带人设的正文才暴露。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const files = new Map<string, string>();
const dirs = new Set<string>();
/** 写这些路径时抛错——用来验证「单条失败不中断整批」。 */
const failWrites = new Set<string>();

vi.mock("../fs/fileio", () => ({
  readFile: async (path: string) => {
    const content = files.get(path);
    if (content == null) throw new Error(`no such file: ${path}`);
    return content;
  },
  writeFile: async (path: string, content: string) => {
    if (failWrites.has(path)) throw new Error(`disk full: ${path}`);
    files.set(path, content);
  },
  writeBinaryFile: vi.fn(),
  readDir: vi.fn(async () => []),
  makeDir: vi.fn(),
  fileExists: async (path: string) => dirs.has(path) || files.has(path),
  renamePath: async (from: string, to: string) => {
    for (const [k, v] of [...files]) {
      if (k === from || k.startsWith(`${from}/`)) {
        files.delete(k);
        files.set(to + k.slice(from.length), v);
      }
    }
    dirs.delete(from);
    dirs.add(to);
  },
  removeFile: vi.fn(),
}));

import { moveEntitiesToCategory, repointPins, type LoreEntity } from "../lore";

const ROOT = "/proj";

function entity(
  name: string,
  category: string,
  opts?: { body?: string; noIndex?: boolean },
): LoreEntity {
  const id = name.toLowerCase();
  const dirPath = `${ROOT}/.ai-writer/lore/${category}/${id}`;
  dirs.add(dirPath);
  if (!opts?.noIndex) {
    files.set(
      `${dirPath}/index.md`,
      `---\nname: ${name}\naliases: []\ncategory: ${category}\nsummary: ${name} 的一句话\n---\n\n${opts?.body ?? `# ${name}\n正文`}`,
    );
  }
  return {
    id, category, dirPath, name,
    aliases: [], summary: `${name} 的一句话`, collections: [],
    avatarPath: null, mdFiles: ["index.md"], images: [], facets: [],
  };
}

beforeEach(() => {
  files.clear();
  dirs.clear();
  failWrites.clear();
});

describe("moveEntitiesToCategory", () => {
  it("搬家：文件夹换到新分类，frontmatter 和正文原样带走", async () => {
    const ava = entity("Ava", "characters", { body: "# Ava\n她的正文，一个字都不该变。" });

    const { moves, skipped, failed } = await moveEntitiesToCategory(ROOT, [ava], "factions");

    expect(skipped).toBe(0);
    expect(failed).toEqual([]);
    expect(moves).toEqual([
      { from: `${ROOT}/.ai-writer/lore/characters/ava`, to: `${ROOT}/.ai-writer/lore/factions/ava` },
    ]);
    const written = files.get(`${ROOT}/.ai-writer/lore/factions/ava/index.md`)!;
    expect(written).toContain("category: factions");
    expect(written).toContain("她的正文，一个字都不该变。");
    // 旧位置什么都不留：留一个空壳会让扫描器数出一个没有 index.md 的条目。
    expect(files.has(`${ROOT}/.ai-writer/lore/characters/ava/index.md`)).toBe(false);
  });

  it("已经在目标分类里的算跳过，不计进「已移动」", async () => {
    const ava = entity("Ava", "characters");
    const kel = entity("Kel", "factions");

    const { moves, skipped } = await moveEntitiesToCategory(ROOT, [ava, kel], "factions");

    expect(moves).toHaveLength(1);
    expect(moves[0].to).toBe(`${ROOT}/.ai-writer/lore/factions/ava`);
    expect(skipped).toBe(1);
  });

  it("目标分类已有同名 id 时让号，绝不覆盖那一条", async () => {
    const mine = entity("Ava", "characters", { body: "# Ava\n我的正文" });
    entity("Ava", "factions", { body: "# Ava\n另一条同名的，不能被盖掉" });

    const { moves } = await moveEntitiesToCategory(ROOT, [mine], "factions");

    expect(moves[0].to).toBe(`${ROOT}/.ai-writer/lore/factions/ava-2`);
    expect(files.get(`${ROOT}/.ai-writer/lore/factions/ava/index.md`)).toContain(
      "另一条同名的，不能被盖掉",
    );
    expect(files.get(`${ROOT}/.ai-writer/lore/factions/ava-2/index.md`)).toContain("我的正文");
  });

  it("没有 index.md 的条目照搬，用扫描到的元数据补一份", async () => {
    const bare = entity("Ghost", "characters", { noIndex: true });

    const { failed } = await moveEntitiesToCategory(ROOT, [bare], "world");

    expect(failed).toEqual([]);
    const written = files.get(`${ROOT}/.ai-writer/lore/world/ghost/index.md`)!;
    expect(written).toContain("category: world");
    expect(written).toContain(`name: "Ghost"`);
    // 正文是重建的，但重建出来的是这一条自己的标题，而不是一份空文件。
    expect(written).toContain("# Ghost");
  });

  it("单条失败不中断整批，失败的条目名报出来", async () => {
    const ava = entity("Ava", "characters");
    const kel = entity("Kel", "characters");
    failWrites.add(`${ROOT}/.ai-writer/lore/characters/ava/index.md`);

    const { moves, failed } = await moveEntitiesToCategory(ROOT, [ava, kel], "factions");

    expect(failed).toEqual(["Ava"]);
    expect(moves).toHaveLength(1);
    expect(moves[0].to).toBe(`${ROOT}/.ai-writer/lore/factions/kel`);
  });
});

describe("repointPins", () => {
  const from = "/proj/.ai-writer/lore/characters/ava";
  const to = "/proj/.ai-writer/lore/factions/ava";

  it("条目级置顶跟着搬", () => {
    expect(repointPins([from], [{ from, to }])).toEqual([to]);
  });

  it("特征级置顶保留 # 后缀", () => {
    expect(repointPins([`${from}#外袍`], [{ from, to }])).toEqual([`${to}#外袍`]);
  });

  it("没搬的置顶原样不动", () => {
    const other = "/proj/.ai-writer/lore/world/雪原";
    expect(repointPins([other, from], [{ from, to }])).toEqual([other, to]);
  });

  it("没有搬家时原样返回", () => {
    expect(repointPins([from], [])).toEqual([from]);
  });
});
