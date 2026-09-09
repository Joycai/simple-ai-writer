/**
 * loreStore.refreshEntity — the one-folder re-read the agent's in-place lore
 * writes ask for instead of a full walk.
 *
 * What is pinned: it patches exactly one entry and never calls `scanLore` on
 * the happy path; it lives in the same queue as the full scans, so a caller
 * that wrote and then awaited is served an index at least as fresh as its
 * write; and it falls back to the walk whenever patching could be wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoreEntity, LoreIndex } from "../lore";

interface Pending<T> { resolve: (v: T) => void; reject: (e: Error) => void }

const h = vi.hoisted(() => {
  const scans: { path: string; resolve: (index: unknown) => void; reject: (e: Error) => void }[] = [];
  const reads: { dirPath: string; resolve: (entity: unknown) => void; reject: (e: Error) => void }[] = [];
  return {
    scans,
    reads,
    reset() { scans.length = 0; reads.length = 0; },
    scanLore: vi.fn((path: string) =>
      new Promise((resolve, reject) => { scans.push({ path, resolve, reject }); })),
    scanEntity: vi.fn((_category: string, _id: string, dirPath: string) =>
      new Promise((resolve, reject) => { reads.push({ dirPath, resolve, reject }); })),
  };
});

vi.mock("../lore", () => ({
  scanLore: h.scanLore,
  scanEntity: h.scanEntity,
  createEntity: vi.fn(),
  readEntityFile: vi.fn(async () => ""),
  writeEntityFile: vi.fn(async () => {}),
  parseDetailMode: () => "read",
  LORE_DETAIL_MODE_PREF: "app:loreDetailMode",
  parseScopePref: () => null,
  serializeScope: () => null,
  concreteScopeCollections: () => [],
}));
vi.mock("../fs/fileio", () => ({ removeDir: vi.fn() }));

import { useLoreStore } from "../../stores/loreStore";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const entity = (id: string, summary: string): LoreEntity =>
  ({ id, category: "characters", dirPath: `/p/.ai-writer/lore/characters/${id}`, name: id, summary }) as LoreEntity;
const indexOf = (...entities: LoreEntity[]): LoreIndex => ({ characters: entities });
const summaries = () =>
  (useLoreStore.getState().index.characters ?? []).map((e) => `${e.id}:${e.summary}`);

const scan = (i: number) => h.scans[i] as unknown as Pending<LoreIndex>;
const read = (i: number) => h.reads[i] as unknown as Pending<LoreEntity>;
const address = (id: string) => ({ category: "characters", id, dirPath: `/p/.ai-writer/lore/characters/${id}` });

/** Put the store in the state every in-place write starts from: `/p` scanned. */
async function scanned(...entities: LoreEntity[]): Promise<void> {
  const first = useLoreStore.getState().scanProject("/p");
  await tick();
  scan(0).resolve(indexOf(...entities));
  await first;
  h.scanLore.mockClear();
  h.reset();
}

describe("loreStore.refreshEntity", () => {
  beforeEach(() => {
    h.reset();
    h.scanLore.mockClear();
    h.scanEntity.mockClear();
    useLoreStore.setState({ index: {}, isLoading: false });
  });

  afterEach(async () => {
    for (const p of h.scans) p.resolve({});
    for (const p of h.reads) p.resolve(entity("x", ""));
    await tick();
    for (const p of h.scans) p.resolve({});
    for (const p of h.reads) p.resolve(entity("x", ""));
    await tick();
  });

  it("re-reads one folder and swaps that entry in, without a walk", async () => {
    await scanned(entity("ava", "old"), entity("kael", "rival"));

    const done = useLoreStore.getState().refreshEntity("/p", address("ava"));
    await tick();
    expect(h.scanEntity).toHaveBeenCalledWith("characters", "ava", address("ava").dirPath);
    read(0).resolve(entity("ava", "new"));
    await done;

    expect(summaries()).toEqual(["ava:new", "kael:rival"]);
    expect(h.scanLore).not.toHaveBeenCalled();
    expect(useLoreStore.getState().isLoading).toBe(false);
  });

  it("shares a full scan that is queued but not yet reading disk", async () => {
    await scanned(entity("ava", "old"));
    const running = useLoreStore.getState().scanProject("/p");
    await tick();                                              // #1 is on disk
    const queued = useLoreStore.getState().scanProject("/p");  // #2 waits
    const refresh = useLoreStore.getState().refreshEntity("/p", address("ava"));

    expect(refresh).toBe(queued);
    scan(0).resolve(indexOf(entity("ava", "stale")));
    await running;
    await tick();
    scan(1).resolve(indexOf(entity("ava", "walked")));
    await Promise.all([queued, refresh]);

    expect(h.scanEntity).not.toHaveBeenCalled();
    expect(summaries()).toEqual(["ava:walked"]);
  });

  it("lands after a scan that was already reading disk when the write happened", async () => {
    // The old failure mode, in miniature: a walk that started before the
    // write finishes after it and must not reinstate the pre-write entry.
    await scanned(entity("ava", "old"));
    const running = useLoreStore.getState().scanProject("/p");
    await tick();
    const refresh = useLoreStore.getState().refreshEntity("/p", address("ava"));
    await tick();
    expect(h.scanEntity).not.toHaveBeenCalled();               // still behind #1

    scan(0).resolve(indexOf(entity("ava", "pre-write")));
    await running;
    await tick();
    read(0).resolve(entity("ava", "post-write"));
    await refresh;

    expect(summaries()).toEqual(["ava:post-write"]);
  });

  it("falls back to a walk when the entry is not where the caller says", async () => {
    await scanned(entity("kael", "rival"));
    const refresh = useLoreStore.getState().refreshEntity("/p", address("ava"));
    await tick();
    read(0).resolve(entity("ava", "orphaned"));
    await tick();

    expect(h.scanLore).toHaveBeenCalledWith("/p");
    expect(useLoreStore.getState().isLoading).toBe(true);
    scan(0).resolve(indexOf(entity("kael", "rival"), entity("ava", "found by walk")));
    await refresh;
    expect(summaries()).toEqual(["kael:rival", "ava:found by walk"]);
    expect(useLoreStore.getState().isLoading).toBe(false);
  });

  it("falls back to a walk when the installed index is another project's", async () => {
    await scanned(entity("ava", "old"));
    const refresh = useLoreStore.getState().refreshEntity("/q", address("ava"));
    await tick();

    expect(h.scanEntity).not.toHaveBeenCalled();
    expect(h.scanLore).toHaveBeenCalledWith("/q");
    scan(0).resolve({ characters: [] });
    await refresh;
    expect(summaries()).toEqual([]);
  });

  it("a failed re-read does not wedge the scans behind it", async () => {
    await scanned(entity("ava", "old"));
    const refresh = useLoreStore.getState().refreshEntity("/p", address("ava"));
    await tick();
    const next = useLoreStore.getState().scanProject("/p");

    read(0).reject(new Error("disk gone"));
    await expect(refresh).rejects.toThrow("disk gone");
    await tick();
    scan(0).resolve(indexOf(entity("ava", "recovered")));
    await next;
    expect(summaries()).toEqual(["ava:recovered"]);
  });
});
