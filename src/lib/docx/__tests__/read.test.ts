/**
 * 「参考模仿」的映射层。Rust 侧只报「XML 里写着什么」，这里是全部判断——所以
 * 也是全部测试。
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_FORMATS, gridToDocx } from "../format";
import { layoutToFormat, type DocxLayout } from "../read";

const CLEAN = BUILTIN_FORMATS.find((p) => p.id === "clean")!.format;

/** 一份公文模板读出来的样子（数值取自 docx.rs 的同一份夹具）。 */
const GONGWEN: DocxLayout = {
  page: {
    width: 11906, height: 16838, landscape: false,
    marginTop: 2098, marginRight: 1474, marginBottom: 1984, marginLeft: 1587,
    // linePitch 取的是**生成端算出来的那个数**（gridToDocx：版心高 ÷ 每页行数
    // = 12756 ÷ 22），不是「28 磅 = 560」。两者在公文那套里本来就不相等——
    // 每页 22 行的三号字略微超出 156 × 225 的版心——而读写两端必须用同一个
    // 定义，否则模仿一次就掉一行。
    gridType: "linesAndChars", gridLinePitch: 580, gridCharSpace: -4,
  },
  body: {
    fontEastAsia: "仿宋_GB2312", fontAscii: "Times New Roman", sizeHalfPt: 32,
    line: 560, lineRule: "exact", spaceBefore: 0, spaceAfter: 0,
    firstLineChars: 200, align: "both",
  },
  headings: [
    { fontEastAsia: "黑体", sizeHalfPt: 44, align: "center", spaceAfter: 480, bold: false, pageBreakBefore: true },
    { fontEastAsia: "楷体_GB2312", sizeHalfPt: 32, bold: true },
    null,
    null,
  ],
};

const EMPTY: DocxLayout = {
  page: { landscape: false },
  body: {},
  headings: [null, null, null, null],
};

describe("读一份写死了格式的文件", () => {
  it("纸张按尺寸认，不按名字——OOXML 里根本没有「A4」这个词", () => {
    const { format } = layoutToFormat(GONGWEN, CLEAN);
    expect(format.page.size).toBe("A4");
    expect(format.page.landscape).toBe(false);
  });

  it("页边距、字体、字号、行距、缩进都落到位", () => {
    const { format } = layoutToFormat(GONGWEN, CLEAN);
    expect(format.page.margins).toEqual({ top: 37, right: 26, bottom: 35, left: 28 });
    expect(format.body.font.eastAsia).toBe("仿宋_GB2312");
    expect(format.body.sizePt).toBe(16);
    // 三态不能混：读出 exact 而不是 auto
    expect(format.body.line).toEqual({ rule: "exact", value: 28 });
    expect(format.body.firstLineChars).toBe(2);
    expect(format.body.align).toBe("justify");
  });

  it("网格从版心和 linePitch 反算回「每页多少行、每行多少字」", () => {
    const { format } = layoutToFormat(GONGWEN, CLEAN);
    expect(format.page.grid).toEqual({ linesPerPage: 22, charsPerLine: 28 });
  });

  it("和生成端互为逆运算——模仿一次不该掉一行", () => {
    // gridToDocx 是写出去的那一半，layoutToFormat 是读回来的那一半。这条
    // 断言把它们钉成一对：任何一边改了换算，这里就红。
    const gongwen = BUILTIN_FORMATS.find((p) => p.id === "gongwen")!.format;
    const grid = gridToDocx(gongwen.page, gongwen.body.sizePt)!;
    const { format } = layoutToFormat(
      {
        page: {
          width: 11906, height: 16838, landscape: false,
          marginTop: 2098, marginRight: 1474, marginBottom: 1984, marginLeft: 1587,
          gridType: grid.type, gridLinePitch: grid.linePitch, gridCharSpace: grid.charSpace,
        },
        body: { sizeHalfPt: 32 },
        headings: [null, null, null, null],
      },
      CLEAN,
    );
    expect(format.page.grid).toEqual(gongwen.page.grid);
  });

  it("逐级读标题，没声明的那级留底座的值", () => {
    const { format } = layoutToFormat(GONGWEN, CLEAN);
    expect(format.headings[0].font.eastAsia).toBe("黑体");
    expect(format.headings[0].sizePt).toBe(22);
    expect(format.headings[0].align).toBe("center");
    expect(format.headings[0].pageBreakBefore).toBe(true);
    expect(format.headings[1].bold).toBe(true);
    // H3/H4 文件里没写——落回底座，而不是变成空壳
    expect(format.headings[2]).toEqual(CLEAN.headings[2]);
  });

  it("逐项报出「这是它写死的」还是「这是我们补的」", () => {
    const { rows, declaredCount } = layoutToFormat(GONGWEN, CLEAN);
    const by = (label: string) => rows.find((r) => r.label === label)!;
    expect(by("正文中文")).toMatchObject({ value: "仿宋_GB2312", source: "declared" });
    expect(by("行距")).toMatchObject({ value: "固定值 28 磅", source: "declared" });
    expect(by("文档网格")).toMatchObject({ value: "22 行 × 28 字", source: "declared" });
    // 文件里没用到的标题级别是 absent，不是 declared——沿用的值不是它的要求
    expect(by("标题 3").source).toBe("absent");
    expect(declaredCount).toBeGreaterThan(5);
  });
});

describe("一份什么都没写死的文件", () => {
  it("不是错误——原样返回底座，但每一行的来源都是「Word 默认」", () => {
    const { format, rows, declaredCount, notes } = layoutToFormat(EMPTY, CLEAN);
    expect(format.body).toEqual(CLEAN.body);
    expect(format.page.margins).toEqual(CLEAN.page.margins);
    // 这才是 1i 那一屏要说的话：文件读成功了，但它不能当格式要求用。
    expect(declaredCount).toBe(0);
    expect(rows.every((r) => r.source !== "declared")).toBe(true);
    expect(rows.length).toBeGreaterThan(5);
    expect(notes).toEqual([]);
  });

  it("缺席不是零：没声明字号不等于 0 磅", () => {
    const { format } = layoutToFormat(EMPTY, CLEAN);
    expect(format.body.sizePt).toBe(CLEAN.body.sizePt);
    expect(format.body.sizePt).toBeGreaterThan(0);
  });
});

describe("认不出的纸张", () => {
  it("落回底座并说出来，而不是编一个尺寸", () => {
    const odd: DocxLayout = {
      ...EMPTY,
      page: { ...EMPTY.page, width: 9000, height: 13000 },
    };
    const { format, notes } = layoutToFormat(odd, CLEAN);
    expect(format.page.size).toBe(CLEAN.page.size);
    expect(notes.join()).toContain("自定义纸张");
  });
});

describe("横向", () => {
  it("orient 说了算，长宽反过来也认", () => {
    const landscape: DocxLayout = {
      ...EMPTY,
      page: { ...EMPTY.page, width: 16838, height: 11906, landscape: true },
    };
    const { format } = layoutToFormat(landscape, CLEAN);
    expect(format.page.size).toBe("A4");
    expect(format.page.landscape).toBe(true);
  });
});

describe("按磅写死的缩进", () => {
  it("按字号折回字符数——规格说的是「两个字」", () => {
    const byPoints: DocxLayout = {
      ...EMPTY,
      body: { sizeHalfPt: 32, firstLine: 640 }, // 32 磅 = 2 × 16 磅
    };
    const { format } = layoutToFormat(byPoints, CLEAN);
    expect(format.body.firstLineChars).toBe(2);
  });
});
