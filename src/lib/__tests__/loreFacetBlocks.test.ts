/**
 * 互斥组盒的分组语义（lib/lore/facetBlocks）——管理台的行列表、它的每个槽位段、
 * 和阅读模式的全文分节共用这一份。三条要钉住的规则：无组的照原序留行；同组收进
 * **首见位置**的一个盒（分属不同槽位的组随第一条走——设计系统「互斥组盒子留在
 * 面内」那条的前提）；盒内按 priority 降序、同优先级保持原序。
 */
import { describe, expect, it } from "vitest";
import { buildFacetBlocks, type LoreFacet } from "../lore";

const facet = (title: string, group: string | null = null, priority = 0): LoreFacet => ({
  file: `${title}.md`,
  title,
  slot: null,
  keys: [],
  group,
  priority,
  mode: "auto",
  charCount: 10,
});

describe("buildFacetBlocks", () => {
  it("keeps ungrouped facets as rows in original order", () => {
    const blocks = buildFacetBlocks([facet("a"), facet("b")]);
    expect(blocks).toEqual([
      { kind: "facet", facet: expect.objectContaining({ title: "a" }) },
      { kind: "facet", facet: expect.objectContaining({ title: "b" }) },
    ]);
  });

  it("collapses a group into one box at its first-seen position", () => {
    const blocks = buildFacetBlocks([
      facet("冬装", "outfit"),
      facet("独白"),
      facet("奔袭装", "outfit"),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["group", "facet"]);
    const box = blocks[0] as Extract<(typeof blocks)[number], { kind: "group" }>;
    expect(box.group).toBe("outfit");
    expect(box.facets).toHaveLength(2);
  });

  it("orders a box by priority descending, ties in insertion order", () => {
    const blocks = buildFacetBlocks([
      facet("低", "g", 1),
      facet("平A", "g", 5),
      facet("平B", "g", 5),
      facet("高", "g", 9),
    ]);
    const box = blocks[0] as Extract<(typeof blocks)[number], { kind: "group" }>;
    expect(box.facets.map((f) => f.title)).toEqual(["高", "平A", "平B", "低"]);
  });

  it("keeps separate groups as separate boxes", () => {
    const blocks = buildFacetBlocks([facet("a", "g1"), facet("b", "g2")]);
    expect(blocks.map((b) => (b.kind === "group" ? b.group : null))).toEqual(["g1", "g2"]);
  });
});
