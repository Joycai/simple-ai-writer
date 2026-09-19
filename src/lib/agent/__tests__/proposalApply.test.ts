/**
 * `applyProposal`: one test per proposal kind, with the app handed in as
 * `ProposalApplyDeps` — which is the point of the module living in `lib/`
 * (docs/feature/code-structure-plan.md P5): the store only wires, and the
 * write half of every approval card is testable on its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = new Map<string, string>();
vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!disk.has(p)) throw new Error(`ENOENT ${p}`);
    return disk.get(p)!;
  }),
  writeFile: vi.fn(async (p: string, c: string) => void disk.set(p, c)),
}));
vi.mock("../backup", () => ({ backupFile: vi.fn(async (_root: string, p: string) => `/p/.ai-writer/backups/${p.split("/").pop()}`) }));

const materializeConversion = vi.fn(async () => "/p/doc.md");
vi.mock("../../import/materialize", () => ({ materializeConversion: (...a: unknown[]) => materializeConversion(...(a as [])) }));
const runCommand = vi.fn(async () => ({ report: "exit 0" }));
vi.mock("../../cli/run", () => ({ runCommand: (...a: unknown[]) => runCommand(...(a as [])) }));
const runIllustration = vi.fn(async () => ({ path: "/p/pic.png", markdown: "![](pic.png)", degraded: false }));
vi.mock("../../image/illustrate", () => ({ runIllustration: (...a: unknown[]) => runIllustration(...(a as [])) }));
vi.mock("../../pptx", () => ({ exportHtmlToPptx: vi.fn(async (_s: string, out: string) => ({ path: out, slides: 3, degraded: [] })) }));
vi.mock("../../docx", () => ({ exportMarkdownToDocx: vi.fn(async (_s: string, _f: unknown, out: string) => ({ path: out, blocks: 7, degraded: [] })) }));
const writeWorkbook = vi.fn(async () => {});
vi.mock("../../xlsx", () => ({ writeWorkbook: (...a: unknown[]) => writeWorkbook(...(a as [])) }));
const asrConn = { modelId: "qwen-asr", model: { id: "m-asr" } };
const transcribeFile = vi.fn(async () => ({
  transcript: { durationMs: 61_000, sentences: [{}, {}], speakers: false },
  billedSeconds: 61,
  cached: false,
}));
vi.mock("../../asr", () => ({
  resolveAsrConn: vi.fn(async () => asrConn),
  isAsrUnavailable: () => false,
  formatBytes: () => "1 MB",
  formatClock: () => "01:01",
  transcribeFile: (...a: unknown[]) => transcribeFile(...(a as [])),
  isAsrTimestampsEnabled: () => false,
  writeTranscript: vi.fn(async () => "/p/talk.md"),
  recordTranscriptionUsage: vi.fn(async () => {}),
  speakersMissing: () => false,
}));

import { applyProposal, type ProposalApplyDeps } from "../proposalApply";
import type { Proposal } from "../registry";

const OPEN = "/p/ch1.md";
const CLOSED = "/p/ch2.md";

function makeDeps(open: string | null = OPEN) {
  const buffer = { content: "", setContent: vi.fn(), saveNow: vi.fn(async () => {}) };
  buffer.setContent.mockImplementation((c: string) => { buffer.content = c; });
  const entries = {
    createEntry: vi.fn(async () => "/p/new.md"),
    moveEntry: vi.fn(async () => {}),
    copyEntry: vi.fn(async () => "/p/ch1 (1).md"),
    deleteEntry: vi.fn(async () => "/p/.ai-writer/backups/ch2.md"),
  };
  const lore = { index: {}, refreshEntity: vi.fn(async () => {}), scanProject: vi.fn(async () => {}) };
  const deps: ProposalApplyDeps = {
    projectPath: () => "/p",
    activeFilePath: () => open,
    editor: () => buffer,
    entries: () => entries,
    refreshFileTree: vi.fn(async () => {}),
    aiSettings: () => ({ models: [], providers: [], subAgents: {} as never }),
    lore: () => lore,
  };
  return { deps, buffer, entries, lore };
}

const apply = (p: object, deps: ProposalApplyDeps) => applyProposal(p as Proposal, deps);

beforeEach(() => {
  disk.clear();
  vi.clearAllMocks();
});

describe("applyProposal — manuscript writes", () => {
  it("edit on the open file goes through the editor buffer and is flushed", async () => {
    const { deps, buffer } = makeDeps();
    buffer.content = "甲乙丙";
    const out = await apply({ kind: "edit", path: OPEN, find: "乙", replace: "丁", occurrences: 1 }, deps);
    expect(buffer.content).toBe("甲丁丙");
    expect(buffer.saveNow).toHaveBeenCalled();
    expect(out.report).toContain("backups/ch1.md");
  });

  it("edit on a closed file is written to disk", async () => {
    const { deps, buffer } = makeDeps();
    disk.set(CLOSED, "甲乙丙");
    await apply({ kind: "edit", path: CLOSED, find: "乙", replace: "丁", occurrences: 1 }, deps);
    expect(disk.get(CLOSED)).toBe("甲丁丙");
    expect(buffer.setContent).not.toHaveBeenCalled();
  });

  it("rewrite replaces the whole file", async () => {
    const { deps } = makeDeps();
    disk.set(CLOSED, "old");
    await apply({ kind: "rewrite", path: CLOSED, content: "new" }, deps);
    expect(disk.get(CLOSED)).toBe("new");
  });

  it("append adds after whatever the file holds now", async () => {
    const { deps, buffer } = makeDeps();
    buffer.content = "一\n";
    await apply({ kind: "append", path: OPEN, content: "二\n" }, deps);
    expect(buffer.content).toBe("一\n二\n");
  });

  it("insert splices lines against the recorded line count", async () => {
    const { deps } = makeDeps();
    disk.set(CLOSED, "a\nb");
    await apply({ kind: "insert", path: CLOSED, lineCount: 2, insertions: [{ line: 2, text: "x" }] }, deps);
    expect(disk.get(CLOSED)).toBe("a\nx\nb");
  });
});

describe("applyProposal — file operations", () => {
  it("create splits the path into folder + name", async () => {
    const { deps, entries } = makeDeps();
    const out = await apply({ kind: "create", path: "/p/notes/a.md", content: "hi" }, deps);
    expect(entries.createEntry).toHaveBeenCalledWith("/p/notes", "a.md", "file", "hi");
    expect(out.report).toBeNull();
  });

  it("move", async () => {
    const { deps, entries } = makeDeps();
    await apply({ kind: "move", path: CLOSED, newPath: "/p/b.md" }, deps);
    expect(entries.moveEntry).toHaveBeenCalledWith(CLOSED, "/p/b.md");
  });

  it("copy reports where the copy actually landed", async () => {
    const { deps } = makeDeps();
    const out = await apply({ kind: "copy", path: OPEN, destDir: "/p", isDir: false }, deps);
    expect(out.resultPath).toBe("/p/ch1 (1).md");
  });

  it("delete always takes a backup", async () => {
    const { deps, entries } = makeDeps();
    const out = await apply({ kind: "delete", path: CLOSED }, deps);
    expect(entries.deleteEntry).toHaveBeenCalledWith(CLOSED, false, { backup: true });
    expect(out.report).toContain("backups");
  });

  it("convert materializes the cached conversion and refreshes the tree", async () => {
    const { deps } = makeDeps();
    const out = await apply({ kind: "convert", sourcePath: "/p/doc.docx", cacheDir: "/c", chars: 10, pictures: 0, scanned: false }, deps);
    expect(materializeConversion).toHaveBeenCalledWith("/p/doc.docx", "/c");
    expect(deps.refreshFileTree).toHaveBeenCalled();
    expect(out.resultPath).toBe("/p/doc.md");
  });

  it("loreStep applies nothing — the tool that raised it writes on yes", async () => {
    const { deps, entries } = makeDeps();
    expect(await apply({ kind: "loreStep" }, deps)).toEqual({ report: null });
    expect(entries.createEntry).not.toHaveBeenCalled();
  });
});

describe("applyProposal — kinds whose approval is the work", () => {
  it("command runs in the project with the proposal's cwd", async () => {
    const { deps } = makeDeps();
    const out = await apply({ kind: "command", command: "ls", path: "/p/sub", timeoutMs: 1000 }, deps);
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ projectPath: "/p", command: "ls", cwd: "/p/sub" }));
    expect(out.report).toBe("exit 0");
  });

  it("transcribe resolves the ASR connection from the handed-in settings", async () => {
    const { deps } = makeDeps();
    const out = await apply({ kind: "transcribe", sourcePath: "/p/talk.mp3", bytes: 1, diarization: false }, deps);
    expect(transcribeFile).toHaveBeenCalled();
    expect(out.resultPath).toBe("/p/talk.md");
    expect(out.report).toContain("Billed 61 seconds");
  });

  it("illustrate into a document refreshes the file tree", async () => {
    const { deps } = makeDeps();
    const out = await apply({ kind: "illustrate", dest: { kind: "document", path: OPEN } }, deps);
    expect(runIllustration).toHaveBeenCalled();
    expect(deps.refreshFileTree).toHaveBeenCalled();
    expect(out.imagePath).toBe("/p/pic.png");
  });

  it("illustrate into the knowledge base rescans when the index has lost the folder", async () => {
    const { deps, lore } = makeDeps();
    await apply({ kind: "illustrate", dest: { kind: "lore", entityDir: "/p/.ai-writer/lore/x" } }, deps);
    expect(lore.scanProject).toHaveBeenCalledWith("/p");
  });

  it("pptx", async () => {
    const { deps } = makeDeps();
    const out = await apply({ kind: "pptx", sourcePath: "/p/deck.html", path: "/p/deck.pptx", lint: [] }, deps);
    expect(out.report).toContain("Exported 3 slide(s)");
  });

  it("docx keeps an export summary for the turn", async () => {
    const { deps } = makeDeps();
    const out = await apply({
      kind: "docx", sourcePath: OPEN, path: "/p/ch1.docx", format: {}, originLabel: "手稿",
      originKind: "default", missingFonts: [],
    }, deps);
    expect(out.exportSummary).toMatchObject({ path: "/p/ch1.docx", blocks: 7 });
  });

  it("xlsx", async () => {
    const { deps } = makeDeps();
    const out = await apply({
      kind: "xlsx", path: "/p/t.xlsx", sheets: [], skipped: [],
      summaries: [{ name: "S", rows: 2, cols: 2, numbers: 1, dates: 0, formulas: 0 }],
    }, deps);
    expect(writeWorkbook).toHaveBeenCalled();
    expect(out.resultPath).toBe("/p/t.xlsx");
  });
});
