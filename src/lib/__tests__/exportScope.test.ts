/**
 * Which files the 导出 menu is allowed to appear for, and which files the title
 * bar's document readouts (字数 / 保存态 / 已修改) belong to.
 *
 * Both used to be "is a file open at all", and both were wrong for the same
 * reason: opening an image (or anything the editor cannot read as text) leaves
 * the editor buffer on the *previous* document. 导出 wrote that document out
 * under the picture's name, and the word count went on reporting its length.
 * `.html` is the other half — the editor does load it, but all three exports
 * start with `renderMarkdown`, so exporting a page's source double-rendered it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));
vi.mock("./fileio", () => ({ writeFile: vi.fn(), readDir: vi.fn(), readFile: vi.fn() }));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const { isExportableDocument } = await import("../fs/export");
const { docKindOf, isTextKind } = await import("../fs/docKind");

describe("isExportableDocument", () => {
  it("takes the files the markdown export pipeline is right for", () => {
    expect(isExportableDocument("C:/proj/第一章.md")).toBe(true);
    expect(isExportableDocument("C:/proj/notes.markdown")).toBe(true);
    expect(isExportableDocument("C:/proj/notes.txt")).toBe(true);
    expect(isExportableDocument("C:/proj/第一章.MD")).toBe(true);
  });

  it("leaves out an HTML deliverable, which the renderer would render twice", () => {
    expect(isExportableDocument("C:/proj/report.html")).toBe(false);
    expect(isExportableDocument("C:/proj/report.htm")).toBe(false);
  });

  it("leaves out everything with no text of its own in the editor", () => {
    // The buffer here still holds the last document — that is the export the
    // author used to get, named after the picture.
    expect(isExportableDocument("C:/proj/assets/封面.png")).toBe(false);
    expect(isExportableDocument("C:/proj/招标文件.docx")).toBe(false);
    expect(isExportableDocument("C:/proj/data.zip")).toBe(false);
    expect(isExportableDocument("C:/proj/README")).toBe(false);
  });
});

describe("docKindOf", () => {
  // 设计稿 01e 表 B, one row at a time: each kind is a different name list in
  // the title bar, so a file landing in the wrong one shows the wrong actions.
  it("sorts a file into exactly one of the five kinds", () => {
    expect(docKindOf("C:/proj/第一章.md")).toBe("markdown");
    expect(docKindOf("C:/proj/notes.markdown")).toBe("markdown");
    expect(docKindOf("C:/proj/notes.txt")).toBe("markdown");
    expect(docKindOf("C:/proj/年表.html")).toBe("html");
    expect(docKindOf("C:/proj/年表.HTM")).toBe("html");
    expect(docKindOf("C:/proj/封面.png")).toBe("image");
    expect(docKindOf("C:/proj/a.jpeg")).toBe("image");
    expect(docKindOf("C:/proj/大纲.docx")).toBe("convertible");
    expect(docKindOf("C:/proj/表.xlsx")).toBe("convertible");
    expect(docKindOf("C:/proj/合同.pdf")).toBe("convertible");
    expect(docKindOf("C:/proj/幻灯.pptx")).toBe("convertible");
    expect(docKindOf("C:/proj/data.zip")).toBe("opaque");
    expect(docKindOf("C:/proj/README")).toBe("opaque");
  });

  it("gives 字数 / 保存态 only to the kinds the editor loads as text", () => {
    expect(isTextKind(docKindOf("C:/proj/a.md"))).toBe(true);
    expect(isTextKind(docKindOf("C:/proj/a.html"))).toBe(true);
    for (const p of ["封面.png", "大纲.docx", "data.zip"]) {
      expect(isTextKind(docKindOf(`C:/proj/${p}`))).toBe(false);
    }
    expect(isTextKind(null)).toBe(false);
  });

  it("keeps the export scope narrower than the text scope", () => {
    // The two answer different questions and must not drift into one: an
    // .html file has a word count and a save state, but the three exports
    // would render its source as markdown, so it gets 打印 · PDF instead.
    expect(isTextKind(docKindOf("C:/proj/a.html"))).toBe(true);
    expect(isExportableDocument("C:/proj/a.html")).toBe(false);
  });
});
