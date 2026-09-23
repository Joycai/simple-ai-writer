import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  dirs: [] as { name: string; path: string; isDirectory: boolean; mtimeMs: number | null }[],
  removed: [] as string[],
}));
vi.mock("../../fs/fileio", () => ({
  fileExists: vi.fn(async (p: string) =>
    fs.files.has(p) || p.endsWith("/tmp/chat") || fs.dirs.some((d) => d.path === p)),
  writeBinaryFile: vi.fn(async (p: string, data: Uint8Array) => { fs.files.set(p, data); }),
  readDir: vi.fn(async () => fs.dirs.map(({ name, path, isDirectory }) => ({ name, path, isDirectory }))),
  statPath: vi.fn(async (p: string) => {
    const d = fs.dirs.find((x) => x.path === p);
    return d ? { isDir: true, size: 0, modifiedMs: d.mtimeMs } : null;
  }),
  removeDir: vi.fn(async (p: string) => { fs.removed.push(p); }),
}));

import {
  chatStashDir, pastedImagePath, removeChatStash, resetChatStashSweepForTests, STASH_GRACE_MS,
  stashSweepPlan, sweepChatStash, writePastedImage,
} from "../chatStash";
import { writeBinaryFile } from "../../fs/fileio";

const NOW = 1_800_000_000_000;
const ROOT = "/p/.ai-writer/tmp/chat";
const dir = (name: string, ageMs: number | null) =>
  ({ name, path: `${ROOT}/${name}`, isDirectory: true, mtimeMs: ageMs === null ? null : NOW - ageMs });

beforeEach(() => {
  fs.files.clear();
  fs.dirs = [];
  fs.removed = [];
  resetChatStashSweepForTests();
  vi.clearAllMocks();
});

describe("stashSweepPlan", () => {
  const old = NOW - STASH_GRACE_MS - 1;
  it("removes only unclaimed directories past the grace period", () => {
    const plan = stashSweepPlan(
      [
        { id: "live", mtimeMs: old },
        { id: "orphan", mtimeMs: old },
        { id: "fresh-orphan", mtimeMs: NOW - 60_000 },
      ],
      new Set(["live"]),
      NOW,
    );
    // A live session keeps its pictures whatever their age; an orphan inside
    // the grace period may be another window's unsent paste.
    expect(plan).toEqual(["orphan"]);
  });

  it("keeps a directory whose age is unknown", () => {
    expect(stashSweepPlan([{ id: "x", mtimeMs: null }], new Set(), NOW)).toEqual([]);
  });
});

describe("writePastedImage", () => {
  it("names the file by content, so a second paste is the same file", async () => {
    const bytes = new TextEncoder().encode("same picture");
    const first = await pastedImagePath("/p", "s1", bytes, "png");
    const second = await pastedImagePath("/p", "s1", bytes, "png");
    expect(first).toBe(second);
    expect(first).toMatch(/^\/p\/\.ai-writer\/tmp\/chat\/s1\/[0-9a-f]{12}\.png$/);
    expect(await pastedImagePath("/p", "s1", new TextEncoder().encode("other"), "png")).not.toBe(first);
    await writePastedImage(first, bytes);
    await writePastedImage(second, bytes);
    // Written once: the second paste found the file already there.
    expect(writeBinaryFile).toHaveBeenCalledTimes(1);
  });
});

describe("sweepChatStash", () => {
  it("removes orphans past the grace period, once per project per launch", async () => {
    fs.dirs = [dir("live", STASH_GRACE_MS * 3), dir("gone", STASH_GRACE_MS * 3), dir("new", 1000)];
    await sweepChatStash("/p", new Set(["live"]), NOW);
    expect(fs.removed).toEqual([`${ROOT}/gone`]);

    // Second call in the same launch: the contract is one sweep.
    await sweepChatStash("/p", new Set(), NOW);
    expect(fs.removed).toEqual([`${ROOT}/gone`]);
  });

  it("never lets a hand-edited id reach outside the scratch root", async () => {
    fs.dirs = [{ ...dir("..", STASH_GRACE_MS * 3) }];
    await sweepChatStash("/p", new Set(), NOW);
    expect(fs.removed).toEqual([]);
  });
});

describe("removeChatStash", () => {
  it("removes a deleted session's directory without waiting", async () => {
    fs.dirs = [dir("s1", 1000)];
    await removeChatStash("/p", "s1");
    expect(fs.removed).toEqual([chatStashDir("/p", "s1")]);
  });

  it("does nothing for a session that never pasted, or an id that escapes", async () => {
    await removeChatStash("/p", null);
    fs.dirs = [dir("..", 1000)];
    await removeChatStash("/p", "..");
    expect(fs.removed).toEqual([]);
  });
});
