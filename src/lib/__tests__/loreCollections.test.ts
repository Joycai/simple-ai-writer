/**
 * 知识库集合（lib/lore/collections）——第二根轴的纯逻辑，加上两处它必须表现出来的
 * 行为：frontmatter 的往返，和取材范围在 `selectLore` 里的**非对称**语义。
 *
 * 那条非对称是这个功能的全部要点，也是唯一容易写错的地方：围栏收窄**自动匹配**，
 * 但作者置顶的条目照常注入。写反了不会有任何报错——上下文里只是少了或多了几条设定，
 * 而那要等到作者读到一段串了味的正文才发现。
 */
import { describe, it, expect, vi } from "vitest";
import {
  UNGROUPED,
  addCollection,
  bindingLabel,
  collectionBreakdown,
  passesFilter,
  collectionViews,
  inScope,
  MAX_COLLECTION_NAME,
  normalizeCollections,
  outOfScopeCount,
  removeCollection,
  renameCollection,
  sameCollection,
  scopeLoreIndex,
  ungroupedCount,
  type LoreEntity,
  type LoreIndex,
} from "../lore";

// selectLore 会去磁盘读条目正文，这里只关心谁被选中，所以给每个 index.md 一份空正文。
const files = new Map<string, string>();
vi.mock("../fs/fileio", () => ({
  readFile: async (path: string) => {
    const content = files.get(path);
    if (content == null) throw new Error(`no such file: ${path}`);
    return content;
  },
  writeFile: vi.fn(),
  writeBinaryFile: vi.fn(),
  readDir: vi.fn(),
  makeDir: vi.fn(),
  fileExists: vi.fn(),
  renamePath: vi.fn(),
  removeFile: vi.fn(),
}));

import { selectLore } from "../context/loreSelect";
import { serializeEntityFrontmatter } from "../lore/entity";

function entity(name: string, collections: string[], category = "characters"): LoreEntity {
  const dirPath = `/proj/.ai-writer/lore/${category}/${name.toLowerCase()}`;
  files.set(`${dirPath}/index.md`, "---\n---\n");
  return {
    id: name.toLowerCase(), category, dirPath, name, aliases: [],
    summary: `${name} 的一句话`, collections,
    avatarPath: null, mdFiles: ["index.md"], images: [], facets: [],
  };
}

function makeIndex(): LoreIndex {
  return {
    characters: [
      entity("Aria", ["小说A"]),
      entity("Bran", ["小说B"]),
      entity("Cass", ["小说A", "小说B"]), // 共享：两边都在范围内
      entity("Dorn", []),                 // 未归集
    ],
    world: [],
  };
}

describe("normalizeCollections", () => {
  it("去空白、丢空项、大小写不敏感去重，保留首次出现的写法与顺序", () => {
    expect(normalizeCollections([" 小说A ", "", "  ", "小说B", "小说a"])).toEqual(["小说A", "小说B"]);
    expect(normalizeCollections(["Draft", "draft", "DRAFT"])).toEqual(["Draft"]);
  });

  it("吃手写的行内数组——轻量 frontmatter 解析器对没引号的 CJK 交回的就是一个字符串", () => {
    expect(normalizeCollections("[小说A, 共享设定]")).toEqual(["小说A", "共享设定"]);
    expect(normalizeCollections('["小说A", "共享设定"]')).toEqual(["小说A", "共享设定"]);
    expect(normalizeCollections("小说A")).toEqual(["小说A"]);
  });

  it("缺席与坏类型都读成「未归集」，而不是抛错", () => {
    expect(normalizeCollections(undefined)).toEqual([]);
    expect(normalizeCollections(null)).toEqual([]);
    expect(normalizeCollections(42)).toEqual([]);
  });

  it("截断超长的名字", () => {
    const long = "长".repeat(MAX_COLLECTION_NAME + 20);
    expect(normalizeCollections([long])[0]).toHaveLength(MAX_COLLECTION_NAME);
  });
});

