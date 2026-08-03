/**
 * project.ts's getDb — keyed per-project-path cache (Phase 5 fix).
 *
 * The cache used to be a single unkeyed `_db` slot: resetDb() then
 * getDb(newPath) raced against any still-in-flight getDb(oldPath) from
 * whatever the previous project's call site was doing, and the older load
 * resolving later would silently overwrite the cache with the wrong
 * project's handle — every caller trusted whatever came back without
 * rechecking the path. Keying by path means a stale load for oldPath can
 * never land in newPath's slot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  load: vi.fn(async (path: string) => ({
    path,
    execute: vi.fn(async () => {}),
  })),
}));

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: h.load },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { getDb, resetDb } from "../project";

beforeEach(() => {
  h.load.mockClear();
  resetDb();
});

describe("getDb", () => {
  it("caches per project path — a second call for the same path reuses the handle", async () => {
    const a1 = await getDb("/proj-a");
    const a2 = await getDb("/proj-a");

    expect(a1).toBe(a2);
    expect(h.load).toHaveBeenCalledTimes(1);
  });

  it("loads a distinct handle per project path", async () => {
    const a = await getDb("/proj-a");
    const b = await getDb("/proj-b");

    expect(a).not.toBe(b);
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it("a slow load for an old path can't clobber a newer path's cached handle", async () => {
    let resolveOld: (db: Awaited<ReturnType<typeof h.load>>) => void;
    const oldLoad = new Promise<Awaited<ReturnType<typeof h.load>>>((res) => {
      resolveOld = res;
    });
    h.load.mockImplementationOnce(() => oldLoad); // getDb("/old") hangs

    const oldPromise = getDb("/old"); // in flight, not yet resolved
    resetDb(); // openProject switching away, as it does before loading the new path
    const newDb = await getDb("/new"); // resolves first

    // The stale /old load finally resolves — it must not overwrite /new's slot.
    resolveOld!({ path: "/old", execute: vi.fn(async () => {}) });
    await oldPromise;

    const newDbAgain = await getDb("/new");
    expect(newDbAgain).toBe(newDb);
  });

  it("does not cache a rejected load — the next call retries", async () => {
    h.load.mockRejectedValueOnce(new Error("connection refused"));

    await expect(getDb("/proj-a")).rejects.toThrow("connection refused");
    expect(h.load).toHaveBeenCalledTimes(1);

    const db = await getDb("/proj-a");
    expect(db).toBeTruthy();
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it("resetDb clears every cached path", async () => {
    await getDb("/proj-a");
    await getDb("/proj-b");
    resetDb();

    await getDb("/proj-a");
    expect(h.load).toHaveBeenCalledTimes(3);
  });
});
