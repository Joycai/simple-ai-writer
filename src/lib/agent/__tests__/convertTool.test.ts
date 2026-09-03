/**
 * `convert_document` (lib/agent/convertTools.ts): what the card knows before
 * the author approves, and what the model hears afterwards.
 * docs/feature/agent/document-read-plan.md §10.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const existing = new Set<string>();
vi.mock("../../fs/fileio", () => ({
  fileExists: vi.fn(async (p: string) => existing.has(p)),
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => {}),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  writeBinaryFile: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
  makeDir: vi.fn(async () => {}),
  removeDir: vi.fn(async () => {}),
  renamePath: vi.fn(async () => {}),
  copyPath: vi.fn(async () => {}),
}));

const convertCached = vi.fn();
vi.mock("../../import/cachedConvert", () => ({
  convertCached: (...args: unknown[]) => convertCached(...args),
}));

import { CONVERT_EXCERPT_CHARS, convertDocumentTool } from "../convertTools";
import type { ApprovalDecision, Proposal, ToolContext } from "../registry";

const PROJECT = "/proj";
const captured: Proposal[] = [];
let decision: ApprovalDecision = { approved: true, backupPath: "landed report" };

const ctx = (withApproval = true): ToolContext =>
  ({
    projectPath: PROJECT,
    loreIndex: {},
    multimodal: false,
    requestApproval: withApproval
      ? async (p: Proposal) => {
          captured.push(p);
          return decision;
        }
      : undefined,
  }) as unknown as ToolContext;

const cached = (markdown: string, pictures = 0) => ({
  markdown,
  dir: "/proj/.ai-writer/tmp/convert/abcd",
  pictures,
  hit: false,
});

beforeEach(() => {
  existing.clear();
  captured.length = 0;
  convertCached.mockReset();
  decision = { approved: true, backupPath: "landed report" };
});

describe("convert_document preflight", () => {
  it("errors, without proposing, on a surface with no approval channel", async () => {
    const out = await convertDocumentTool("c", { path: `${PROJECT}/a.docx` }, ctx(false));
    expect(out.content).toMatch(/cannot review/);
    expect(convertCached).not.toHaveBeenCalled();
  });

  it("refuses a text file, a legacy format, a missing file and a path outside the project", async () => {
    expect((await convertDocumentTool("c", { path: `${PROJECT}/a.md` }, ctx())).content).toMatch(/needs no conversion/);
    expect((await convertDocumentTool("c", { path: `${PROJECT}/a.doc` }, ctx())).content).toMatch(/not a \.docx/);
    expect((await convertDocumentTool("c", { path: `${PROJECT}/gone.docx` }, ctx())).content).toMatch(/no file at/);
    expect((await convertDocumentTool("c", { path: "/elsewhere/a.docx" }, ctx())).content).toMatch(/outside the project/);
    expect(captured).toHaveLength(0);
    expect(convertCached).not.toHaveBeenCalled();
  });

  it("turns a converter failure into an error, not a card", async () => {
    existing.add(`${PROJECT}/big.pdf`);
    convertCached.mockRejectedValue(new Error("file is 80MB — over the 64MB conversion limit"));
    const out = await convertDocumentTool("c", { path: `${PROJECT}/big.pdf` }, ctx());
    expect(out.content).toMatch(/^Error converting/);
    expect(captured).toHaveLength(0);
  });
});

describe("the card's proposal", () => {
  it("carries the finished conversion's facts — target beside the source, size, pictures, excerpt", async () => {
    existing.add(`${PROJECT}/招标/招标文件.docx`);
    const text = "# 第一章\n\n正文……\n\n![](assets/p1-1.jpg)\n";
    convertCached.mockResolvedValue(cached(text, 1));

    const out = await convertDocumentTool(
      "c",
      { path: `${PROJECT}/招标/招标文件.docx`, reason: "留一份可编辑的" },
      ctx(),
    );

    expect(convertCached).toHaveBeenCalledWith(PROJECT, `${PROJECT}/招标/招标文件.docx`, "docx");
    expect(captured[0]).toMatchObject({
      kind: "convert",
      path: `${PROJECT}/招标/招标文件.md`,
      sourcePath: `${PROJECT}/招标/招标文件.docx`,
      ext: "docx",
      cacheDir: "/proj/.ai-writer/tmp/convert/abcd",
      chars: text.length,
      pictures: 1,
      scanned: false,
      excerpt: text,
      reason: "留一份可编辑的",
    });
    // The apply step's report comes back on the shared channel.
    expect(out.content).toBe("landed report");
  });

  it("clips the excerpt, and flags a PDF that came out as a scan", async () => {
    existing.add(`${PROJECT}/扫描.pdf`);
    const scan = "<!-- page 1 -->\n\n![](assets/p1-1.jpg)\n";
    convertCached.mockResolvedValue(cached(scan, 1));
    await convertDocumentTool("c", { path: `${PROJECT}/扫描.pdf` }, ctx());
    expect(captured[0]).toMatchObject({ kind: "convert", ext: "pdf", scanned: true });

    existing.add(`${PROJECT}/long.pptx`);
    const long = "x".repeat(CONVERT_EXCERPT_CHARS * 3);
    convertCached.mockResolvedValue(cached(long));
    await convertDocumentTool("c", { path: `${PROJECT}/long.pptx` }, ctx());
    const p = captured[1] as Extract<Proposal, { kind: "convert" }>;
    expect(p.excerpt).toHaveLength(CONVERT_EXCERPT_CHARS);
    expect(p.chars).toBe(long.length);
    // Only a PDF can be a scan; an all-picture deck is just a deck.
    expect(p.scanned).toBe(false);
  });

  it("reports a rejection with the author's reason and points back at read_document", async () => {
    existing.add(`${PROJECT}/a.xlsx`);
    convertCached.mockResolvedValue(cached("## 表1\n\n| a |\n|---|\n| 1 |\n"));
    decision = { approved: false, reason: "不用落盘" };
    const out = await convertDocumentTool("c", { path: `${PROJECT}/a.xlsx` }, ctx());
    expect(out.content).toMatch(/REJECTED/);
    expect(out.content).toMatch(/不用落盘/);
    expect(out.content).toMatch(/read_document/);
  });
});