describe("成员运算", () => {
  it("sameCollection 大小写与空白都不敏感", () => {
    expect(sameCollection(" Draft ", "draft")).toBe(true);
    expect(sameCollection("小说A", "小说B")).toBe(false);
  });

  it("add 幂等，remove 只摘一个集合而不动其余", () => {
    expect(addCollection(["小说A"], "小说a")).toEqual(["小说A"]);
    expect(addCollection(["小说A"], "小说B")).toEqual(["小说A", "小说B"]);
    expect(removeCollection(["小说A", "小说B"], "小说a")).toEqual(["小说B"]);
  });

  it("rename 保持位置——集合顺序是作者排的，改个名不该让它跳到末尾", () => {
    expect(renameCollection(["甲", "乙", "丙"], "乙", "乙2")).toEqual(["甲", "乙2", "丙"]);
  });

  it("rename 到一个已存在的名字＝合并，而不是留下两条同名", () => {
    expect(renameCollection(["甲", "乙"], "乙", "甲")).toEqual(["甲"]);
  });
});

describe("取材范围", () => {
  it("null 就是不设围栏", () => {
    const index = makeIndex();
    expect(scopeLoreIndex(index, null)).toBe(index);
    expect(outOfScopeCount(index, null)).toBe(0);
  });

  it("多归属的条目在它每一个集合里都在范围内", () => {
    const cass = entity("Cass", ["小说A", "小说B"]);
    expect(inScope(cass, "小说A")).toBe(true);
    expect(inScope(cass, "小说B")).toBe(true);
    expect(inScope(cass, "项目甲")).toBe(false);
  });

  it("未归集的条目不属于任何具体范围", () => {
    expect(inScope(entity("Dorn", []), "小说A")).toBe(false);
  });

  it("过滤保留全部分类键——下游把键当分类清单用，空分类仍是一个筛选项", () => {
    const scoped = scopeLoreIndex(makeIndex(), "小说A");
    expect(Object.keys(scoped).sort()).toEqual(["characters", "world"]);
    expect(scoped.characters.map((e) => e.name)).toEqual(["Aria", "Cass"]);
    expect(scoped.world).toEqual([]);
  });

  it("如实数出被挡在外面的条目", () => {
    expect(outOfScopeCount(makeIndex(), "小说A")).toBe(2); // Bran + Dorn
  });

  it("数得出未归集的有几条", () => {
    expect(ungroupedCount(makeIndex())).toBe(1);
  });
});

describe("collectionViews", () => {
  it("声明的按声明顺序在前（含空集合），只在条目里出现过的按名字排在后面", () => {
    const views = collectionViews(makeIndex(), ["小说B", "小说A", "还没装东西的"]);
    expect(views.map((v) => v.name)).toEqual(["小说B", "小说A", "还没装东西的"]);
    expect(views.map((v) => v.count)).toEqual([2, 2, 0]);
    expect(views.every((v) => v.declared)).toBe(true);
  });

  it("没被声明过的集合照样出现——否则墙上看得见的比模型看得见的还少", () => {
    const views = collectionViews(makeIndex(), ["小说A"]);
    expect(views.map((v) => [v.name, v.declared])).toEqual([
      ["小说A", true],
      ["小说B", false],
    ]);
  });

  it("计数大小写不敏感地归到同一个集合，显示用声明里的写法", () => {
    const index: LoreIndex = { characters: [entity("A", ["draft"]), entity("B", ["DRAFT"])] };
    expect(collectionViews(index, ["Draft"])).toEqual([{ name: "Draft", count: 2, declared: true }]);
  });
});

describe("frontmatter", () => {
  const base = { name: "Aria", aliases: [], category: "characters", summary: "" };

  it("未归集不写这一行——已有的知识库在作者真正归档之前逐字节不变", () => {
    expect(serializeEntityFrontmatter(base)).not.toContain("collections");
    expect(serializeEntityFrontmatter({ ...base, collections: [] })).not.toContain("collections");
  });

  it("写成带引号的行内数组，名字里有逗号也能原样读回来", () => {
    const out = serializeEntityFrontmatter({ ...base, collections: ["小说A", "甲, 乙"] });
    expect(out).toContain('collections: ["小说A", "甲, 乙"]');
  });
});

