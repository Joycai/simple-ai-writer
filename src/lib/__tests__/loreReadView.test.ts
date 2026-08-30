/**
 * 阅读模式的数据层（lib/lore/readView + entity.readFacetBodies）。
 * 设计：docs/feature/lore/lore-browse-mode-ui-brief.md。
 *
 * 三件不显眼但错了很难发现的事：模式偏好**缺席即阅读**且键名与 PREF_KEYS 不脱钩；
 * 激活标签 = 名称 + 别名（名称第一、大小写重复只留先见的写法）——这行是把「别名
 * 就是激活关键词」写明白的地方，去重错了作者会以为某个别名没生效；特征正文批量
 * 读取的 per-file 容错——一条坏文件只让自己变占位行（null），空正文（""）与它
 * 分得开，否则整页断在坏文件上。
 */
import { describe, expect, it, vi } from "vitest";

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

import {
  LORE_DETAIL_MODE_PREF,
  activationTags,
  entityReadStats,
  parseDetailMode,
  readFacetBodies,
  type LoreEntity,
  type LoreFacet,
} from "../lore";
import { PREF_KEYS } from "../prefs";

const facet = (file: string, charCount: number): LoreFacet => ({
  file,
  title: file.replace(/\.md$/, ""),
  slot: null,
  keys: [],
  group: null,
  priority: 0,
  mode: "auto",
  charCount,
});

const entity = (over: Partial<LoreEntity> = {}): LoreEntity => ({
  id: "ava",
  category: "characters",
  dirPath: "/p/.ai-writer/lore/characters/ava",
  name: "Ava",
  aliases: [],
  summary: "",
  avatarPath: null,
  collections: [],
  mdFiles: ["index.md"],
  images: [],
  facets: [],
  ...over,
});

describe("parseDetailMode", () => {
  it("defaults to read — absent, empty, or garbage", () => {
    expect(parseDetailMode(null)).toBe("read");
    expect(parseDetailMode(undefined)).toBe("read");
    expect(parseDetailMode("")).toBe("read");
    expect(parseDetailMode("三栏")).toBe("read");
  });

  it("round-trips both modes", () => {
    expect(parseDetailMode("read")).toBe("read");
    expect(parseDetailMode("manage")).toBe("manage");
  });

  it("its pref key is registered in PREF_KEYS", () => {
    expect(PREF_KEYS).toContain(LORE_DETAIL_MODE_PREF);
  });
});

describe("activationTags", () => {
  it("name first, then aliases", () => {
    expect(activationTags({ name: "沈青梧", aliases: ["青梧", "沈姑娘"] }))
      .toEqual(["沈青梧", "青梧", "沈姑娘"]);
  });

  it("dedupes case-insensitively, keeping the first spelling", () => {
    expect(activationTags({ name: "Ava", aliases: ["AVA", "ava", "Avalon"] }))
      .toEqual(["Ava", "Avalon"]);
  });

  it("trims and drops blank aliases", () => {
    expect(activationTags({ name: " Ava ", aliases: ["  ", "", " 阿瓦 "] }))
      .toEqual(["Ava", "阿瓦"]);
  });
});

describe("entityReadStats", () => {
  it("counts facets/images and sums index + facet chars", () => {
    const e = entity({
      facets: [facet("a.md", 120), facet("b.md", 80)],
      images: [{ file: "1.png", desc: "", slot: null, absPath: "/x/1.png" }],
    });
    expect(entityReadStats(e, 300)).toEqual({ facetCount: 2, imageCount: 1, totalChars: 500 });
  });

  it("clamps a negative index length to zero", () => {
    expect(entityReadStats(entity(), -1).totalChars).toBe(0);
  });
});

describe("readFacetBodies", () => {
  it("strips frontmatter, keeps empty bodies, and maps a failed read to null", async () => {
    const dir = "/p/.ai-writer/lore/characters/ava";
    files.set(`${dir}/a.md`, "---\nfacet: 外貌\n---\n身形颀长。");
    files.set(`${dir}/empty.md`, "---\nfacet: 空\n---\n");
    // gone.md is listed in the scan roster but missing on disk.
    const e = entity({ facets: [facet("a.md", 5), facet("empty.md", 0), facet("gone.md", 9)] });

    const bodies = await readFacetBodies(e);
    expect(bodies.get("a.md")).toBe("身形颀长。");
    expect(bodies.get("empty.md")).toBe("");
    expect(bodies.get("gone.md")).toBeNull();
    expect(bodies.size).toBe(3);
  });

  it("returns an empty map for an entity without facets", async () => {
    expect((await readFacetBodies(entity())).size).toBe(0);
  });
});
