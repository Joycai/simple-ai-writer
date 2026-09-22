/**
 * The category note's disk seam: `.ai-writer/lore/<category>/index.md`, read
 * for its summary only and written whole (folder made on the way).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const dirs: string[] = [];
vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
    return files.get(p)!;
  }),
  writeFile: vi.fn(async (p: string, text: string) => { files.set(p, text); }),
  makeDir: vi.fn(async (p: string) => { dirs.push(p); }),
}));

import { readCategoryNotes, writeCategoryNote } from "../categoryNote";

beforeEach(() => { files.clear(); dirs.length = 0; });

describe("readCategoryNotes", () => {
  it("returns the summary of every category that has a note, and nothing for the rest", async () => {
    files.set("/p/.ai-writer/lore/characters/index.md", "# 人物\n\n有名字、会推动剧情的人。\n\n* [a](a) - x");
    files.set("/p/.ai-writer/lore/world/index.md", "<!-- 还没写 -->");

    const notes = await readCategoryNotes("/p", ["characters", "world", "items"]);

    expect(notes).toEqual({ characters: "有名字、会推动剧情的人。" });
  });

  it("is empty without a project", async () => {
    files.set("/.ai-writer/lore/characters/index.md", "x");
    expect(await readCategoryNotes("", ["characters"])).toEqual({});
  });
});

describe("writeCategoryNote", () => {
  it("makes the category folder and writes the note with a trailing newline", async () => {
    await writeCategoryNote("/p", "world", "地名与势力。");

    expect(dirs).toEqual(["/p/.ai-writer/lore/world"]);
    expect(files.get("/p/.ai-writer/lore/world/index.md")).toBe("地名与势力。\n");
  });

  it("does not double the newline of a note that already ends with one", async () => {
    await writeCategoryNote("/p", "world", "地名与势力。\n");
    expect(files.get("/p/.ai-writer/lore/world/index.md")).toBe("地名与势力。\n");
  });
});
