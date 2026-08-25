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

describe("页眉页脚（三期）", () => {
  it("什么都没设就一个分片都不发——空页眉在 Word 里会占着一行", async () => {
    const clean = BUILTIN_FORMATS.find((p) => p.id === "clean")!.format;
    const bare = { ...clean, headerFooter: { ...clean.headerFooter, pageNumber: "none" as const } };
    const zip = await build(bare);
    expect([...zip.keys()].some((k) => /word\/(header|footer)\d*\.xml/.test(k))).toBe(false);
  });

  it("公文的页码是一字线的「— 1 —」，落成域而不是死字", async () => {
    const zip = await build();
    const footers = [...zip.entries()].filter(([k]) => /word\/footer\d*\.xml/.test(k));
    expect(footers.length).toBeGreaterThan(0);
    const xml = footers.map(([, v]) => v).join("");
    expect(xml).toContain("— ");
    expect(xml).toContain(" —");
    // PAGE 域：Word 打开时才算出页码。写成死字的话第二页还是 1。
    expect(xml).toContain("PAGE");
  });

  it("奇偶页不同要在文档层开，否则偶数页那半安静地不出现", async () => {
    const zip = await build();
    expect(zip.get("word/settings.xml")).toContain("evenAndOddHeaders");
    // 单双两个页脚分片都要在
    expect([...zip.keys()].filter((k) => /word\/footer\d*\.xml/.test(k)).length).toBeGreaterThanOrEqual(2);
  });

  it("偶数页的对齐左右互换——装订后页码落在订口外侧", async () => {
    const zip = await build();
    const footers = [...zip.entries()]
      .filter(([k]) => /word\/footer\d*\.xml/.test(k))
      .map(([, v]) => v);
    const alignments = footers.flatMap((x) => [...x.matchAll(/<w:jc w:val="(\w+)"\/>/g)].map((m) => m[1]));
    expect(new Set(alignments)).toEqual(new Set(["right", "left"]));
  });

  it("页眉文字为空就不发页眉，只发页脚", async () => {
    const zip = await build();
    expect([...zip.keys()].some((k) => /word\/header\d*\.xml/.test(k))).toBe(false);
  });
});

describe("标题自动编号（三期）", () => {
  it("公文那套是 一、（一）1.（1）", async () => {
    const numbering = (await build()).get("word/numbering.xml")!;
    expect(numbering).toContain("chineseCounting");
    expect(numbering).toContain('w:val="%1、"');
    expect(numbering).toContain('w:val="（%2）"');
    expect(numbering).toContain('w:val="%3."');
  });

  it("序号和标题之间不插制表位", async () => {
    // Word 的默认 tab 会把标题推到一个和正文对不齐的位置上。
    const numbering = (await build()).get("word/numbering.xml")!;
    expect(numbering).toContain('<w:suff w:val="nothing"/>');
  });

  it("标题段落引用编号，正文段落不引用", async () => {
    const doc = (await build()).get("word/document.xml")!;
    const headings = [...doc.matchAll(/<w:p><w:pPr><w:pStyle w:val="Heading\d"\/>(.*?)<\/w:pPr>/g)];
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.every((m) => m[1].includes("<w:numPr>"))).toBe(true);
  });

  it("标题引用的确实是标题那份定义，不是列表的", async () => {
    // numId → abstractNumId → 那份定义的 lvlText。三份 numbering 定义同处一份
    // numbering.xml，而 numId 由 docx 自己分配——「标题指到列表的编号上」只会
    // 表现为序号变成了圆点，不会报任何错。
    const zip = await build();
    const numbering = zip.get("word/numbering.xml")!;
    const doc = zip.get("word/document.xml")!;

    const numToAbstract = new Map(
      [...numbering.matchAll(/<w:num w:numId="(\d+)"[^>]*>\s*<w:abstractNumId w:val="(\d+)"/g)]
        .map((m) => [m[1], m[2]] as const),
    );
    const abstractText = new Map(
      [...numbering.matchAll(/<w:abstractNum w:abstractNumId="(\d+)"[\s\S]*?<w:lvlText w:val="([^"]*)"/g)]
        .map((m) => [m[1], m[2]] as const),
    );

    const h1 = doc.match(/<w:pStyle w:val="Heading1"\/><w:numPr><w:ilvl w:val="0"\/><w:numId w:val="(\d+)"\/>/);
    expect(h1).not.toBeNull();
    expect(abstractText.get(numToAbstract.get(h1![1])!)).toBe("%1、");
  });

  it("关掉编号就不发这份定义，标题也不引用它", async () => {
    const clean = BUILTIN_FORMATS.find((p) => p.id === "clean")!.format;
    const zip = await build(clean);
    const doc = zip.get("word/document.xml")!;
    const headings = [...doc.matchAll(/<w:pStyle w:val="Heading\d"\/>(.*?)<\/w:pPr>/g)];
    expect(headings.every((m) => !m[1].includes("<w:numPr>"))).toBe(true);
  });

  it("写法是 none 的那一级不挂空编号", async () => {
    // 挂一个空编号，Word 仍会为它留出制表位，标题就莫名其妙地缩进了。
    const gongwen = BUILTIN_FORMATS.find((p) => p.id === "gongwen")!.format;
    const partial = {
      ...gongwen,
      headingNumbering: { enabled: true, levels: ["chinese", "none", "none", "none"] as const },
    };
    const doc = (await build(partial as typeof gongwen)).get("word/document.xml")!;
    const h2 = doc.match(/<w:pStyle w:val="Heading2"\/>(.*?)<\/w:pPr>/);
    expect(h2).not.toBeNull();
    expect(h2![1]).not.toContain("<w:numPr>");
  });
});

