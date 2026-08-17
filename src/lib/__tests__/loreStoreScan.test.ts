/**
 * loreStore.scanProject scheduling.
 *
 * Scans used to run fire-and-parallel, so a burst of lore writes started
 * overlapping full walks and whichever *resolved* last installed its index —
 * not the one that started last. The agent's write tools now await a rescan and
 * fold the result into the run's snapshot, which only works if `await
 * scanProject()` genuinely returns an index at least as fresh as the call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoreIndex } from "../lore";

/** Scans handed out so far, each resolvable by the test whenever it likes. */
interface Pending {
  path: string;
  resolve: (index: LoreIndex) => void;
  reject: (e: Error) => void;
}

const h = vi.hoisted(() => {
  const pending: {
    path: string;
    resolve: (index: unknown) => void;
    reject: (e: Error) => void;
  }[] = [];
  let running = 0;
  let maxConcurrent = 0;
  return {
    pending,
    stats: { get maxConcurrent() { return maxConcurrent; } },
    reset() {
      pending.length = 0;
      running = 0;
      maxConcurrent = 0;
    },
    scanLore: vi.fn((path: string) => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      return new Promise((res, rej) => {
        pending.push({
          path,
          resolve: (index) => { running--; res(index); },
          reject: (e) => { running--; rej(e); },
        });
      });
    }),
  };
});

vi.mock("../lore", () => ({
  scanLore: h.scanLore,
  createEntity: vi.fn(),
  readEntityFile: vi.fn(async () => ""),
  writeEntityFile: vi.fn(async () => {}),
}));
vi.mock("../fs/fileio", () => ({ removeDir: vi.fn() }));

import { useLoreStore } from "../../stores/loreStore";

/** Let queued microtasks run so a scheduled scan actually reaches `scanLore`. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const indexWith = (name: string): LoreIndex => ({
  characters: [{ name } as unknown as LoreIndex["characters"][number]],
});
const nameIn = (index: LoreIndex) => index.characters?.[0]?.name;

const pendingFor = (i: number): Pending => h.pending[i] as unknown as Pending;

describe("loreStore.scanProject scheduling", () => {
  beforeEach(() => {
    h.reset();
    h.scanLore.mockClear();
    useLoreStore.setState({ index: {}, isLoading: false });
  });

  // The store's queue is module state. A scan left unresolved would still be
  // `queued` in the next test, which would silently coalesce onto a promise
  // that never settles — so drain whatever a test left behind.
  afterEach(async () => {
    for (const p of h.pending) p.resolve({});
    await tick();
    for (const p of h.pending) p.resolve({});
    await tick();
  });

  it("never runs two scans at once", async () => {
    const first = useLoreStore.getState().scanProject("/p");
    await tick();                                            // #1 reaches disk
    const second = useLoreStore.getState().scanProject("/p"); // queues behind it
    await tick();

    expect(h.scanLore).toHaveBeenCalledTimes(1); // #2 has not started
    expect(h.stats.maxConcurrent).toBe(1);

    pendingFor(0).resolve(indexWith("first"));
    await first;
    await tick();
    pendingFor(1).resolve(indexWith("second"));
    await second;

    expect(h.stats.maxConcurrent).toBe(1);
  });

  it("installs the last-started scan's result, not the last to resolve", async () => {
    // The old failure mode: scan #1 walks a bigger tree and lands *after* #2,
    // overwriting the newer index with the older one.
    const first = useLoreStore.getState().scanProject("/p");
    await tick();                                    // #1 is now reading disk
    const second = useLoreStore.getState().scanProject("/p"); // queues behind it

    pendingFor(0).resolve(indexWith("stale"));
    await first;
    await tick();
    pendingFor(1).resolve(indexWith("fresh"));
    await second;

    expect(nameIn(useLoreStore.getState().index)).toBe("fresh");
  });

  it("awaiting returns state that reflects a write made before the call", async () => {
    // What syncLore depends on: a caller that wrote to disk and then awaited
    // must not be served a scan that started before its write.
    const first = useLoreStore.getState().scanProject("/p");
    await tick();
    const afterWrite = useLoreStore.getState().scanProject("/p");

    pendingFor(0).resolve(indexWith("before-write"));
    await first;
    await tick();
    pendingFor(1).resolve(indexWith("after-write"));
    await afterWrite;

    expect(nameIn(useLoreStore.getState().index)).toBe("after-write");
  });

  it("coalesces callers that arrive while a scan is still queued", async () => {
    // Three rapid writes must not cost three full walks.
    const all = [
      useLoreStore.getState().scanProject("/p"),
      useLoreStore.getState().scanProject("/p"),
      useLoreStore.getState().scanProject("/p"),
    ];
    await tick();

    expect(h.scanLore).toHaveBeenCalledTimes(1);
    pendingFor(0).resolve(indexWith("once"));
    await Promise.all(all);
    expect(nameIn(useLoreStore.getState().index)).toBe("once");
  });

  it("a failed scan does not wedge the ones behind it", async () => {
    const failing = useLoreStore.getState().scanProject("/p");
    await tick();
    const next = useLoreStore.getState().scanProject("/p");

    pendingFor(0).reject(new Error("disk gone"));
    await expect(failing).rejects.toThrow("disk gone"); // reaches its own caller
    await tick();
    pendingFor(1).resolve(indexWith("recovered"));
    await next;

    expect(nameIn(useLoreStore.getState().index)).toBe("recovered");
  });

  it("does not serve a project switch the previous project's scan", async () => {
    const a = useLoreStore.getState().scanProject("/a");
    const b = useLoreStore.getState().scanProject("/b");

    expect(a).not.toBe(b);
    await tick();
    pendingFor(0).resolve(indexWith("a"));
    await a;
    await tick();
    expect(pendingFor(1).path).toBe("/b");
    pendingFor(1).resolve(indexWith("b"));
    await b;
    expect(nameIn(useLoreStore.getState().index)).toBe("b");
  });

  it("clears isLoading only once the whole queue has drained", async () => {
    const first = useLoreStore.getState().scanProject("/p");
    await tick();
    const second = useLoreStore.getState().scanProject("/p");

    pendingFor(0).resolve(indexWith("first"));
    await first;
    await tick();
    expect(useLoreStore.getState().isLoading).toBe(true); // second still to go

    pendingFor(1).resolve(indexWith("second"));
    await second;
    expect(useLoreStore.getState().isLoading).toBe(false);
  });
});

/**
 * The counting helper the two badges share.
 *
 * `Object.keys(index).length` is the trap it exists to close: `scanLore` seeds
 * an empty array for every category, so counting keys counts categories and
 * never moves. The sidebar shipped that; the rail badge did not.
 */
describe("loreEntityCount", () => {
  it("counts entities, not the categories they sit in", async () => {
    const { loreEntityCount } = await vi.importActual<
      typeof import("../lore/model")
    >("../lore/model");

    const index = {
      characters: [{ name: "Ava" }, { name: "Kael" }],
      world: [{ name: "北境" }],
      factions: [],
      items: [],
    } as unknown as LoreIndex;

    expect(loreEntityCount(index)).toBe(3);
    expect(Object.keys(index).length).toBe(4); // what the sidebar used to show
    expect(loreEntityCount({})).toBe(0);
  });
});
