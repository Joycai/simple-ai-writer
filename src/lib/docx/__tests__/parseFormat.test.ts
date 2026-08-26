/**
 * `parseDocFormat` —— 三个入口共用的归一层：从 config.db 读回自建预设、从应用
 * 配置备份导入、以及以后任何别的来路。
 *
 * 它的立场是**归一而不是拒绝**。一份预设里有一个字段坏了就整套消失，对作者来说
 * 是「我的格式不见了」；而缺的那一项本来就该落回默认。它同时是新增字段的兼容
 * 层——三期之前存下的预设没有页眉页脚和标题编号，读回来时在这里补上，不需要
 * 写一次数据迁移。
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_FORMATS, parseDocFormat } from "../format";

const CLEAN = BUILTIN_FORMATS.find((p) => p.id === "clean")!.format;
const GONGWEN = BUILTIN_FORMATS.find((p) => p.id === "gongwen")!.format;

describe("往返", () => {
  it("每一套内置预设过一遍都不变", () => {
    for (const preset of BUILTIN_FORMATS) {
      expect(parseDocFormat(JSON.parse(JSON.stringify(preset.format)))).toEqual(preset.format);
    }
  });
});

describe("缺什么补什么", () => {
  it("完全空的对象得到一整套底座", () => {
    expect(parseDocFormat({}, CLEAN)).toEqual(CLEAN);
  });

  it("三期之前存下的预设——没有页眉页脚和标题编号——读回来补上", () => {
    const { headerFooter: _hf, headingNumbering: _hn, ...old } = GONGWEN;
    const parsed = parseDocFormat(old, CLEAN);
    // 补的是**底座**的值，不是公文的：这份数据里没有那两块，无从得知作者要什么
    expect(parsed.headerFooter).toEqual(CLEAN.headerFooter);
    expect(parsed.headingNumbering).toEqual(CLEAN.headingNumbering);
    // 它自己写下来的东西一个都不能丢
    expect(parsed.body.font.eastAsia).toBe("仿宋_GB2312");
    expect(parsed.page.grid).toEqual(GONGWEN.page.grid);
  });

  it("一个字段坏了，其余照常——整套不该因此消失", () => {
    const broken = {
      ...JSON.parse(JSON.stringify(GONGWEN)),
      body: { ...GONGWEN.body, sizePt: "三号", align: "diagonal" },
    };
    const parsed = parseDocFormat(broken, CLEAN);
    expect(parsed.body.sizePt).toBe(CLEAN.body.sizePt);
    expect(parsed.body.align).toBe(CLEAN.body.align);
    // 同一个 body 里没坏的字段留着
    expect(parsed.body.font.eastAsia).toBe("仿宋_GB2312");
    expect(parsed.page.margins).toEqual(GONGWEN.page.margins);
  });

  it("越界的数值当没写——「三号」被当成 3 磅正是要防的那类", () => {
    const parsed = parseDocFormat({ body: { sizePt: 0 }, page: { margins: { top: 9999 } } }, CLEAN);
    expect(parsed.body.sizePt).toBe(CLEAN.body.sizePt);
    expect(parsed.page.margins.top).toBe(CLEAN.page.margins.top);
  });

  it("认不出的枚举落回底座", () => {
    const parsed = parseDocFormat(
      {
        page: { size: "A0" },
        body: { line: { rule: "elastic", value: 2 } },
        headerFooter: { pageNumber: "roman" },
        headingNumbering: { enabled: true, levels: ["roman", "chinese"] },
      },
      CLEAN,
    );
    expect(parsed.page.size).toBe(CLEAN.page.size);
    expect(parsed.body.line?.rule).toBe(CLEAN.body.line?.rule);
    expect(parsed.headerFooter.pageNumber).toBe(CLEAN.headerFooter.pageNumber);
    expect(parsed.headingNumbering.levels[0]).toBe(CLEAN.headingNumbering.levels[0]);
    // 认得出的那一项留下
    expect(parsed.headingNumbering.levels[1]).toBe("chinese");
    expect(parsed.headingNumbering.enabled).toBe(true);
  });

  it("null / 字符串 / 数组都不该炸", () => {
    for (const junk of [null, undefined, "格式", 42, [], true]) {
      expect(() => parseDocFormat(junk, CLEAN)).not.toThrow();
      expect(parseDocFormat(junk, CLEAN)).toEqual(CLEAN);
    }
  });

  it("网格显式为 null 表示不设网格，不是「缺了所以继承」", () => {
    const parsed = parseDocFormat({ page: { ...GONGWEN.page, grid: null } }, GONGWEN);
    expect(parsed.page.grid).toBeUndefined();
  });
});
