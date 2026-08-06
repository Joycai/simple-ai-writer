/**
 * Where a document's illustrations land, and the markdown that points at them.
 *
 * Both halves are load-bearing in ways that only show up later: a link that
 * isn't relative breaks the moment the project moves machines, and a filename
 * built straight from a chapter title creates directories nobody asked for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const written: { path: string; bytes: Uint8Array }[] = [];
const dirs: string[] = [];
let existing = new Set<string>();

vi.mock("../fs/fileio", () => ({
  makeDir: vi.fn(async (p: string) => void dirs.push(p)),
  writeBinaryFile: vi.fn(async (path: string, bytes: Uint8Array) => void written.push({ path, bytes })),
  fileExists: vi.fn(async (p: string) => existing.has(p)),
}));

const { saveDocumentAsset, imageMarkdown } = await import("../image/assets");

beforeEach(() => {
  written.length = 0;
  dirs.length = 0;
  existing = new Set();
});

describe("saveDocumentAsset", () => {
  it("files the image beside the document, grouped by document name", async () => {
    const res = await saveDocumentAsset("/proj/writing/vol1/第三章.md", new Uint8Array([1]), "png");
    expect(dirs[0]).toBe("/proj/writing/vol1/assets/第三章");
    expect(res.absPath.startsWith("/proj/writing/vol1/assets/第三章/")).toBe(true);
    expect(written).toHaveLength(1);
  });

  it("returns a path relative to the document, not an absolute one", async () => {
    // An absolute path in the markdown would break the moment the project is
    // opened from another folder or another machine.
    const res = await saveDocumentAsset("/proj/writing/ch1.md", new Uint8Array([1]), "png");
    expect(res.relPath).toMatch(/^assets\/ch1\/img-\d+\.png$/);
    expect(res.relPath.startsWith("/")).toBe(false);
  });

  it("strips characters a filename cannot hold", async () => {
    // "第三章：审判/终局" would otherwise create a nested directory.
    const res = await saveDocumentAsset("/proj/writing/第三章：审判 or 终局.md", new Uint8Array([1]), "png");
    expect(res.relPath).not.toMatch(/[:*?"<>|]/);
    expect(res.relPath.split("/")).toHaveLength(3); // assets / group / file
  });

  it("picks another name rather than overwriting an existing file", async () => {
    const first = await saveDocumentAsset("/proj/writing/ch1.md", new Uint8Array([1]), "png");
    existing.add(first.absPath);
    const second = await saveDocumentAsset("/proj/writing/ch1.md", new Uint8Array([2]), "png");
    expect(second.absPath).not.toBe(first.absPath);
  });
});

describe("imageMarkdown", () => {
  it("stands the image on its own paragraph", () => {
    // Glued to the prose it renders inline mid-sentence, which no
    // illustration wants.
    expect(imageMarkdown("assets/ch1/a.png", "a knight")).toBe("\n\n![a knight](assets/ch1/a.png)\n\n");
  });

  it("percent-encodes each path segment but keeps the separators", () => {
    const md = imageMarkdown("assets/第三章/图 1.png", "x");
    expect(md).toContain("assets/");
    expect(md).not.toContain("图 1.png");
    expect(md).toContain("%20");
  });

  it("drops brackets from the alt text so the link cannot be broken", () => {
    expect(imageMarkdown("assets/a.png", "a [knight]")).toContain("![a knight](");
  });
});
