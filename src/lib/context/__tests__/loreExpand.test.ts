/**
 * 查询扩展的纯逻辑——名单怎么建，模型的回答怎么收。
 *
 * 网络那一半（`expandQuery` / `expandAuthorIntent`）不在这里：它的契约是
 * 「什么都不抛、失败就当没开」，值得测的是名单和过滤，那才是这个特性的正确性
 * 所在。docs/feature/lore/lore-retrieval-plan.md §5
 */
import { describe, expect, it } from "vitest";
import {
  acceptExpansion,
  expansionRoster,
  MAX_EXPANDED_TERMS,
  MAX_ROSTER_TERMS,
} from "../expand";
import type { LoreEntity, LoreIndex } from "../../lore";

function entity(partial: Partial<LoreEntity> & { name: string }): LoreEntity {
  return {
    id: partial.name, category: "characters", dirPath: "/p/" + partial.name,
    aliases: [], summary: "", avatarPath: null, collections: [],
    mdFiles: [], images: [], facets: [], refs: [],
    ...partial,
  } as LoreEntity;
}

function index(): LoreIndex {
  return {
    characters: [
      entity({
        name: "沈舟",
        aliases: ["Shen Zhou"],
        facets: [
          { file: "a.md", title: "夜行装束", slot: null, keys: ["潜入", "夜行衣"], group: "outfit", priority: 0, mode: "auto", charCount: 0 },
        ],
      }),
    ],
    items: [entity({ name: "青铜罗盘", category: "items", aliases: ["罗盘"] })],
  };
}

describe("expansionRoster", () => {
  it("收实体名、别名、特征标题和 keys", () => {
    expect(expansionRoster(index())).toEqual([
      "沈舟", "Shen Zhou", "青铜罗盘", "罗盘", "夜行装束", "潜入", "夜行衣",
    ]);
  });

  it("实体词排在特征词之前，所以截断先砍特征词", () => {
    // 名单被砍时，少一个特征关键词只是少激活一层；少一个条目名是整条取不到。
    const roster = expansionRoster(index());
    expect(roster.indexOf("青铜罗盘")).toBeLessThan(roster.indexOf("潜入"));
  });

  it("特征词非收不可——名单里没有「潜入」，模型就答不出「潜入」", () => {
    expect(expansionRoster(index())).toContain("潜入");
  });

  it("按取材范围收窄：扩展也是自动发现", () => {
    const idx = index();
    idx.characters[0].collections = ["卷一"];
    idx.items[0].collections = ["卷二"];
    expect(expansionRoster(idx, ["卷一"])).not.toContain("青铜罗盘");
  });

  it("去重且大小写不敏感", () => {
    const idx: LoreIndex = {
      characters: [entity({ name: "Aria", aliases: ["aria", "ARIA", "Songbird"] })],
    };
    expect(expansionRoster(idx)).toEqual(["Aria", "Songbird"]);
  });

  it("名单有上限", () => {
    const idx: LoreIndex = {
      characters: Array.from({ length: MAX_ROSTER_TERMS + 50 }, (_, i) =>
        entity({ name: "e" + i })),
    };
    expect(expansionRoster(idx)).toHaveLength(MAX_ROSTER_TERMS);
  });

  it("空知识库给空名单（调用方据此整段跳过）", () => {
    expect(expansionRoster({})).toEqual([]);
  });
});

describe("acceptExpansion", () => {
  const roster = ["沈舟", "青铜罗盘", "潜入"];

  it("留下名单里的词", () => {
    expect(acceptExpansion({ terms: ["沈舟", "青铜罗盘"] }, roster)).toEqual(["沈舟", "青铜罗盘"]);
  });

  it("丢掉模型自己造的词", () => {
    // 造出来的词在 matchTarget 里什么也命中不了，却会混进注入报告的命中来源，
    // 让作者去找一个他知识库里根本没有的条目。
    expect(acceptExpansion({ terms: ["轻功", "暗号", "潜入"] }, roster)).toEqual(["潜入"]);
  });

  it("大小写不敏感，但回填名单里的原始拼写", () => {
    expect(acceptExpansion({ terms: ["STARLIGHT"] }, ["Starlight"])).toEqual(["Starlight"]);
  });

  it("去重", () => {
    expect(acceptExpansion({ terms: ["沈舟", "沈舟"] }, roster)).toEqual(["沈舟"]);
  });

  it("有条数上限——防的是把整份名单抄回来", () => {
    const big = Array.from({ length: MAX_EXPANDED_TERMS + 5 }, (_, i) => "t" + i);
    expect(acceptExpansion({ terms: big }, big)).toHaveLength(MAX_EXPANDED_TERMS);
  });

  it("任何不成形的回答都收成空数组，不抛", () => {
    for (const bad of [null, undefined, {}, { terms: "沈舟" }, { terms: [1, 2] }, []]) {
      expect(acceptExpansion(bad, roster)).toEqual([]);
    }
  });
});
