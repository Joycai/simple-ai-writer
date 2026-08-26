import { describe, expect, it } from "vitest";
import type { LoreEntity, LoreIndex } from "../../lore/model";
import {
  collectGlossary,
  enforceGlossary,
  formatDictBody,
  formatGlossary,
  MAX_GLOSSARY_ENTRIES,
  parseDictBody,
  type GlossaryEntry,
} from "../glossary";

function entity(name: string, aliases: string[], summary = "", dict = false): LoreEntity {
  return {
    id: name,
    category: "characters",
    dirPath: `/p/.ai-writer/lore/characters/${name}`,
    name,
    aliases,
    summary,
    dict,
    avatarPath: null,
    collections: [],
    mdFiles: [],
    images: [],
    facets: [],
  };
}

const INDEX: LoreIndex = {
  characters: [
    entity("芙美香", ["文香", "ふみちん"], "主人公，白山学院的学生会长，成绩优秀"),
    entity("小芙", []),
  ],
  world: [entity("白山学院", ["白山学園"], "  故事发生的学校  ")],
};

describe("collectGlossary", () => {
  it("只收本块命中的别名", () => {
    const entries = collectGlossary(INDEX, "文香は扉を開けた。");
    expect(entries.map((e) => `${e.src}->${e.dst}`)).toEqual(["文香->芙美香"]);
  });

  it("命中判定顺带筛掉了中文别名 —— 不需要靠字符集去猜哪个是源词", () => {
    // 一段日文原文里不会出现作者写的中文译名，所以 includes 就是筛子本身。
    const entries = collectGlossary(INDEX, "彼女は扉を開けた。");
    expect(entries).toEqual([]);
  });

  it("按源词长度降序 —— 取舍时留下更特指的那个，顺序也和强制替换一致", () => {
    const entries = collectGlossary(INDEX, "文香とふみちんは白山学園にいる。");
    // 同长的两个按码元比，不按 locale —— 同一份知识库在两台机器上必须切出同一张表。
    expect(entries.map((e) => e.src)).toEqual(["ふみちん", "白山学園", "文香"]);
  });

  it("备注取自条目摘要，压成一行并去掉首尾空白", () => {
    const [e] = collectGlossary(INDEX, "白山学園。");
    expect(e.note).toBe("故事发生的学校");
  });

  it("长摘要被截断 —— 备注是给模型的一句提示，不是条目正文", () => {
    const long = "主人公，白山学院的学生会长，成绩优秀运动万能，同时也是守护世界的魔法爱姬";
    const idx: LoreIndex = { characters: [entity("芙美香", ["文香"], long)] };
    const [e] = collectGlossary(idx, "文香。");
    expect(e.note).toBe(long.slice(0, 24) + "…");
    expect(e.note!.length).toBeLessThan(long.length);
  });

  it("摘要为空时不留一个空 #", () => {
    const idx: LoreIndex = { characters: [entity("译名", ["原名"])] };
    expect(collectGlossary(idx, "原名")[0].note).toBeUndefined();
    expect(formatGlossary(collectGlossary(idx, "原名"))).toBe("原名->译名");
  });

  it("别名与条目名相同的词条不进表 —— 它什么都不表达，只占一行", () => {
    const idx: LoreIndex = { characters: [entity("文香", ["文香"])] };
    expect(collectGlossary(idx, "文香は。")).toEqual([]);
  });

  it("同一个源词只出现一次", () => {
    const idx: LoreIndex = {
      characters: [entity("甲", ["原名"]), entity("乙", ["原名"])],
    };
    expect(collectGlossary(idx, "原名")).toHaveLength(1);
  });

  it("有上限 —— 术语表要占上下文，而这个模型的窗口本来就不打算塞满", () => {
    const many = Array.from({ length: 60 }, (_, i) => entity(`译${i}`, [`原名${i}`]));
    const text = many.map((e) => e.aliases[0]).join("、");
    expect(collectGlossary({ characters: many }, text)).toHaveLength(MAX_GLOSSARY_ENTRIES);
  });
});

describe("parseDictBody", () => {
  it("一行一条 src->dst #备注，就是 Sakura 的格式", () => {
    expect(parseDictBody("文香->芙美香 #主人公\nふみちん->小芙")).toEqual([
      { src: "文香", dst: "芙美香", note: "主人公" },
      { src: "ふみちん", dst: "小芙" },
    ]);
  });

  it("宽容 → 箭头和 markdown 列表符号 —— 作者在条目正文里多半写成列表", () => {
    const body = "- 文香→芙美香\n* ふみちん -> 小芙\n1. 白山学園->白山学院";
    expect(parseDictBody(body).map((e) => `${e.src}->${e.dst}`)).toEqual([
      "文香->芙美香",
      "ふみちん->小芙",
      "白山学園->白山学院",
    ]);
  });

  it("= 和 ＝ 也是分隔符 —— GalTransl 等工具词表的惯用格式，实机踩过被静默跳过", () => {
    const body = "文香=芙美香 #主人公\nふみちん＝小芙";
    expect(parseDictBody(body)).toEqual([
      { src: "文香", dst: "芙美香", note: "主人公" },
      { src: "ふみちん", dst: "小芙" },
    ]);
  });

  it("同一行里箭头优先于 = —— src 懒匹配切在第一个分隔符上", () => {
    // 备注里出现 = 不该把词条切错。
    const [e] = parseDictBody("文香->芙美香 #罗马字 fumika=ka");
    expect(e).toEqual({ src: "文香", dst: "芙美香", note: "罗马字 fumika=ka" });
  });

  it("标题、说明文字、空行静默跳过 —— 正文允许夹杂说明", () => {
    const body = "# 术语\n\n这是给翻译用的词表。\n\n文香->芙美香";
    expect(parseDictBody(body)).toEqual([{ src: "文香", dst: "芙美香" }]);
  });

  it("src === dst 的行不进表", () => {
    expect(parseDictBody("文香->文香")).toEqual([]);
  });

  it("备注走和摘要相同的截断预算", () => {
    const long = "主人公，白山学院的学生会长，成绩优秀运动万能，同时也是守护世界的魔法爱姬";
    const [e] = parseDictBody(`文香->芙美香 #${long}`);
    expect(e.note).toBe(long.slice(0, 24) + "…");
  });

  it("# 后面为空时不留一个空备注", () => {
    expect(parseDictBody("文香->芙美香 #")).toEqual([{ src: "文香", dst: "芙美香" }]);
  });
});

