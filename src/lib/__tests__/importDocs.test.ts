/**
 * Document import: the HTML→markdown rules the docx path lands on, the PDF
 * line/paragraph reconstruction, and the naming/dispatch helpers. The dialog
 * and the mammoth/pdfjs library calls stay untested here — those are thin
 * adapters over vendored code; the logic of the importer is all in these
 * pure layers.
 */
import { describe, expect, it } from "vitest";
import { docxToMarkdown, imageCollector } from "../import/docx";
import { htmlToMarkdown, tidyMarkdown } from "../import/markdown";
import {
  itemsToLines,
  linesToMarkdown,
  pageToMarkdown,
  type PdfTextItem,
} from "../import/pdf";
import { decodeText } from "../import/text";
import {
  baseName,
  convertExtOf,
  importMode,
  importedName,
  markdownName,
  uniqueImportPath,
} from "../import";

describe("htmlToMarkdown", () => {
  it("converts headings, lists and emphasis to atx/dash markdown", () => {
    const md = htmlToMarkdown(
      "<h2>技术要求</h2><p>系统应支持<strong>高可用</strong>部署。</p><ul><li>双机热备</li><li>异地容灾</li></ul>",
    );
    expect(md).toContain("## 技术要求");
    expect(md).toContain("**高可用**");
    // Turndown pads list markers to a 4-char column ("-   item") — match the
    // marker + content, not the exact padding.
    expect(md).toMatch(/^-\s+双机热备$/m);
    expect(md).toMatch(/^-\s+异地容灾$/m);
  });

  it("keeps tables as gfm tables", () => {
    const md = htmlToMarkdown(
      "<table><tr><th>指标</th><th>要求</th></tr><tr><td>并发</td><td>≥1000</td></tr></table>",
    );
    // One header row, one delimiter row, one data row. The gfm plugin pads
    // cells for column alignment, so match content rather than exact spacing.
    expect(md).toMatch(/\| 指标\s+\| 要求\s+\|/);
    expect(md).toMatch(/\| 并发\s+\| ≥1000\s*\|/);
    expect(md).toMatch(/\| ---/);
  });

  it("drops data-URL and src-less images, never inlining base64", () => {
    const md = htmlToMarkdown(
      '<p>前文</p><p><img src="data:image/png;base64,AAAA" alt="盖章页"><img alt="EMF 图表"></p><p>后文</p>',
    );
    expect(md).not.toContain("data:image");
    expect(md).not.toContain("![");
    expect(md).toContain("前文");
    expect(md).toContain("后文");
  });

  it("keeps file-linked images with their alt text", () => {
    const md = htmlToMarkdown(
      '<p>前文</p><p><img src="assets/bid/img-1.png" alt="盖章页"></p>',
    );
    expect(md).toContain("![盖章页](assets/bid/img-1.png)");
  });

  it("collapses the blank runs image removal leaves behind", () => {
    expect(tidyMarkdown("a\n\n\n\n\nb\r\nc")).toBe("a\n\nb\nc");
  });
});

describe("pdf line reconstruction", () => {
  const item = (str: string, y: number, hasEOL = false, x = 0): PdfTextItem => ({
    str,
    x,
    y,
    hasEOL,
  });

  it("folds same-line items and splits on hasEOL", () => {
    const lines = itemsToLines([
      item("2.1 投标人须", 700),
      item("具备相应资质", 700, true),
      item("2.2 项目周期", 680, true),
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      "2.1 投标人须具备相应资质",
      "2.2 项目周期",
    ]);
  });

  it("splits on a y jump even without hasEOL", () => {
    // Some producers never set hasEOL; the y movement is the only line signal.
    const lines = itemsToLines([item("第一行", 700), item("第二行", 680)]);
    expect(lines.map((l) => l.text)).toEqual(["第一行", "第二行"]);
  });

  it("tolerates small y wobble (sub/superscripts) within one line", () => {
    const lines = itemsToLines([item("m", 700), item("2", 701.5), item("以上", 700)]);
    expect(lines.map((l) => l.text)).toEqual(["m2以上"]);
  });

  it("drops whitespace-only lines", () => {
    const lines = itemsToLines([item("  ", 700, true), item("正文", 680, true)]);
    expect(lines.map((l) => l.text)).toEqual(["正文"]);
  });

  it("breaks paragraphs on gaps clearly larger than the typical spacing", () => {
    // Regular 20pt line spacing, then a 60pt hole before the next section.
    const md = linesToMarkdown([
      { y: 700, text: "第一段第一行" },
      { y: 680, text: "第一段第二行" },
      { y: 620, text: "第二段" },
    ]);
    expect(md).toBe("第一段第一行\n第一段第二行\n\n第二段");
  });

  it("handles empty and single-line pages", () => {
    expect(linesToMarkdown([])).toBe("");
    expect(linesToMarkdown([{ y: 700, text: "唯一一行" }])).toBe("唯一一行");
  });
});

