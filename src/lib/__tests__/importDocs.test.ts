/**
 * Document import: the HTML→markdown rules the docx path lands on, the PDF
 * line/paragraph reconstruction, and the naming/dispatch helpers. The dialog
 * and the mammoth/pdfjs library calls stay untested here — those are thin
 * adapters over vendored code; the logic of the importer is all in these
 * pure layers.
 */
import { describe, expect, it } from "vitest";
import { htmlToMarkdown, tidyMarkdown } from "../import/markdown";
import { itemsToLines, linesToMarkdown, type PdfTextItem } from "../import/pdf";
import { decodeText } from "../import/text";
import {
  baseName,
  importExtension,
  markdownName,
  uniqueMarkdownPath,
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

  it("drops images instead of inlining data URLs", () => {
    const md = htmlToMarkdown(
      '<p>前文</p><p><img src="data:image/png;base64,AAAA" alt="盖章页"></p><p>后文</p>',
    );
    expect(md).not.toContain("data:image");
    expect(md).not.toContain("![");
    expect(md).toContain("前文");
    expect(md).toContain("后文");
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
  it("recognises exactly the supported extensions", () => {
    expect(importExtension("标书.docx")).toBe("docx");
    expect(importExtension("报价表.xlsx")).toBe("xlsx");
    expect(importExtension("C:\\bids\\招标文件.PDF")).toBe("pdf");
    expect(importExtension("notes.txt")).toBe("txt");
    expect(importExtension("readme.md")).toBe("md");
    // Legacy .doc/.xls are out on purpose — see IMPORT_EXTENSIONS. The xlsx
    // parser would in fact read .xls, so this assertion is what keeps it from
    // drifting into the picker on its own.
    expect(importExtension("old.doc")).toBeNull();
    expect(importExtension("old.xls")).toBeNull();
    expect(importExtension("noext")).toBeNull();
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

  it("numbers collisions from -2 upward", async () => {
    const taken = new Set(["d/标书.md", "d/标书-2.md"]);
    const exists = async (p: string) => taken.has(p);
    expect(await uniqueMarkdownPath("d", "标书.docx", exists)).toBe("d/标书-3.md");
    expect(await uniqueMarkdownPath("d", "其他.docx", exists)).toBe("d/其他.md");
  });
});
