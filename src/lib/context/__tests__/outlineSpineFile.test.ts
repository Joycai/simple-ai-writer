/**
 * loadSpine's migration: what decides whether an upgraded project keeps its
 * library. An explicit members table — even an empty one — is never
 * re-inferred; a file without one infers from the order once; no file is an
 * empty library.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => h.files.get(p) ?? ""),
  writeFile: vi.fn(async (p: string, c: string) => { h.files.set(p, c); }),
  fileExists: vi.fn(async (p: string) => h.files.has(p)),
  makeDir: vi.fn(async () => {}),
}));

import { loadSpine, moveInSpineOnDisk } from "../outline";

const PROJ = "/p";
const FILE = `${PROJ}/.ai-writer/outline.json`;
const put = (o: unknown) => h.files.set(FILE, JSON.stringify(o));

describe("loadSpine migration", () => {
  beforeEach(() => h.files.clear());

  it("no file → null (an empty library)", async () => {
    expect(await loadSpine(PROJ)).toBeNull();
  });

  it("no members → inferred from the order's non-empty volumes", async () => {
    put({ version: 1, order: { 卷一: ["卷一/a.md"], 空: [] } });
    expect((await loadSpine(PROJ))?.members).toEqual({ folders: ["卷一"], docs: [], exclude: [] });
  });

  it("members: null → inferred", async () => {
    put({ version: 1, order: { 卷一: ["卷一/a.md"] }, members: null });
    expect((await loadSpine(PROJ))?.members?.folders).toEqual(["卷一"]);
  });

  it("an explicit empty table stays empty", async () => {
    put({ version: 1, order: { 卷一: ["卷一/a.md"] }, members: { folders: [], docs: [], exclude: [] } });
    expect((await loadSpine(PROJ))?.members).toEqual({ folders: [], docs: [], exclude: [] });
  });
});

describe("moveInSpineOnDisk", () => {
  beforeEach(() => h.files.clear());

  it("a move the spine doesn't mention writes nothing", async () => {
    put({ version: 1, order: {}, members: { folders: ["卷一"], docs: [], exclude: [] } });
    const before = h.files.get(FILE);
    expect(await moveInSpineOnDisk(PROJ, "图/a.png", "图/b.png", false)).toBe(false);
    expect(h.files.get(FILE)).toBe(before);
  });

  it("a legacy file is not rewritten by an unrelated move", async () => {
    put({ version: 1, order: { 卷一: ["卷一/a.md"] } });
    const before = h.files.get(FILE);
    expect(await moveInSpineOnDisk(PROJ, "图/a.png", "图/b.png", false)).toBe(false);
    expect(h.files.get(FILE)).toBe(before);
  });
});