describe("pageToMarkdown image placement", () => {
  const lines = [
    { y: 700, text: "第一段第一行" },
    { y: 680, text: "第一段第二行" },
    { y: 620, text: "第二段" },
  ];

  it("inserts an image as its own paragraph where its top edge falls", () => {
    const md = pageToMarkdown(lines, [{ y: 650, relPath: "assets/bid/p1-1.jpg" }]);
    expect(md).toBe(
      "第一段第一行\n第一段第二行\n\n![](assets/bid/p1-1.jpg)\n\n第二段",
    );
  });

  it("splits a paragraph an image lands inside", () => {
    const md = pageToMarkdown(
      [
        { y: 700, text: "上半句" },
        { y: 680, text: "下半句" },
      ],
      [{ y: 690, relPath: "assets/bid/p1-1.jpg" }],
    );
    expect(md).toBe("上半句\n\n![](assets/bid/p1-1.jpg)\n\n下半句");
  });

  it("places images above and below all text at the edges", () => {
    const md = pageToMarkdown(lines, [
      { y: 800, relPath: "assets/bid/p1-1.jpg" },
      { y: 100, relPath: "assets/bid/p1-2.jpg" },
    ]);
    expect(md.startsWith("![](assets/bid/p1-1.jpg)\n\n第一段第一行")).toBe(true);
    expect(md.endsWith("第二段\n\n![](assets/bid/p1-2.jpg)")).toBe(true);
  });

  it("renders an image-only page (a scanned page) top to bottom", () => {
    const md = pageToMarkdown(
      [],
      [
        { y: 100, relPath: "assets/bid/p1-2.jpg" },
        { y: 800, relPath: "assets/bid/p1-1.jpg" },
      ],
    );
    expect(md).toBe("![](assets/bid/p1-1.jpg)\n\n![](assets/bid/p1-2.jpg)");
  });

  it("percent-encodes non-ASCII path segments, keeping the slashes", () => {
    const md = pageToMarkdown([], [{ y: 100, relPath: "assets/标书/p1-1.jpg" }]);
    expect(md).toBe("![](assets/%E6%A0%87%E4%B9%A6/p1-1.jpg)");
  });

  it("keeps the text's own paragraph grouping around an inserted image", () => {
    // The image at the top must not disturb how the lines below it group: the
    // 60pt hole before 第二段 stays a paragraph break, the 20pt gaps stay soft.
    const md = pageToMarkdown(lines, [{ y: 800, relPath: "assets/bid/p1-1.jpg" }]);
    expect(md).toBe(
      "![](assets/bid/p1-1.jpg)\n\n第一段第一行\n第一段第二行\n\n第二段",
    );
  });
});

describe("docx image collector", () => {
  it("names images in document order and percent-encodes the link", () => {
    const c = imageCollector("assets/标书");
    expect(c.collect("image/png", new Uint8Array([1]))).toEqual({
      src: "assets/%E6%A0%87%E4%B9%A6/img-1.png",
    });
    expect(c.collect("image/jpeg", new Uint8Array([2])).src).toContain("img-2.jpg");
    expect(c.assets.map((a) => a.name)).toEqual(["img-1.png", "img-2.jpg"]);
  });

  it("signals unsupported formats with an empty src, keeping no bytes", () => {
    const c = imageCollector("assets/bid");
    // EMF/WMF — the vector drawings Office embeds for charts and formulas.
    expect(c.collect("image/x-emf", new Uint8Array([1]))).toEqual({ src: "" });
    expect(c.collect("image/png", new Uint8Array())).toEqual({ src: "" });
    expect(c.assets).toEqual([]);
    // The counter only advances for kept images — no gaps in the names.
    expect(c.collect("image/png", new Uint8Array([1])).src).toContain("img-1.png");
  });
});

/**
 * Minimal stored (uncompressed) zip writer — enough of the format for a
 * hand-built .docx fixture, so the mammoth image path is tested end to end
 * without a binary checked into the repo.
 */
function storedZip(entries: Array<[string, Uint8Array]>): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (data: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunks: number[] = [];
  const push = (bytes: number[] | Uint8Array) => chunks.push(...bytes);
  const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const central: number[] = [];
  for (const [name, data] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const offset = chunks.length;
    push(u32(0x04034b50));
    push(u16(20)); // version needed
    push(u16(0)); // flags
    push(u16(0)); // method: stored
    push(u32(0)); // dos time+date
    push(u32(crc));
    push(u32(data.length));
    push(u32(data.length));
    push(u16(nameBytes.length));
    push(u16(0)); // extra
    push(nameBytes);
    push(data);
    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u32(0), ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset), ...nameBytes,
    );
  }
  const cdOffset = chunks.length;
  push(central);
  push(u32(0x06054b50));
  push(u16(0));
  push(u16(0));
  push(u16(entries.length));
  push(u16(entries.length));
  push(u32(central.length));
  push(u32(cdOffset));
  push(u16(0)); // comment length
  return new Uint8Array(chunks);
}

