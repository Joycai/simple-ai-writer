/**
 * What the three export tools know **before** the author approves.
 *
 * The three lines share one hazard: the conversion runs no model, so its
 * correctness rests entirely on the source conforming to a convention the
 * model only ever read in a tool description — and until this pass, a source
 * that did not conform produced a card the author approved and a file that was
 * wrong. `export_xlsx` already built its workbook at proposal time; these tests
 * pin the other two catching up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = new Map<string, string>();

vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!fs.has(p)) throw new Error(`ENOENT: ${p}`);
    return fs.get(p)!;
  }),
  fileExists: vi.fn(async (p: string) => fs.has(p)),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  writeBinaryFile: vi.fn(async () => {}),
}));

// The format store reaches prefs and the DB on construction; the docx tool only
// ever asks it which presets exist, so the built-ins stand in for it.
vi.mock("../../../stores/docFormatStore", async () => {
  const { BUILTIN_FORMATS, DEFAULT_FORMAT_ID } = await import("../../docx/format");
  return {
    currentFormats: () => ({ presets: BUILTIN_FORMATS, defaultId: DEFAULT_FORMAT_ID }),
    imitatedIdFor: (p: string) => `imitated:${p}`,
    useDocFormatStore: { getState: () => ({ addImitated: () => {} }) },
  };
});

import { exportPptxTool } from "../pptxTools";
import { exportDocxTool } from "../docxTools";
import { outlineMarkdown } from "../../docx";
import { WHOLE_PAGE_TIER } from "../../pptx/htmlSlides";
import type { Proposal, ToolContext } from "../registry";

const PROJECT = "/proj";
const captured: Proposal[] = [];

const ctx = (): ToolContext =>
  ({
    projectPath: PROJECT,
    loreIndex: {},
    multimodal: false,
    requestApproval: async (p: Proposal) => {
      captured.push(p);
      return { approved: true as const, backupPath: "done" };
    },
  }) as unknown as ToolContext;

beforeEach(() => {
  fs.clear();
  captured.length = 0;
});

const page = (body: string) => `<!doctype html>\n<html>\n<body>\n${body}\n</body>\n</html>\n`;

describe("export_pptx preflight", () => {
  it("counts the slides and names the selector before anything is rendered", async () => {
    fs.set(`${PROJECT}/deck.html`, page('<section class="slide">一</section><section class="slide">二</section>'));

    await exportPptxTool("c1", { html_path: `${PROJECT}/deck.html` }, ctx());

    expect(captured[0]).toMatchObject({
      kind: "pptx",
      slides: 2,
      tier: "section.slide",
      wholePage: false,
    });
  });

  // The failure this whole preflight exists for: the author approves two paths,
  // and what appears is one slide with the entire page squashed onto it.
  it("flags the page that has no slide sections at all", async () => {
    fs.set(`${PROJECT}/poster.html`, page("<div><h1>海报</h1></div>"));

    await exportPptxTool("c1", { html_path: `${PROJECT}/poster.html` }, ctx());

    expect(captured[0]).toMatchObject({ slides: 1, tier: WHOLE_PAGE_TIER, wholePage: true });
  });

  it("still refuses a path that is not html, or is not there", async () => {
    const notHtml = await exportPptxTool("c1", { html_path: `${PROJECT}/a.md` }, ctx());
    expect(notHtml.content).toContain("not an .html file");

    const missing = await exportPptxTool("c1", { html_path: `${PROJECT}/gone.html` }, ctx());
    expect(missing.content).toContain("there is no file");

    expect(captured).toHaveLength(0);
  });
});

describe("outlineMarkdown", () => {
  it("counts what the conversion will actually produce", () => {
    const outline = outlineMarkdown(
      ["# 标题", "", "正文一段。", "", "- 甲", "- 乙", "", "| a | b |", "| - | - |", "| 1 | 2 |"].join("\n"),
    );

    expect(outline.headings).toBe(1);
    expect(outline.paragraphs).toBe(1);
    expect(outline.listItems).toBe(2);
    expect(outline.tables).toBe(1);
    expect(outline.blocks).toBe(5);
  });

  // frontmatter is this app's metadata, not the document — counting it as body
  // is how "why is there a wall of dashes on page 1" happens.
  it("does not count frontmatter as content", () => {
    expect(outlineMarkdown("---\ntitle: x\n---\n").blocks).toBe(0);
    expect(outlineMarkdown("---\ntitle: x\n---\n\n正文。").blocks).toBe(1);
  });
});

describe("export_docx preflight", () => {
  it("puts the content outline on the proposal beside the format", async () => {
    fs.set(`${PROJECT}/周报.md`, "# 本周\n\n做了三件事。\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");

    await exportDocxTool("c1", { source_path: `${PROJECT}/周报.md` }, ctx());

    expect(captured[0]).toMatchObject({
      kind: "docx",
      outline: { headings: 1, paragraphs: 1, tables: 1 },
    });
  });

  // Same early exit as export_xlsx's "no tables here": better a sentence the
  // model can act on than a card the author approves for an empty file.
  it("refuses a document with nothing in it rather than proposing one", async () => {
    fs.set(`${PROJECT}/空.md`, "---\ntitle: 空\n---\n\n   \n");

    const res = await exportDocxTool("c1", { source_path: `${PROJECT}/空.md` }, ctx());

    expect(res.content).toContain("no content to convert");
    expect(captured).toHaveLength(0);
  });
});
