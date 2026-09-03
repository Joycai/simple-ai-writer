/**
 * `read_document` (lib/agent/documentTools.ts) and the redirects that make the
 * three readers refuse each other's files in one round
 * (docs/feature/agent/document-read-plan.md D1, D4, D5, D6).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    const hit = files.get(p);
    if (hit === undefined) throw new Error(`no file: ${p}`);
    return hit;
  }),
  fileExists: vi.fn(async (p: string) => files.has(p)),
  writeFile: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
  writeBinaryFile: vi.fn(async () => {}),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  readDir: vi.fn(async () => []),
  makeDir: vi.fn(async () => {}),
  removeDir: vi.fn(async () => {}),
  removeFile: vi.fn(async () => {}),
  renamePath: vi.fn(async () => {}),
}));

const convertCached = vi.fn();
vi.mock("../../import/cachedConvert", () => ({
  convertCached: (...args: unknown[]) => convertCached(...args),
}));

import { readDocumentFile } from "../documentTools";
import { readSlidesFile, readWritingFile } from "../tools";

const PROJECT = "/proj";
const TAB = "\t";
const doc = (markdown: string, pictures = 0) => ({
  markdown,
  dir: "/proj/.ai-writer/tmp/convert/abcd",
  pictures,
  hit: false,
});

beforeEach(() => {
  files.clear();
  convertCached.mockReset();
});

describe("read_document routes", () => {
  it("refuses a path outside the project and the app's own data", async () => {
    const out = await readDocumentFile("t", "/elsewhere/a.docx", PROJECT);
    expect(out.content).toMatch(/outside the project/);
    const lore = await readDocumentFile("t", "/proj/.ai-writer/lore/x.pdf", PROJECT);
    expect(lore.content).toMatch(/outside the project/);
    expect(convertCached).not.toHaveBeenCalled();
  });

  it("sends a .pptx to read_slides, a text file to read_file, a legacy format nowhere", async () => {
    expect((await readDocumentFile("t", "/proj/deck.pptx", PROJECT)).content).toMatch(/Use read_slides/);
    expect((await readDocumentFile("t", "/proj/ch1.md", PROJECT)).content).toMatch(/Use read_file/);
    const legacy = await readDocumentFile("t", "/proj/old.doc", PROJECT);
    expect(legacy.content).toMatch(/Word 97-2003/);
    expect(legacy.content).toMatch(/\.docx/);
    expect(convertCached).not.toHaveBeenCalled();
  });

  it("converts docx / xlsx / pdf through the cache, passing the resolved path", async () => {
    convertCached.mockResolvedValue(doc("# 标题\n\n正文\n"));
    for (const [name, ext] of [["a.docx", "docx"], ["b.XLSX", "xlsx"], ["c.pdf", "pdf"]] as const) {
      await readDocumentFile("t", `/proj/in/${name}`, PROJECT);
      expect(convertCached).toHaveBeenLastCalledWith(PROJECT, `/proj/in/${name}`, ext);
    }
  });

  it("turns a converter failure into an error result, with the pdf subagent named for a PDF", async () => {
    convertCached.mockRejectedValue(new Error("file is 80MB — over the 64MB conversion limit"));
    const pdf = await readDocumentFile("t", "/proj/big.pdf", PROJECT);
    expect(pdf.content).toMatch(/^Error converting/);
    expect(pdf.content).toMatch(/pdf subagent/);
    const docx = await readDocumentFile("t", "/proj/big.docx", PROJECT);
    expect(docx.content).not.toMatch(/pdf subagent/);
  });
});

describe("read_document pages like read_file", () => {
  it("returns a short document whole, numbered, with the provenance trailer", async () => {
    convertCached.mockResolvedValue(doc("## 工作表1\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"));
    const out = await readDocumentFile("t", "/proj/表.xlsx", PROJECT);
    expect(out.content).toMatch(new RegExp(`^ *1${TAB}## 工作表1`));
    expect(out.content).toMatch(/whole file, \d+ lines/);
    expect(out.content).toMatch(/converted from 表\.xlsx \(the original is untouched; nothing was written to the project\)/);
    expect(out.content).toMatch(/line number, not document content/);
    expect(out.content).not.toMatch(/picture/);
  });

  it("pages a long document with the same start_line hand-off, and a heading map in front", async () => {
    const long = Array.from({ length: 300 }, (_, i) =>
      i % 50 === 0 ? `## 第${i / 50 + 1}节` : `第 ${i + 1} 行，一些正文文字用来撑长度。`,
    ).join("\n");
    convertCached.mockResolvedValue(doc(long));
    const first = await readDocumentFile("t", "/proj/长.docx", PROJECT);
    expect(first.content).toMatch(/lines 1-\d+ of 300 shown/);
    expect(first.content).toMatch(/pass start_line=\d+ to continue/);
    // The map precedes the numbered body.
    expect(first.content.indexOf("第1节")).toBeLessThan(first.content.indexOf(`1${TAB}## 第1节`));
    expect(first.content).toMatch(new RegExp(`^ *1${TAB}## 第1节`, "m"));
    const m = /start_line=(\d+)/.exec(first.content)!;
    const next = await readDocumentFile("t", "/proj/长.docx", PROJECT, Number(m[1]));
    expect(next.content).toMatch(new RegExp(`^ *${m[1]}${TAB}`, "m"));
  });

  it("names the extracted pictures' folder when there are any", async () => {
    convertCached.mockResolvedValue(doc("正文\n\n![](assets/p1-1.jpg)\n", 2));
    const out = await readDocumentFile("t", "/proj/图.docx", PROJECT);
    expect(out.content).toMatch(/2 pictures extracted under \/proj\/\.ai-writer\/tmp\/convert\/abcd\/assets/);
    expect(out.content).toMatch(/read_image/);
  });

  it("says so, in the result, when a PDF has no text layer", async () => {
    convertCached.mockResolvedValue(
      doc("<!-- page 1 -->\n\n![](assets/p1-1.jpg)\n\n<!-- page 2 -->\n\n![](assets/p2-1.jpg)\n", 2),
    );
    const out = await readDocumentFile("t", "/proj/扫描.pdf", PROJECT);
    expect(out.content).toMatch(/^Note: this PDF has no text layer/);
    expect(out.content).toMatch(/pdf subagent/);
    expect(out.content).toMatch(/read_image/);
    // Never for a docx — an empty Word file is just empty.
    const docx = await readDocumentFile("t", "/proj/空.docx", PROJECT);
    expect(docx.content).not.toMatch(/no text layer/);
  });
});

describe("the other readers redirect here", () => {
  it("read_file refuses docx / xlsx / pdf by name and points at read_document", async () => {
    files.set("/proj/a.docx", "PKzip noise");
    for (const [name, kind] of [
      ["a.docx", "Word document"],
      ["b.xlsx", "Excel workbook"],
      ["c.pdf", "PDF document"],
    ]) {
      const out = await readWritingFile("t", `/proj/${name}`, PROJECT);
      expect(out.content).toContain(`is a ${kind}, not a text file. Use read_document`);
    }
  });

  it("read_file still reads a text file, and still sends a .pptx to read_slides", async () => {
    files.set("/proj/ch1.md", "hello");
    expect((await readWritingFile("t", "/proj/ch1.md", PROJECT)).content).toMatch(new RegExp(`^ *1${TAB}hello`));
    expect((await readWritingFile("t", "/proj/deck.pptx", PROJECT)).content).toMatch(/Use read_slides/);
  });

  it("read_slides names read_document in its refusal", async () => {
    const out = await readSlidesFile("t", "/proj/a.docx", PROJECT);
    expect(out.content).toMatch(/read_document for Word \/ Excel \/ PDF/);
  });
});