describe("selectLore 的围栏语义", () => {
  const index = makeIndex();
  const mention = "Aria 和 Bran 在城门口碰上了 Dorn。";

  it("不设范围时，提到谁就注入谁", async () => {
    const { report } = await selectLore(mention, index, []);
    expect(report.entities.map((e) => e.name).sort()).toEqual(["Aria", "Bran", "Dorn"]);
  });

  it("设了范围，自动匹配只在范围内命中", async () => {
    const { report } = await selectLore(mention, index, [], undefined, { scope: "小说A" });
    expect(report.entities.map((e) => e.name)).toEqual(["Aria"]);
  });

  it("置顶穿过围栏——显式指定是作者坚持，不是自动漂进来的", async () => {
    const bran = index.characters.find((e) => e.name === "Bran")!;
    const { report } = await selectLore(mention, index, [bran.dirPath], undefined, { scope: "小说A" });
    const picked = report.entities.map((e) => [e.name, e.reason]);
    expect(picked).toContainEqual(["Bran", "pinned"]);
    expect(picked).toContainEqual(["Aria", "auto"]);
    // 而没被置顶、也不在范围里的那条仍然被挡住。
    expect(picked.map(([name]) => name)).not.toContain("Dorn");
  });

  it("多归属的条目对两个范围都可见", async () => {
    const text = "Cass 出现了。";
    for (const scope of ["小说A", "小说B"]) {
      const { report } = await selectLore(text, index, [], undefined, { scope });
      expect(report.entities.map((e) => e.name)).toEqual(["Cass"]);
    }
  });
});

describe("bindingLabel", () => {
  it("剥掉书名号再取前四字——竖排里书名号占一行却不表意", () => {
    expect(bindingLabel("《漕运纪》")).toBe("漕运纪");
    expect(bindingLabel("《漕运纪·前传》")).toBe("漕运纪·");
    expect(bindingLabel("「雪原书」")).toBe("雪原书");
  });

  it("短名原样，英文按字符截", () => {
    expect(bindingLabel("出版方案")).toBe("出版方案");
    expect(bindingLabel("Publishing")).toBe("Publ");
  });

  it("整个名字都是括号时退回原名，而不是给出一条空装订标", () => {
    expect(bindingLabel("《》")).toBe("《》");
  });

  it("按码点切，不把 emoji 劈成两半", () => {
    expect(bindingLabel("📚合集")).toBe("📚合集");
  });
});

describe("墙上的筛选", () => {
  it("未归集是筛选的一档，但不是取材范围的一档", () => {
    const filed = entity("Aria", ["小说A"]);
    const bare = entity("Dorn", []);
    expect(passesFilter(bare, UNGROUPED)).toBe(true);
    expect(passesFilter(filed, UNGROUPED)).toBe(false);
    // 同一个值拿去当围栏是没有意义的：inScope 只认真正的集合名。
    expect(inScope(bare, UNGROUPED)).toBe(false);
  });

  it("null 放行一切", () => {
    expect(passesFilter(entity("Dorn", []), null)).toBe(true);
  });
});

describe("collectionBreakdown", () => {
  it("按分类数出一个集合内部的分布，空分类不出现", () => {
    const index: LoreIndex = {
      characters: [entity("Aria", ["小说A"]), entity("Bran", ["小说B"])],
      world: [entity("Realm", ["小说A"], "world")],
      items: [],
    };
    expect(collectionBreakdown(index, "小说A")).toEqual([
      { category: "characters", count: 1 },
      { category: "world", count: 1 },
    ]);
  });

  it("未归集也能数——那是墙的筛选要显示的数字", () => {
    const index: LoreIndex = { characters: [entity("Aria", ["小说A"]), entity("Dorn", [])] };
    expect(collectionBreakdown(index, UNGROUPED)).toEqual([{ category: "characters", count: 1 }]);
  });
});
