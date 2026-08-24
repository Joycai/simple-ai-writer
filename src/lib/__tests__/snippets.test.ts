import { describe, expect, it } from "vitest";
import { SNIPPET_SCENE, type Prompt } from "../ai/configDb";
import {
  appendSnippet, buildSections, chipCounts, countPlaceholders, defaultSnippetName,
  findSnippetByName, flatten, frequentSnippets, groupNames, hitSlice, previewLine,
  snippetsOf, splitPlaceholders,
  groupPickerOptions,
  NEW_GROUP,
} from "../ai/snippets";

function snip(name: string, over: Partial<Prompt> = {}): Prompt {
  return {
    id: name, name, content: `${name} 的正文`, scene: SNIPPET_SCENE,
    group: "", useCount: 0, lastUsedAt: 0, ...over,
  };
}

describe("snippetsOf", () => {
  it("keeps snippets and drops override prompts", () => {
    const list: Prompt[] = [
      snip("a"),
      { id: "sys", name: "系统", content: "…", scene: "system" },
      { id: "rw", name: "改写", content: "…", scene: "rewrite" },
    ];
    expect(snippetsOf(list).map((p) => p.id)).toEqual(["a"]);
  });
});

describe("groupNames", () => {
  it("orders groups biggest first, ties by name, and excludes the inbox", () => {
    const list = [
      snip("a", { group: "标书" }), snip("b", { group: "标书" }),
      snip("c", { group: "改写" }), snip("d", { group: "改写" }), snip("e", { group: "改写" }),
      snip("f"),
    ];
    expect(groupNames(list)).toEqual(["改写", "标书"]);
  });

  it("treats a whitespace-only group as ungrouped", () => {
    expect(groupNames([snip("a", { group: "   " })])).toEqual([]);
  });
});

describe("frequentSnippets", () => {
  it("is most-recently-used first and never includes an unused snippet", () => {
    const list = [
      snip("old", { lastUsedAt: 100, useCount: 9 }),
      snip("new", { lastUsedAt: 900, useCount: 1 }),
      snip("never"),
    ];
    expect(frequentSnippets(list).map((s) => s.name)).toEqual(["new", "old"]);
  });

  it("caps at five", () => {
    const list = Array.from({ length: 9 }, (_, i) => snip(`s${i}`, { lastUsedAt: i + 1 }));
    expect(frequentSnippets(list)).toHaveLength(5);
  });
});

describe("buildSections", () => {
  const library = [
    snip("冷处理改写", { group: "改写", lastUsedAt: 500, useCount: 41 }),
    snip("视角收束", { group: "改写" }),
    snip("条款偏差核查", { group: "标书", lastUsedAt: 400, useCount: 33 }),
    snip("别写成新闻稿"),
  ];

  it("leads with 常用, then groups by size, and always ends on 未分组", () => {
    const secs = buildSections(library);
    expect(secs.map((s) => s.kind)).toEqual(["frequent", "group", "group", "ungrouped"]);
    expect(secs[1].group).toBe("改写");
    expect(secs[2].group).toBe("标书");
  });

  it("does NOT de-duplicate 常用 against the group sections", () => {
    // A snippet showing up twice is cheaper than "the one I just used vanished".
    const secs = buildSections(library);
    const appearances = flatten(secs).filter((s) => s.name === "冷处理改写");
    expect(appearances).toHaveLength(2);
  });

  it("drops the 常用 section under a chip filter", () => {
    expect(buildSections(library, { filter: "ungrouped" }).map((s) => s.kind)).toEqual(["ungrouped"]);
    expect(buildSections(library, { filter: "frequent" }).every((s) => s.kind !== "ungrouped")).toBe(true);
  });

  it("keeps only sections with hits and counts them", () => {
    const secs = buildSections(library, { query: "偏差" });
    expect(secs.map((s) => s.group || s.kind)).toEqual(["frequent", "标书"]);
    expect(secs[1].hits).toBe(1);
  });

  it("searches the body, not only the name", () => {
    const list = [snip("随便起的名字", { content: "检查以下条款与招标文件的偏差" })];
    expect(buildSections(list, { query: "招标" })).toHaveLength(1);
  });

  it("omits the 常用 section for the settings pane", () => {
    const secs = buildSections(library, { frequentSection: false });
    expect(secs.some((s) => s.kind === "frequent")).toBe(false);
  });
});

