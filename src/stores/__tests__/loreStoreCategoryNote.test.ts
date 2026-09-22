/**
 * loreStore.categoryNotes — the wall's cache of category-note summaries
 * (docs/feature/lore/folder-note-plan.md §5.2, 设计稿 01b TURN 2 屏 2e-2).
 *
 * What is pinned: a category is read from disk once per session and served
 * from the cache after that; "no note" is cached too (as null), so a category
 * without one does not cost a disk read per chip click; `categoryNoteWritten`
 * evicts exactly the one written, so the next filter re-reads it; and a
 * project switch drops the whole cache while a rescan of the same project
 * keeps it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoreIndex } from "../../lib/lore";

const h = vi.hoisted(() => ({
  notes: {} as Record<string, string>,
  reads: [] as string[][],
  scanLore: vi.fn(async () => ({}) as LoreIndex),
}));

vi.mock("../../lib/lore", () => ({
  scanLore: h.scanLore,
  createEntity: vi.fn(),
  readEntityFile: vi.fn(async () => ""),
  writeEntityFile: vi.fn(async () => {}),
  parseDetailMode: () => "read",
  LORE_DETAIL_MODE_PREF: "app:loreDetailMode",
  parseScopePref: () => null,
  serializeScope: () => null,
  concreteScopeCollections: () => [],
}));
vi.mock("../../lib/lore/categoryNote", () => ({
  readCategoryNotes: vi.fn(async (_p: string, ids: readonly string[]) => {
    h.reads.push([...ids]);
    const out: Record<string, string> = {};
    for (const id of ids) if (h.notes[id]) out[id] = h.notes[id];
    return out;
  }),
}));
vi.mock("../../lib/fs/fileio", () => ({ removeDir: vi.fn() }));

import { useLoreStore } from "../loreStore";

beforeEach(() => {
  h.notes = { characters: "有名字、会推动剧情的人。" };
  h.reads.length = 0;
  useLoreStore.setState({ categoryNotes: {} });
});
afterEach(() => vi.clearAllMocks());

describe("loreStore.loadCategoryNote", () => {
  it("reads a category once and serves the cache after that", async () => {
    const { loadCategoryNote } = useLoreStore.getState();
    await loadCategoryNote("/p", "characters");
    await loadCategoryNote("/p", "characters");
    expect(useLoreStore.getState().categoryNotes).toEqual({ characters: "有名字、会推动剧情的人。" });
    expect(h.reads).toEqual([["characters"]]);
  });

  it("caches the absence of a note as null, so a category without one is not re-read", async () => {
    const { loadCategoryNote } = useLoreStore.getState();
    await loadCategoryNote("/p", "world");
    await loadCategoryNote("/p", "world");
    expect(useLoreStore.getState().categoryNotes).toEqual({ world: null });
    expect(h.reads).toHaveLength(1);
  });

  it("does nothing without a project", async () => {
    await useLoreStore.getState().loadCategoryNote("", "characters");
    expect(h.reads).toHaveLength(0);
  });
});

describe("loreStore.categoryNoteWritten", () => {
  it("evicts only the category written; the next load re-reads it", async () => {
    const { loadCategoryNote, categoryNoteWritten } = useLoreStore.getState();
    await loadCategoryNote("/p", "characters");
    await loadCategoryNote("/p", "world");
    categoryNoteWritten("world");
    expect(useLoreStore.getState().categoryNotes).toEqual({ characters: "有名字、会推动剧情的人。" });

    h.notes.world = "地名与势力。";
    await loadCategoryNote("/p", "world");
    expect(useLoreStore.getState().categoryNotes.world).toBe("地名与势力。");
    expect(h.reads).toEqual([["characters"], ["world"], ["world"]]);
  });
});

describe("with the scan", () => {
  it("a project switch drops the cache; a rescan of the same project keeps it", async () => {
    const { scanProject, loadCategoryNote } = useLoreStore.getState();
    await scanProject("/p");
    await loadCategoryNote("/p", "characters");
    await scanProject("/p");
    expect(useLoreStore.getState().categoryNotes).toEqual({ characters: "有名字、会推动剧情的人。" });
    await scanProject("/q");
    expect(useLoreStore.getState().categoryNotes).toEqual({});
  });

  it("a read that lands after the project switched is discarded", async () => {
    const { scanProject, loadCategoryNote } = useLoreStore.getState();
    await scanProject("/p");
    const pending = loadCategoryNote("/p", "characters");
    await scanProject("/q");
    await pending;
    expect(useLoreStore.getState().categoryNotes).toEqual({});
  });
});
