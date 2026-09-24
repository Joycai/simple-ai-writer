/**
 * projectStore.moveEntry keeps the book spine pointed at a moved path: a
 * rename in the sidebar (or by the agent) must not silently drop a document's
 * library membership, its place or its 在写 mark — and must never fail the
 * move itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}));

// projectStore -> appStore touches `document` at module load; the env is node.
vi.mock("../appStore", () => ({
  useAppStore: { getState: () => ({}) },
  viewNeedsProject: () => false,
}));

vi.mock("../../lib/fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    const v = h.files.get(p);
    if (v === undefined) throw new Error(`no file ${p}`);
    return v;
  }),
  writeFile: vi.fn(async (p: string, c: string) => { h.files.set(p, c); }),
  fileExists: vi.fn(async (p: string) => h.files.has(p) || h.dirs.has(p)),
  makeDir: vi.fn(async () => {}),
  renamePath: vi.fn(async (from: string, to: string) => {
    if (h.dirs.delete(from)) h.dirs.add(to);
  }),
  statPath: vi.fn(async (p: string) => (h.dirs.has(p) ? { isDir: true, size: 0, modifiedMs: null } : { isDir: false, size: 1, modifiedMs: null })),
  copyPath: vi.fn(), removeDir: vi.fn(), removeFile: vi.fn(),
}));
vi.mock("../../lib/image/assets", () => ({
  moveDocumentAssets: vi.fn(async () => {}),
  copyDocumentAssets: vi.fn(), discardDocumentAssets: vi.fn(), relinkAssetGroup: vi.fn(),
}));

import { useProjectStore } from "../projectStore";

const PROJ = "/proj";
const SPINE = `${PROJ}/.ai-writer/outline.json`;

const spineOnDisk = () => JSON.parse(h.files.get(SPINE)!);

describe("projectStore.moveEntry → book spine", () => {
  beforeEach(() => {
    h.files.clear();
    h.dirs.clear();
    useProjectStore.setState({ projectPath: PROJ, fileTree: [], activeFilePath: null, spineRev: 0 });
    // refreshFileTree reads the real directory; nothing to read here.
    useProjectStore.setState({ refreshFileTree: async () => {} });
  });

  it("rewrites a renamed chapter's order, status and membership, and bumps spineRev", async () => {
    h.files.set(SPINE, JSON.stringify({
      version: 1,
      order: { 卷一: ["卷一/a.md", "卷一/b.md"] },
      status: { "卷一/a.md": "writing" },
      members: { folders: [], docs: ["卷一/a.md"], exclude: [] },
    }));
    await useProjectStore.getState().moveEntry(`${PROJ}/卷一/a.md`, `${PROJ}/卷一/甲.md`);
    const s = spineOnDisk();
    expect(s.order["卷一"]).toEqual(["卷一/甲.md", "卷一/b.md"]);
    expect(s.status).toEqual({ "卷一/甲.md": "writing" });
    expect(s.members.docs).toEqual(["卷一/甲.md"]);
    expect(useProjectStore.getState().spineRev).toBe(1);
  });

  it("rewrites a renamed folder member", async () => {
    h.dirs.add(`${PROJ}/卷一`);
    h.files.set(SPINE, JSON.stringify({ version: 1, order: {}, members: { folders: ["卷一"], docs: [], exclude: [] } }));
    await useProjectStore.getState().moveEntry(`${PROJ}/卷一`, `${PROJ}/第一卷`);
    expect(spineOnDisk().members.folders).toEqual(["第一卷"]);
  });

  it("creates no spine when there is none", async () => {
    await useProjectStore.getState().moveEntry(`${PROJ}/a.md`, `${PROJ}/b.md`);
    expect(h.files.has(SPINE)).toBe(false);
    expect(useProjectStore.getState().spineRev).toBe(0);
  });

  it("a spine that fails to write does not fail the move", async () => {
    h.files.set(SPINE, JSON.stringify({ version: 1, order: {} }));
    const { writeFile } = await import("../../lib/fs/fileio");
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("disk full"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(useProjectStore.getState().moveEntry(`${PROJ}/a.md`, `${PROJ}/b.md`)).resolves.toBeUndefined();
    err.mockRestore();
  });
});
