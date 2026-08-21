/**
 * `runSync` — what a run does to the snapshot.
 *
 * The snapshot is the third leg of the three-way compare, so what lands in it
 * decides whether the *next* plan is honest. Two rules are worth pinning down
 * with a test because getting either wrong is invisible until a later sync
 * quietly mislabels an entry:
 *
 * 1. entries both sides already agree on are recorded as synced, even though
 *    nothing was transferred for them, and
 * 2. entries the author skipped are not — they really are out of sync.
 *
 * The filesystem and the server are mocked down to the seams `run.ts` uses;
 * this is about bookkeeping, not about zip files.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const written: string[] = [];
vi.mock("../fs/fileio", () => ({
  fileExists: async () => false,
  makeDir: async () => {},
  readBinaryFile: async () => new Uint8Array([1, 2, 3]),
  removeDir: async () => {},
  removeFile: async () => {},
  renamePath: async () => {},
  writeBinaryFile: async () => {},
}));

vi.mock("../sync/local", () => ({
  loreRoot: (p: string) => `${p}/.ai-writer/lore`,
  entryDir: (p: string, path: string) => `${p}/.ai-writer/lore/${path}`,
  hashEntryDir: async () => "unused",
  zipEntry: async () => 1,
  unzipEntry: async () => 1,
}));

const { runSync } = await import("../sync/run");
const { planSync, withDecisions } = await import("../sync/plan");
import type { SyncBinding } from "../sync/model";
import type { SyncClient } from "../sync/client";

const A = "a".repeat(64);
const B = "b".repeat(64);

const client = {
  listKbs: async () => [],
  createKb: async () => ({ id: "k", name: "k" }) as never,
  manifest: async () => ({}) as never,
  downloadEntry: async () => ({ bytes: new Uint8Array(), hash: A }),
  uploadEntry: async (_kb: string, path: string) => void written.push(`put ${path}`),
  deleteEntry: async (_kb: string, path: string) => void written.push(`del ${path}`),
} satisfies SyncClient;

function binding(snapshot: Record<string, string>): SyncBinding {
  return { serverUrl: "http://box:8787", kbId: "k", kbName: "k", snapshot, lastSyncAt: null };
}

beforeEach(() => void (written.length = 0));

describe("runSync — snapshot bookkeeping", () => {
  it("records entries that were already identical on both sides", async () => {
    // Nothing is transferred for `a/same`, but it IS in sync. Leaving it out of
    // the snapshot is what would make a later one-sided edit read as "both
    // sides changed" — a conflict warning on the author's own work.
    const plan = planSync({
      local: { "a/same": A, "a/new": B },
      remote: { "a/same": A },
      snapshot: {},
      direction: "push",
    });
    const result = await runSync({ projectPath: "/p", binding: binding({}), client, plan });

    expect(written).toEqual(["put a/new"]);
    expect(result.succeeded).toEqual(["a/new"]); // the count the author is shown
    expect(result.binding.snapshot).toEqual({ "a/same": A, "a/new": B });
  });

  it("drops entries that are gone from both sides", async () => {
    const plan = planSync({ local: {}, remote: {}, snapshot: { "a/gone": A }, direction: "push" });
    const result = await runSync({ projectPath: "/p", binding: binding({ "a/gone": A }), client, plan });
    expect(result.binding.snapshot).toEqual({});
  });

  it("never runs or records a skipped step", async () => {
    // The author keeps a remote-only entry instead of mirroring it away. The
    // two sides genuinely still differ afterwards, so the snapshot must keep
    // saying so — recording it here would make the next plan report "no
    // change" for an entry that is only on one side.
    const planned = planSync({
      local: { "a/mine": A },
      remote: { "a/theirs": B },
      snapshot: {},
      direction: "push",
    });
    const plan = withDecisions(planned, ["a/theirs"], "skip");
    const result = await runSync({ projectPath: "/p", binding: binding({}), client, plan });

    expect(written).toEqual(["put a/mine"]);
    expect(result.binding.snapshot).toEqual({ "a/mine": A });
    expect(result.failures).toEqual([]);
    // A skipped step is not a failure, so the run still counts as complete.
    expect(result.binding.lastSyncAt).not.toBeNull();
  });

  it("leaves a skipped entry's previous snapshot value alone", async () => {
    const planned = planSync({
      local: { "a/x": B },
      remote: { "a/x": A },
      snapshot: { "a/x": A },
      direction: "push",
    });
    const plan = withDecisions(planned, ["a/x"], "skip");
    const result = await runSync({ projectPath: "/p", binding: binding({ "a/x": A }), client, plan });

    expect(written).toEqual([]);
    expect(result.binding.snapshot).toEqual({ "a/x": A });
  });
});