describe("首页不同 / 页眉横线 / 每章页码重来", () => {
  const withHF = (over: Partial<(typeof GONGWEN)["headerFooter"]>) => ({
    ...GONGWEN,
    headerFooter: { ...GONGWEN.headerFooter, ...over },
  });

  it("首页不同要发一个空的首页页脚——不发的话 Word 拿 default 顶上", async () => {
    const zip = await build(withHF({ differentFirstPage: true }));
    expect(zip.get("word/document.xml")).toContain("<w:titlePg/>");
    // default + even + first = 三个页脚分片
    expect([...zip.keys()].filter((k) => /word\/footer\d*\.xml/.test(k))).toHaveLength(3);
    // 其中一个是空的：首页什么都不写
    const empties = [...zip.entries()]
      .filter(([k]) => /word\/footer\d*\.xml/.test(k))
      .filter(([, v]) => !v.includes("PAGE"));
    expect(empties).toHaveLength(1);
  });

  it("关掉首页不同就不发 titlePg", async () => {
    const zip = await build(withHF({ differentFirstPage: false }));
    expect(zip.get("word/document.xml")).not.toContain("<w:titlePg/>");
  });

  it("页眉横线可以单独存在——有些模板就只要一条线", async () => {
    const zip = await build(withHF({ headerText: "", headerRule: true, differentFirstPage: false }));
    const headers = [...zip.entries()].filter(([k]) => /word\/header\d*\.xml/.test(k));
    expect(headers.length).toBeGreaterThan(0);
    expect(headers[0][1]).toContain("<w:pBdr>");
  });

  it("既没文字也没横线就一个页眉都不发", async () => {
    const zip = await build(withHF({ headerText: "", headerRule: false }));
    expect([...zip.keys()].some((k) => /word\/header\d*\.xml/.test(k))).toBe(false);
  });

  it("每章页码从 1 开始：一章一节，且每节都声明 start=1", async () => {
    const zip = await build(withHF({ restartEachChapter: true }));
    const doc = zip.get("word/document.xml")!;
    // 源文里只有一个一级标题，所以是一节；start 仍要写死，否则第二章接着数
    expect(doc).toContain('<w:pgNumType w:start="1"/>');
  });

  it("分节时一级标题让开 pageBreakBefore——否则每章前多一张白纸", async () => {
    const restart = await build(withHF({ restartEachChapter: true }));
    const plain = await build(withHF({ restartEachChapter: false }));
    const h1Of = (zip: Map<string, string>) =>
      zip.get("word/styles.xml")!.match(/<w:style [^>]*w:styleId="Heading1".*?<\/w:style>/s)![0];
    // 公文的一级标题本来不分页，所以拿手稿那套来验：它的 H1 是 pageBreakBefore
    expect(h1Of(plain).includes("pageBreakBefore")).toBe(h1Of(restart).includes("pageBreakBefore"));
    const manuscript = BUILTIN_FORMATS.find((p) => p.id === "manuscript")!.format;
    const on = await build({
      ...manuscript,
      headerFooter: { ...manuscript.headerFooter, restartEachChapter: true },
    });
    const off = await build(manuscript);
    expect(h1Of(off)).toContain("pageBreakBefore");
    expect(h1Of(on)).not.toContain("pageBreakBefore");
  });
});
