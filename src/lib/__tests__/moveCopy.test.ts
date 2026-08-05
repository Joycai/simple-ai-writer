import { describe, it, expect } from "vitest";
import {
  baseNameOf,
  dropRejection,
  parentDirOf,
  resolveCopyTarget,
} from "../fs/moveCopy";

const WRITING = "/project/writing";

describe("parentDirOf / baseNameOf", () => {
  it("splits on either separator", () => {
    expect(parentDirOf(`${WRITING}/卷一/第1章.md`)).toBe(`${WRITING}/卷一`);
    expect(baseNameOf(`${WRITING}/卷一/第1章.md`)).toBe("第1章.md");
    expect(parentDirOf(String.raw`C:\project\writing\第1章.md`)).toBe(String.raw`C:\project\writing`);
    expect(baseNameOf(String.raw`C:\project\writing\第1章.md`)).toBe("第1章.md");
  });
});

describe("dropRejection", () => {
  it("allows a plain move into another folder", () => {
    expect(dropRejection(`${WRITING}/第1章.md`, `${WRITING}/卷一`, "move")).toBeNull();
    expect(dropRejection(`${WRITING}/卷一`, `${WRITING}/卷二`, "move")).toBeNull();
  });

  it("refuses a folder dropped onto itself or into its own subtree", () => {
    // Both would strand the folder: rename into a child, or copy forever.
    expect(dropRejection(`${WRITING}/卷一`, `${WRITING}/卷一`, "move")).toBe("into-self");
    expect(dropRejection(`${WRITING}/卷一`, `${WRITING}/卷一/子卷`, "move")).toBe("into-self");
    expect(dropRejection(`${WRITING}/卷一`, `${WRITING}/卷一/子卷`, "copy")).toBe("into-self");
  });

  it("does not treat a name-prefixed sibling as a descendant", () => {
    expect(dropRejection(`${WRITING}/卷一`, `${WRITING}/卷一-备份`, "move")).toBeNull();
  });

  it("refuses a move back into the folder the entry already sits in", () => {
    expect(dropRejection(`${WRITING}/卷一/第1章.md`, `${WRITING}/卷一`, "move")).toBe("same-parent");
  });

  it("allows a copy into the entry's own folder — that duplicates it", () => {
    expect(dropRejection(`${WRITING}/卷一/第1章.md`, `${WRITING}/卷一`, "copy")).toBeNull();
  });

  it("compares normalized paths across separator styles", () => {
    expect(dropRejection(String.raw`C:\p\writing\卷一`, "C:/p/writing/卷一", "move")).toBe("into-self");
  });
});

/** `exists` backed by a fixed set of paths. */
const taken = (...paths: string[]) => async (p: string) => paths.includes(p);

describe("resolveCopyTarget", () => {
  it("keeps the name when the destination is free", async () => {
    expect(await resolveCopyTarget(WRITING, "第1章.md", false, taken())).toBe(`${WRITING}/第1章.md`);
  });

  it("numbers before the extension, not after it", async () => {
    expect(await resolveCopyTarget(WRITING, "第1章.md", false, taken(`${WRITING}/第1章.md`)))
      .toBe(`${WRITING}/第1章 (1).md`);
  });

  it("skips numbers already in use", async () => {
    const exists = taken(`${WRITING}/稿.md`, `${WRITING}/稿 (1).md`, `${WRITING}/稿 (2).md`);
    expect(await resolveCopyTarget(WRITING, "稿.md", false, exists)).toBe(`${WRITING}/稿 (3).md`);
  });

  it("replaces an existing (n) suffix instead of stacking one", async () => {
    const exists = taken(`${WRITING}/稿 (1).md`);
    expect(await resolveCopyTarget(WRITING, "稿 (1).md", false, exists)).toBe(`${WRITING}/稿 (2).md`);
  });

  it("treats a dotted folder name as one whole name", async () => {
    const exists = taken(`${WRITING}/v1.2`);
    expect(await resolveCopyTarget(WRITING, "v1.2", true, exists)).toBe(`${WRITING}/v1.2 (1)`);
  });

  it("does not mistake a leading dot for an extension", async () => {
    const exists = taken(`${WRITING}/.keep`);
    expect(await resolveCopyTarget(WRITING, ".keep", false, exists)).toBe(`${WRITING}/.keep (1)`);
  });

  it("gives up rather than looping forever", async () => {
    await expect(resolveCopyTarget(WRITING, "稿.md", false, async () => true)).rejects.toThrow(
      /Too many copies/,
    );
  });
});
