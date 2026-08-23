/**
 * writeTaskNote under concurrency — a round's delegations now run in parallel
 * (agent/runtime), so two notes sharing a slug can land at the same moment.
 * The slug probe is check-then-write; without the shared write chain both
 * writers see the base name free and the second silently overwrites the first.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above this file's own statements, so the
// in-memory fs they close over must be hoisted with them.
const { store, tick } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  /** A beat of real async, so the probe and the write can actually interleave. */
  tick: () => new Promise<void>((r) => setTimeout(r, 1)),
}));

vi.mock("../fs/fileio", () => ({
  fileExists: vi.fn(async (p: string) => {
    await tick();
    return store.has(p);
  }),
  writeFile: vi.fn(async (p: string, c: string) => {
    await tick();
    store.set(p, c);
  }),
  readFile: vi.fn(async (p: string) => store.get(p) ?? ""),
  makeDir: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
  removeDir: vi.fn(async () => {}),
}));
vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));

import { writeTaskNote } from "../agent/taskWorkspace";

beforeEach(() => store.clear());

describe("writeTaskNote concurrency", () => {
  it("gives two concurrent same-slug notes two files, not one", async () => {
    const [a, b] = await Promise.all([
      writeTaskNote("/p", "t1", { slug: "search-abc", title: "A", content: "one" }),
      writeTaskNote("/p", "t1", { slug: "search-abc", title: "B", content: "two" }),
    ]);

    expect(new Set([a.slug, b.slug]).size).toBe(2);
    const bodies = [...store.values()].join("\n---\n");
    expect(bodies).toContain("one");
    expect(bodies).toContain("two");
    // The loser of the race was renamed, and told so.
    const renamed = [a, b].find((h) => h.renamedFrom);
    expect(renamed?.renamedFrom).toBe("search-abc");
  });

  it("still writes a lone note under its own name", async () => {
    const note = await writeTaskNote("/p", "t1", { slug: "vision-x", title: "V", content: "seen" });
    expect(note.slug).toBe("vision-x");
    expect(note.renamedFrom).toBeUndefined();
  });
});
