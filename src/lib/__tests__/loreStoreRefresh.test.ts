/**
 * loreStore.refreshEntity / refreshEntities — the N-folder re-read the agent's
 * in-place lore writes ask for instead of a full walk.
 *
 * What is pinned: it patches exactly the entries named and never calls
 * `scanLore` on the happy path; it reads them one at a time and installs them
 * in one `set`, so no half-refreshed index is ever rendered; it lives in the
 * same queue as the full scans, so a caller that wrote and then awaited is
 * served an index at least as fresh as its write; and it falls back to the
 * walk whenever patching could be wrong.
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

describe("loreStore.refreshEntities", () => {
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

  it("一次归集改了三条，就读三个文件夹、发一次 set，一次全扫都不发", async () => {
    await scanned(entity("a", "旧"), entity("b", "旧"), entity("c", "旧"));
    const done = useLoreStore.getState().refreshEntities("/p", [address("a"), address("c")]);
    await tick();
    expect(h.scanLore).not.toHaveBeenCalled();
    // 逐个读，不是一次并发几百个 IPC——和全量扫描同一个形状。
    expect(h.reads.map((r) => r.dirPath)).toEqual(["/p/.ai-writer/lore/characters/a"]);
    read(0).resolve(entity("a", "新"));
    await tick();
    // 全部读完才换索引：读到一半的中间态不该被界面看见。
    expect(summaries()).toEqual(["a:旧", "b:旧", "c:旧"]);
    expect(h.reads.map((r) => r.dirPath)).toEqual([
      "/p/.ai-writer/lore/characters/a",
      "/p/.ai-writer/lore/characters/c",
    ]);
    read(1).resolve(entity("c", "新"));
    await done;
    expect(summaries()).toEqual(["a:新", "b:旧", "c:新"]);
    expect(h.scanLore).not.toHaveBeenCalled();
  });

  it("同一条列两次只读一遍", async () => {
    await scanned(entity("a", "旧"));
    const done = useLoreStore.getState().refreshEntities("/p", [address("a"), address("a")]);
    await tick();
    expect(h.reads).toHaveLength(1);
    read(0).resolve(entity("a", "新"));
    await done;
    expect(summaries()).toEqual(["a:新"]);
  });

  it("空名单什么都不做——删一个没有成员的集合不该换来一次扫描", async () => {
    await scanned(entity("a", "旧"));
    await useLoreStore.getState().refreshEntities("/p", []);
    expect(h.scanLore).not.toHaveBeenCalled();
    expect(h.scanEntity).not.toHaveBeenCalled();
  });

  it("名单里有一条不在索引里，就退回全量扫描", async () => {
    await scanned(entity("a", "旧"));
    const done = useLoreStore.getState().refreshEntities("/p", [address("a"), address("ghost")]);
    await tick();
    read(0).resolve(entity("a", "新"));
    await tick();
    read(1).resolve(entity("ghost", "新"));
    await tick();
    expect(h.scanLore).toHaveBeenCalledWith("/p");
    scan(0).resolve(indexOf(entity("a", "盘上"), entity("ghost", "盘上")));
    await done;
    expect(summaries()).toEqual(["a:盘上", "ghost:盘上"]);
  });

  it("索引描述的是另一个项目时也退回全量扫描", async () => {
    await scanned(entity("a", "旧"));
    const done = useLoreStore.getState().refreshEntities("/other", [address("a")]);
    await tick();
    expect(h.scanEntity).not.toHaveBeenCalled();
    expect(h.scanLore).toHaveBeenCalledWith("/other");
    scan(0).resolve(indexOf(entity("z", "别的项目")));
    await done;
    expect(summaries()).toEqual(["z:别的项目"]);
  });
});
