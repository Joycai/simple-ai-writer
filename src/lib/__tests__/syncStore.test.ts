import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked before the import so `store.ts` binds to these. sync.json is read on
// the project-open path, so what matters most here is that a damaged file
// degrades rather than throws.
const files = new Map<string, string>();
vi.mock("../fs/fileio", () => ({
  fileExists: async (p: string) => files.has(p),
  readFile: async (p: string) => {
    const v = files.get(p);
    if (v == null) throw new Error(`no such file: ${p}`);
    return v;
  },
  writeFile: async (p: string, c: string) => void files.set(p, c),
  makeDir: async () => {},
  removeFile: async (p: string) => {
    if (!files.delete(p)) throw new Error("not found");
  },
}));

const { loadBinding, saveBinding, clearBinding, advanceSnapshot } = await import("../sync/store");

const PROJECT = "/tmp/proj";
const FILE = "/tmp/proj/.ai-writer/sync.json";
const A = "a".repeat(64);
const B = "b".repeat(64);

beforeEach(() => files.clear());

describe("loadBinding", () => {
  it("returns null for an unbound project", async () => {
    expect(await loadBinding(PROJECT)).toBeNull();
  });

  it("round-trips a binding", async () => {
    await saveBinding(PROJECT, {
      serverUrl: "http://box:8787",
      kbId: "wuxia",
      kbName: "我的武侠世界",
      snapshot: { "characters/爱丽丝": A },
      lastSyncAt: "2026-08-20T00:00:00.000Z",
    });
    expect(await loadBinding(PROJECT)).toEqual({
      serverUrl: "http://box:8787",
      kbId: "wuxia",
      kbName: "我的武侠世界",
      snapshot: { "characters/爱丽丝": A },
      lastSyncAt: "2026-08-20T00:00:00.000Z",
    });
  });

  it("normalises the server url on both sides", async () => {
    // `http://box:8787/` and `http://box:8787` are one server; if they were
    // stored differently, the binding check and the keyring account would stop
    // agreeing with each other.
    await saveBinding(PROJECT, {
      serverUrl: "  http://box:8787///  ",
      kbId: "k",
      kbName: "k",
      snapshot: {},
      lastSyncAt: null,
    });
    expect((await loadBinding(PROJECT))?.serverUrl).toBe("http://box:8787");
  });

  it("degrades to unbound instead of throwing", async () => {
    for (const bad of ["", "{", "null", "[]", '"a string"', "{}", '{"kbId":"k"}', '{"serverUrl":"  "}']) {
      files.set(FILE, bad);
      expect(await loadBinding(PROJECT), `for ${bad}`).toBeNull();
    }
  });

  it("keeps the usable half of a damaged snapshot", async () => {
    // Every surviving entry still gets a real three-way answer; the rest
    // degrade to "conflict", which is the safe direction to be wrong in.
    files.set(
      FILE,
      JSON.stringify({
        serverUrl: "http://box:8787",
        kbId: "k",
        snapshot: { "a/good": A, "a/number": 7, "a/null": null, "": A, "a/empty": "" },
      }),
    );
    const binding = await loadBinding(PROJECT);
    expect(binding?.snapshot).toEqual({ "a/good": A });
    // A missing kbName falls back to the id rather than rendering as undefined.
    expect(binding?.kbName).toBe("k");
    expect(binding?.lastSyncAt).toBeNull();
  });

  it("clears without complaining about an already-absent file", async () => {
    await expect(clearBinding(PROJECT)).resolves.toBeUndefined();
  });
});

describe("advanceSnapshot", () => {
  it("records what landed and forgets what was deleted", () => {
    const previous = { "a/kept": A, "a/updated": A, "a/removed": A };
    const next = advanceSnapshot(previous, { "a/updated": B }, ["a/updated", "a/removed"]);
    expect(next).toEqual({ "a/kept": A, "a/updated": B });
  });

  it("leaves failed steps at their old value so a retry re-plans them", () => {
    // The point of advancing per entry: a partial sync must not make the
    // entries that failed look synced, nor the ones that succeeded look stale.
    const previous = { "a/ok": A, "a/failed": A };
    const next = advanceSnapshot(previous, { "a/ok": B, "a/failed": B }, ["a/ok"]);
    expect(next).toEqual({ "a/ok": B, "a/failed": A });
  });

  it("does not mutate the snapshot it was given", () => {
    const previous = { "a/x": A };
    advanceSnapshot(previous, { "a/x": B }, ["a/x"]);
    expect(previous).toEqual({ "a/x": A });
  });
});