describe("docxToMarkdown", () => {
  const xml = (s: string) => new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`);
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fixture = storedZip([
    [
      "[Content_Types].xml",
      xml(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Default Extension="png" ContentType="image/png"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          "</Types>",
      ),
    ],
    [
      "_rels/.rels",
      xml(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          "</Relationships>",
      ),
    ],
    [
      "word/_rels/document.xml.rels",
      xml(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
          "</Relationships>",
      ),
    ],
    [
      "word/document.xml",
      xml(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
          ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
          ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
          ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"' +
          ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          "<w:body>" +
          "<w:p><w:r><w:t>前文</w:t></w:r></w:p>" +
          '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="图1" descr="盖章页"/>' +
          '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
          '<pic:pic><pic:blipFill><a:blip r:embed="rId4"/></pic:blipFill></pic:pic>' +
          "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>" +
          "<w:p><w:r><w:t>后文</w:t></w:r></w:p>" +
          "</w:body></w:document>",
      ),
    ],
    ["word/media/image1.png", pngBytes],
  ]);

  it("lands the embedded picture as an asset and a relative link", async () => {
    const { markdown, assets } = await docxToMarkdown(fixture, "assets/标书");
    expect(assets).toEqual([{ name: "img-1.png", bytes: pngBytes }]);
    expect(markdown).toContain("前文");
    expect(markdown).toContain("![盖章页](assets/%E6%A0%87%E4%B9%A6/img-1.png)");
    expect(markdown).toContain("后文");
    expect(markdown).not.toContain("data:image");
  });
});

describe("decodeText", () => {
  it("decodes UTF-8", () => {
    expect(decodeText(new TextEncoder().encode("招标文件"))).toBe("招标文件");
  });

  const gbkAvailable = (() => {
    try {
      new TextDecoder("gbk");
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(gbkAvailable)("falls back to GBK when the bytes are not UTF-8", () => {
    // "中文" in GBK — invalid as UTF-8, so the strict pass must reject it.
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeText(gbk)).toBe("中文");
  });
});

describe("naming and dispatch", () => {
  it("converts office documents and copies everything else as-is", () => {
    expect(importMode("标书.docx")).toBe("convert");
    expect(importMode("报价表.xlsx")).toBe("convert");
    expect(importMode("C:\\bids\\招标文件.PDF")).toBe("convert");
    expect(importMode("路演.pptx")).toBe("convert");
    // Text the app already opens is copied, not rewritten — a .txt renamed to
    // .md would start being read as markdown.
    expect(importMode("notes.txt")).toBe("copy-text");
    expect(importMode("readme.md")).toBe("copy-text");
    expect(importMode("架构图.html")).toBe("copy-text");
    expect(importMode("封面.PNG")).toBe("copy-binary");
    // Legacy .doc/.xls/.ppt are out on purpose — see CONVERT_EXTENSIONS. The
    // xlsx parser would in fact read .xls, so this assertion is what keeps it
    // from drifting into the picker on its own; .ppt is an OLE compound
    // binary that the .pptx reader genuinely cannot open.
    expect(importMode("old.doc")).toBeNull();
    expect(importMode("old.xls")).toBeNull();
    expect(importMode("old.ppt")).toBeNull();
    expect(importMode("noext")).toBeNull();
  });

  it("names the format a convertible file converts through", () => {
    // The file tree's 转换文档 asks this instead of `importMode`, and the
    // converter dispatch switches on it — the two must never disagree about
    // what CONVERT_EXTENSIONS contains.
    expect(convertExtOf("标书.docx")).toBe("docx");
    expect(convertExtOf("C:\\bids\\招标文件.PDF")).toBe("pdf");
    expect(convertExtOf("路演.pptx")).toBe("pptx");
    expect(convertExtOf("报价表.xlsx")).toBe("xlsx");
    // Everything the app already opens has nothing to convert *to*: a menu
    // item on a .md would produce a copy of itself.
    expect(convertExtOf("readme.md")).toBeNull();
    expect(convertExtOf("封面.png")).toBeNull();
    expect(convertExtOf("old.doc")).toBeNull();
    expect(convertExtOf("noext")).toBeNull();
  });

  it("takes the basename from either separator style", () => {
    expect(baseName("C:\\bids\\招标文件.docx")).toBe("招标文件.docx");
    expect(baseName("/home/u/bids/招标文件.docx")).toBe("招标文件.docx");
  });

  it("swaps the extension for .md", () => {
    expect(markdownName("招标文件.docx")).toBe("招标文件.md");
    expect(markdownName("archive.tar.pdf")).toBe("archive.tar.md");
    expect(markdownName("noext")).toBe("noext.md");
  });

  it("names a conversion .md and leaves a copy's own name alone", () => {
    expect(importedName("招标文件.docx", "convert")).toBe("招标文件.md");
    expect(importedName("笔记.txt", "copy-text")).toBe("笔记.txt");
    expect(importedName("封面.PNG", "copy-binary")).toBe("封面.PNG");
  });

  it("numbers collisions from -2 upward, keeping the extension", async () => {
    const taken = new Set(["d/标书.md", "d/标书-2.md", "d/封面.png"]);
    const exists = async (p: string) => taken.has(p);
    expect(await uniqueImportPath("d", "标书.md", exists)).toBe("d/标书-3.md");
    expect(await uniqueImportPath("d", "其他.md", exists)).toBe("d/其他.md");
    expect(await uniqueImportPath("d", "封面.png", exists)).toBe("d/封面-2.png");
  });
});
