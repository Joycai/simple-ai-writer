import { describe, expect, it } from "vitest";
import {
  BUILTIN_FORMATS,
  formatLineSpacing,
  formatSize,
  formatSummary,
  gridToDocx,
  lineSpacingToTwip,
  mmToTwip,
  parseLineSpacing,
  parseSize,
  ptToHalfPt,
  ptToTwip,
} from "../format";

describe("单位换算", () => {
  it("磅和毫米都落到 twip", () => {
    expect(ptToTwip(28)).toBe(560);
    // 37mm = 2097.64 twip。我们四舍五入到 2098；docx 自己的
    // convertMillimetersToTwip 截断成 2097（实测样张里就是那个数）。差 1 twip
    // = 1/1440 英寸，物理上无意义——但这里不用它们的换算函数，所以两边不必一样。
    expect(mmToTwip(37)).toBe(2098);
    expect(mmToTwip(210)).toBe(11906);
  });

  it("字号是半磅——三号（16 磅）是 32", () => {
    expect(ptToHalfPt(16)).toBe(32);
    expect(ptToHalfPt(10.5)).toBe(21);
  });
});

describe("中文号数", () => {
  it("认号数、认磅、认带单位的磅", () => {
    expect(parseSize("三号")).toBe(16);
    expect(parseSize(" 小四 ")).toBe(12);
    expect(parseSize("16")).toBe(16);
    expect(parseSize("10.5pt")).toBe(10.5);
    expect(parseSize("22磅")).toBe(22);
  });

  it("认不出就是 null，不猜", () => {
    expect(parseSize("大号")).toBeNull();
    expect(parseSize("")).toBeNull();
    expect(parseSize("0")).toBeNull();
  });

  it("显示时号数和磅一起写——只写一种，作者就核不了另一种", () => {
    expect(formatSize(16)).toBe("三号（16 磅）");
    expect(formatSize(13)).toBe("13 磅");
  });
});

describe("行距三态", () => {
  it("固定值 / 最小值 / 倍数分得开", () => {
    expect(parseLineSpacing("固定值28磅")).toEqual({ rule: "exact", value: 28 });
    expect(parseLineSpacing("最小值 20 磅")).toEqual({ rule: "atLeast", value: 20 });
    expect(parseLineSpacing("1.5倍")).toEqual({ rule: "auto", value: 1.5 });
    expect(parseLineSpacing("1.5")).toEqual({ rule: "auto", value: 1.5 });
  });

  it("倍数是 240 的倍数，固定值是磅×20", () => {
    expect(lineSpacingToTwip({ rule: "auto", value: 1.5 })).toEqual({ line: 360, lineRule: "auto" });
    expect(lineSpacingToTwip({ rule: "exact", value: 28 })).toEqual({ line: 560, lineRule: "exact" });
  });

  it("显示时带上三态的名字", () => {
    expect(formatLineSpacing({ rule: "exact", value: 28 })).toBe("固定值 28 磅");
    expect(formatLineSpacing({ rule: "auto", value: 1.5 })).toBe("1.5 倍行距");
  });

  it("认不出就是 null", () => {
    expect(parseLineSpacing("宽一点")).toBeNull();
  });
});

describe("文档网格", () => {
  it("每页行数从版心高反算 linePitch", () => {
    const gongwen = BUILTIN_FORMATS.find((p) => p.id === "gongwen")!.format;
    const grid = gridToDocx(gongwen.page, gongwen.body.sizePt)!;
    expect(grid.type).toBe("linesAndChars");
    // 版心高 = 297 - 37 - 35 = 225mm；22 行
    expect(grid.linePitch).toBe(Math.round(mmToTwip(225) / 22));
    // 每行 28 个三号字要 8960 twip，而版心只有 156mm = 8843——所以公文那套的
    // 字间距**本来就是负的**（Word 自己也这么算）。这里钉住量级，不钉住符号：
    // 把它夹到 0 会静默改掉版面。
    expect(grid.charSpace).toBeGreaterThan(-40);
    expect(grid.charSpace).toBeLessThan(40);
  });

  it("没声明网格就不发 docGrid", () => {
    const clean = BUILTIN_FORMATS.find((p) => p.id === "clean")!.format;
    expect(gridToDocx(clean.page, clean.body.sizePt)).toBeUndefined();
  });
});

describe("内置预设", () => {
  it("公文那套就是实测样张的规格", () => {
    const f = BUILTIN_FORMATS.find((p) => p.id === "gongwen")!.format;
    expect(f.body.font.eastAsia).toBe("仿宋_GB2312");
    expect(f.body.sizePt).toBe(16);
    expect(f.body.line).toEqual({ rule: "exact", value: 28 });
    expect(f.body.firstLineChars).toBe(2);
    expect(f.page.margins).toEqual({ top: 37, right: 26, bottom: 35, left: 28 });
  });

  it("摘要写的是最终值，号数和磅都在", () => {
    const f = BUILTIN_FORMATS.find((p) => p.id === "gongwen")!.format;
    const summary = formatSummary(f);
    expect(summary.join("\n")).toContain("三号（16 磅）");
    expect(summary.join("\n")).toContain("固定值 28 磅");
    expect(summary.join("\n")).toContain("首行缩进 2 字符");
    expect(summary.join("\n")).toContain("每页 22 行");
  });

  it("每个预设的 id 唯一", () => {
    const ids = BUILTIN_FORMATS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