describe("formatDictBody", () => {
  it("一行一条，备注不截断 —— 条目正文是作者的资产，截断属于发给模型的清单", () => {
    const long = "主人公，白山学院的学生会长，成绩优秀运动万能，同时也是守护世界的魔法爱姬";
    const body = formatDictBody([
      { src: "文香", dst: "芙美香", note: long },
      { src: "ふみちん", dst: "小芙" },
    ]);
    expect(body).toBe(`文香->芙美香 #${long}\nふみちん->小芙`);
    // 渲染出的正文必须能被自己的解析器读回来——AI 标准化的闭环就靠这条。
    expect(parseDictBody(body).map((e) => e.src)).toEqual(["文香", "ふみちん"]);
  });
});

describe("collectGlossary + 翻译词典", () => {
  const dict: GlossaryEntry[] = [
    { src: "文香", dst: "文乃", note: "词典指定" },
    { src: "スケルトン", dst: "骷髅" },
  ];

  it("词典行同样只收本块命中的", () => {
    const entries = collectGlossary({}, "スケルトンが来た。", dict);
    expect(entries).toEqual([{ src: "スケルトン", dst: "骷髅", note: undefined }]);
  });

  it("同一个源词词典赢过别名 —— 那一行是作者专门为翻译写的", () => {
    const entries = collectGlossary(INDEX, "文香は扉を開けた。", dict);
    expect(entries).toEqual([{ src: "文香", dst: "文乃", note: "词典指定" }]);
  });

  it("勾了开关的条目不进别名通道 —— 它的名字/别名是给作者找条目用的，不是译名", () => {
    const idx: LoreIndex = {
      custom: [entity("词典·人名", ["じしょ"], "词表条目", true)],
    };
    expect(collectGlossary(idx, "じしょ", [])).toEqual([]);
  });

  it("没勾开关的条目就算叫「翻译词典」也只是普通条目 —— 判据是开关，不是名字", () => {
    const idx: LoreIndex = {
      custom: [entity("翻译词典", ["じしょ"], "")],
    };
    expect(collectGlossary(idx, "じしょ", [])).toEqual([
      { src: "じしょ", dst: "翻译词典", note: undefined },
    ]);
  });

  it("上限对两个通道合并计数", () => {
    const many = Array.from({ length: 40 }, (_, i) => entity(`译${i}`, [`原名${i}`]));
    const dictMany: GlossaryEntry[] = Array.from({ length: 40 }, (_, i) => ({
      src: `辞書${i}`,
      dst: `词${i}`,
    }));
    const text = [...many.map((e) => e.aliases[0]), ...dictMany.map((e) => e.src)].join("、");
    expect(collectGlossary({ characters: many }, text, dictMany)).toHaveLength(MAX_GLOSSARY_ENTRIES);
  });
});

describe("formatGlossary", () => {
  it("一行一条 src->dst #备注", () => {
    expect(formatGlossary([{ src: "文香", dst: "芙美香", note: "主人公" }, { src: "ふみちん", dst: "小芙" }])).toBe(
      "文香->芙美香 #主人公\nふみちん->小芙",
    );
  });
});

describe("enforceGlossary", () => {
  const entries: GlossaryEntry[] = [
    { src: "文香", dst: "芙美香" },
    { src: "文香さん", dst: "芙美香小姐" },
  ];

  it("补上模型漏替的地方 —— 术语表只是软提示，实测漏了一半", () => {
    expect(enforceGlossary("文香拿出了粉饼盒。", entries)).toBe("芙美香拿出了粉饼盒。");
  });

  it("最长词优先", () => {
    // 短词先跑会把 `文香さん` 吃成 `芙美香さん`，再也拼不回来。
    expect(enforceGlossary("文香さん、こんにちは。", entries)).toBe("芙美香小姐、こんにちは。");
  });

  it("已经译对的地方不动", () => {
    expect(enforceGlossary("芙美香拿出了粉饼盒。", entries)).toBe("芙美香拿出了粉饼盒。");
  });

  it("不碰 URL、链接目标和行内代码 —— 那里面改一个字就是坏链接", () => {
    const g: GlossaryEntry[] = [{ src: "assets", dst: "资源" }, { src: "文香", dst: "芙美香" }];
    const src = "![文香](assets/文香.png) 见 https://x.test/assets/文香 与 `assets/文香`，文香在此。";
    const out = enforceGlossary(src, g);
    expect(out).toContain("](assets/文香.png)");
    expect(out).toContain("https://x.test/assets/文香");
    expect(out).toContain("`assets/文香`");
    // 图片的 alt 文本在保护区之外，是正文，照常替换。
    expect(out).toContain("![芙美香]");
    expect(out.endsWith("芙美香在此。")).toBe(true);
  });

  it("空表原样返回", () => {
    expect(enforceGlossary("原样", [])).toBe("原样");
  });
});
