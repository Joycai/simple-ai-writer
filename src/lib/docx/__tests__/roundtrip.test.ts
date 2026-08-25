/**
 * 回读断言：生成 → 解包 → 断言 XML 里的值**等于**声明的值。
 *
 * 这条测试的对象不是「导出会不会崩」，而是 00-feasibility §7.3 那句话——
 * 生成端是确定性的「一张表 → XML」映射，所以只要那张表对，产出必然对。它钉住
 * 的是**库升级带来的静默漂移**：§2.1 里那个「用 paragraphStyles 覆盖 Heading1
 * 会产出两个同名 styleId」的坑，正是这样发现的。
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_FORMATS, mmToTwip } from "../format";
import { markdownToBlocks } from "../blocks";
import { blocksToDocx } from "../write";
import { unzip } from "./zip";

const GONGWEN = BUILTIN_FORMATS.find((p) => p.id === "gongwen")!.format;

const SOURCE = `# 关于印发《测试办法》的通知

## 一、总体要求

为规范测试工作，特制定本办法。**重点**在于可核对。

- 第一条
- 第二条

| 姓名 | 年龄 |
|---|---|
| 甲 | 1 |
`;

async function build(format = GONGWEN) {
  const { blocks } = markdownToBlocks(SOURCE);
  const bytes = await blocksToDocx(blocks, format, new Map());
  return unzip(bytes);
}

describe("产出是一份真 .docx", () => {
  it("该有的分片都在", async () => {
    const zip = await build();
    for (const part of ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/numbering.xml"]) {
      expect(zip.has(part)).toBe(true);
    }
  });
});

describe("声明了什么，XML 里就是什么", () => {
  it("正文字体、字号、行距、首行缩进", async () => {
    const styles = (await build()).get("word/styles.xml")!;
    // 中西文分开，且 hint=eastAsia——没有它半角标点会按西文字体走
    expect(styles).toContain('w:eastAsia="仿宋_GB2312"');
    expect(styles).toContain('w:hint="eastAsia"');
    // 三号 = 16 磅 = 32 半磅
    expect(styles).toContain('<w:sz w:val="32"/>');
    // 固定值 28 磅 = 560 twip，且 lineRule 必须是 exact 而不是 auto——三态混了
    // 是打印出来才发现的错
    const defaults = styles.match(/<w:pPrDefault>.*?<\/w:pPrDefault>/s)![0];
    expect(defaults).toContain('w:line="560"');
    expect(defaults).toContain('w:lineRule="exact"');
    // 首行缩进按「字符」而不是按磅
    expect(defaults).toContain('<w:ind w:firstLineChars="200"/>');
  });

  it("纸张、页边距、文档网格", async () => {
    const doc = (await build()).get("word/document.xml")!;
    expect(doc).toContain(`w:top="${mmToTwip(37)}"`);
    expect(doc).toContain(`w:bottom="${mmToTwip(35)}"`);
    expect(doc).toContain(`w:left="${mmToTwip(28)}"`);
    expect(doc).toContain(`w:right="${mmToTwip(26)}"`);
    expect(doc).toContain('w:type="linesAndChars"');
  });

  it("一级标题是黑体二号居中", async () => {
    const styles = (await build()).get("word/styles.xml")!;
    const h1 = [...styles.matchAll(/<w:style [^>]*w:styleId="Heading1".*?<\/w:style>/gs)];
    expect(h1).toHaveLength(1); // ← 两个就是 §2.1 那个坑复发了
    expect(h1[0][0]).toContain('w:eastAsia="黑体"');
    expect(h1[0][0]).toContain('<w:sz w:val="44"/>'); // 二号 = 22 磅
    expect(h1[0][0]).toContain('<w:jc w:val="center"/>');
  });

  it("没有任何重复的 styleId", async () => {
    const styles = (await build()).get("word/styles.xml")!;
    const ids = [...styles.matchAll(/w:styleId="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("正文结构", () => {
  it("中文原样落进 XML，不需要任何转义（这正是 RTF 做不到的）", async () => {
    const doc = (await build()).get("word/document.xml")!;
    expect(doc).toContain("关于印发《测试办法》的通知");
    expect(doc).toContain("为规范测试工作");
  });

  it("标题引用样式，列表引用编号，表格是真表格", async () => {
    const doc = (await build()).get("word/document.xml")!;
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
    expect(doc).toContain('<w:pStyle w:val="Heading2"/>');
    expect(doc).toContain("<w:numPr>");
    expect(doc).toContain("<w:tbl>");
  });

  it("粗体只落在该粗的那一段文字上", async () => {
    const doc = (await build()).get("word/document.xml")!;
    const bolded = doc.match(/<w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t[^>]*>重点<\/w:t><\/w:r>/);
    expect(bolded).not.toBeNull();
  });
});

describe("换一套格式，XML 跟着换", () => {
  it("素雅那套没有文档网格，行距是倍数", async () => {
    const clean = BUILTIN_FORMATS.find((p) => p.id === "clean")!.format;
    const zip = await build(clean);
    expect(zip.get("word/document.xml")!).not.toContain("linesAndChars");
    expect(zip.get("word/styles.xml")!).toContain('w:lineRule="auto"');
  });
});
