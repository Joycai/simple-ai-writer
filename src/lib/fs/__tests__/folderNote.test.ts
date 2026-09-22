/**
 * The folder note's contract: optional everywhere, tolerant of what it does not
 * know, and silent until it has prose — a freshly written template must not
 * read as a description of the folder.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
vi.mock("../fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
    return files.get(p)!;
  }),
}));

import {
  FOLDER_NOTE_SUMMARY_MAX,
  folderNoteTemplate,
  isFolderNoteFile,
  nearestFolderNote,
  parseFolderNote,
  readFolderNote,
} from "../folderNote";

beforeEach(() => files.clear());

describe("parseFolderNote", () => {
  it("reads status from frontmatter and defaults to stable", () => {
    expect(parseFolderNote("---\nstatus: deprecated\n---\n旧稿。").status).toBe("deprecated");
    expect(parseFolderNote("---\nstatus: draft\n---\n").status).toBe("draft");
    expect(parseFolderNote("只有正文。").status).toBe("stable");
  });

  it("reads a note saved with Windows line endings", () => {
    const note = parseFolderNote("---\r\nstatus: draft\r\n---\r\n# 卷一\r\n\r\n草稿卷。\r\n第二行。\r\n\r\n后文。");
    expect(note.status).toBe("draft");
    expect(note.summary).toBe("草稿卷。 第二行。");
  });

  it("tolerates a status it does not know, and a note with no frontmatter at all", () => {
    expect(parseFolderNote("---\nstatus: archived\nowner: me\n---\nx").status).toBe("stable");
    expect(parseFolderNote("").status).toBe("stable");
  });

  it("takes the first prose paragraph as the summary, skipping headings and lists", () => {
    const note = parseFolderNote("# 第一卷\n\n* [a.md](a.md) - x\n\n主线的前十章，人物以此为准。\n第二行接上。\n\n后面的段落。");
    expect(note.summary).toBe("主线的前十章，人物以此为准。 第二行接上。");
  });

  it("falls back to a frontmatter description, then to nothing", () => {
    expect(parseFolderNote("---\ndescription: 来自 frontmatter\n---\n# 标题\n").summary).toBe("来自 frontmatter");
    expect(parseFolderNote("# 标题\n\n- 列表\n").summary).toBeNull();
  });

  it("ignores HTML comments, so the unfilled template has no summary", () => {
    const fresh = folderNoteTemplate("第一卷", true);
    expect(parseFolderNote(fresh).summary).toBeNull();
    expect(parseFolderNote(fresh).status).toBe("stable");
    // The English template says the same thing in English.
    expect(parseFolderNote(folderNoteTemplate("Vol 1", false)).summary).toBeNull();
  });

  it("caps a long summary", () => {
    const long = "字".repeat(FOLDER_NOTE_SUMMARY_MAX + 50);
    expect(parseFolderNote(long).summary).toHaveLength(FOLDER_NOTE_SUMMARY_MAX + 1);
    expect(parseFolderNote(long).summary?.endsWith("…")).toBe(true);
  });
});

describe("isFolderNoteFile", () => {
  it("is index.md in any case, and nothing else", () => {
    expect(isFolderNoteFile("index.md")).toBe(true);
    expect(isFolderNoteFile("Index.MD")).toBe(true);
    expect(isFolderNoteFile("index.txt")).toBe(false);
    expect(isFolderNoteFile("我的index.md")).toBe(false);
  });
});

describe("readFolderNote / nearestFolderNote", () => {
  it("returns null for a folder without a note", async () => {
    expect(await readFolderNote("/p/卷一")).toBeNull();
  });

  it("finds the nearest note walking up, and flags a deprecated ancestor", async () => {
    files.set("/p/废稿/index.md", "---\nstatus: deprecated\n---\n第一版。");
    files.set("/p/废稿/卷一/index.md", "第一版的第一卷。");

    const ctx = await nearestFolderNote("/p", "/p/废稿/卷一/第3章.md");

    expect(ctx?.dir).toBe("/p/废稿/卷一");
    expect(ctx?.note.summary).toBe("第一版的第一卷。");
    expect(ctx?.deprecated).toBe(true);
  });

  it("reads the project root's own note, and stops there", async () => {
    files.set("/p/index.md", "整个项目。");
    files.set("/index.md", "不该读到这里。");

    const ctx = await nearestFolderNote("/p", "/p/卷一/第1章.md");

    expect(ctx?.dir).toBe("/p");
    expect(ctx?.deprecated).toBe(false);
  });

  it("answers null outside the project", async () => {
    files.set("/elsewhere/index.md", "x");
    expect(await nearestFolderNote("/p", "/elsewhere/a.md")).toBeNull();
    expect(await nearestFolderNote("", "/p/a.md")).toBeNull();
    expect(await nearestFolderNote("/p", "a.md")).toBeNull();
  });

  it("terminates on a Windows path whose case differs from the project's", async () => {
    files.set("D:/Proj/卷一/index.md", "第一卷。");
    files.set("d:/proj/卷一/index.md", "第一卷。");

    const ctx = await nearestFolderNote("D:/Proj", "d:\\proj\\卷一\\第1章.md");

    expect(ctx?.note.summary).toBe("第一卷。");
    expect(ctx?.deprecated).toBe(false);
  });

  it("does not quote a note to itself: an open index.md takes its parent's note", async () => {
    files.set("/p/index.md", "整个项目。");
    files.set("/p/卷一/index.md", "---\nstatus: deprecated\n---\n第一卷。");

    const ctx = await nearestFolderNote("/p", "/p/卷一/index.md");

    expect(ctx?.dir).toBe("/p");
    expect(ctx?.deprecated).toBe(false);
    expect(await nearestFolderNote("/p", "/p/index.md")).toBeNull();
  });
});