describe("chipCounts", () => {
  it("counts the whole library regardless of the active filter", () => {
    const list = [
      snip("a", { group: "改写", lastUsedAt: 1 }),
      snip("b"),
      snip("c"),
    ];
    expect(chipCounts(list)).toEqual({ all: 3, frequent: 1, ungrouped: 2 });
  });
});

describe("previewLine", () => {
  it("takes the first non-blank line and never a second one", () => {
    expect(previewLine("\n\n第一行\n第二行")).toBe("第一行");
  });
});

describe("hitSlice", () => {
  it("re-cuts a long line around the match so the hit is visible", () => {
    const line = "这是一段很长很长很长很长很长很长的开头文字然后才出现偏差二字";
    const slice = hitSlice(line, "偏差")!;
    expect(slice.hit).toBe("偏差");
    expect(slice.leadEllipsis).toBe(true);
    expect(slice.before).toHaveLength(8);
  });

  it("does not lead with an ellipsis when the hit is at the start", () => {
    expect(hitSlice("偏差核查", "偏差")!.leadEllipsis).toBe(false);
  });

  it("is case-insensitive and returns null on a miss or an empty query", () => {
    expect(hitSlice("Rewrite colder", "REWRITE")!.hit).toBe("Rewrite");
    expect(hitSlice("abc", "z")).toBeNull();
    expect(hitSlice("abc", "  ")).toBeNull();
  });
});

describe("splitPlaceholders", () => {
  it("splits a body into plain and {{…}} runs", () => {
    const parts = splitPlaceholders("检查 {{条款原文}} 的偏差");
    expect(parts.map((p) => p.placeholder)).toEqual([false, true, false]);
    expect(parts[1].text).toBe("{{条款原文}}");
  });

  it("does not let a placeholder span lines", () => {
    expect(countPlaceholders("{{开头\n结尾}}")).toBe(0);
  });

  it("counts several", () => {
    expect(countPlaceholders("{{a}} 和 {{b}}")).toBe(2);
  });
});

describe("appendSnippet", () => {
  it("appends with a newline, and without one into an empty box", () => {
    expect(appendSnippet("已经写的话", "片段正文")).toBe("已经写的话\n片段正文");
    expect(appendSnippet("", "片段正文")).toBe("片段正文");
    expect(appendSnippet("   \n ", "片段正文")).toBe("片段正文");
  });
});

describe("defaultSnippetName", () => {
  it("is the body's opening, trimmed", () => {
    expect(defaultSnippetName("把这段改写得更冷一点，保留对话")).toBe("把这段改写得更冷");
    expect(defaultSnippetName("短")).toBe("短");
  });
});

describe("groupPickerOptions", () => {
  it("offers 「新建分组…」 even with no groups yet", () => {
    // The shipped bug: an option list built from `groups` alone is empty on a
    // fresh install, so the picker renders a menu with no rows — indistinguishable
    // from a clipped popover, and the inbox can never be filed.
    const opts = groupPickerOptions([]);
    expect(opts).toEqual([{ value: NEW_GROUP, isNew: true }]);
  });

  it("keeps the new-group entry last, after every existing group", () => {
    const opts = groupPickerOptions(["改写", "标书"]);
    expect(opts.map((o) => o.value)).toEqual(["改写", "标书", NEW_GROUP]);
    expect(opts.filter((o) => o.isNew)).toHaveLength(1);
  });
});

describe("findSnippetByName", () => {
  const mk = (id: string, name: string): Prompt =>
    ({ id, name, content: `body of ${id}`, scene: SNIPPET_SCENE });

  it("finds an exact (trimmed) match", () => {
    const snips = [mk("a", "冷处理改写"), mk("b", "条款偏差核查")];
    expect(findSnippetByName(snips, "  冷处理改写  ")?.id).toBe("a");
  });

  it("is case-sensitive — 'Lore' and 'lore' are different snippets", () => {
    const snips = [mk("a", "Lore扫描")];
    expect(findSnippetByName(snips, "lore扫描")).toBeUndefined();
  });

  it("returns undefined for an empty name and for no match", () => {
    const snips = [mk("a", "冷处理改写")];
    expect(findSnippetByName(snips, "")).toBeUndefined();
    expect(findSnippetByName(snips, "   ")).toBeUndefined();
    expect(findSnippetByName(snips, "不存在")).toBeUndefined();
  });
});
