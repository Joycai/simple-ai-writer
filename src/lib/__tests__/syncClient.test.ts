import { describe, it, expect, vi, beforeEach } from "vitest";

// `lib/http` is the Tauri fetch inside the app; stubbing the module keeps these
// tests about the protocol this client speaks, not about transport.
const calls: { url: string; init: RequestInit }[] = [];
let respond: (url: string, init: RequestInit) => Response;

vi.mock("../http", () => ({
  fetch: async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return respond(url, init);
  },
  isLocalUrl: () => true,
}));

const { createSyncClient, SyncConflictError, SyncHttpError, manifestHashes } = await import(
  "../sync/client"
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const client = () => createSyncClient("http://box:8787/", "tok");
const header = (name: string) => new Headers(calls[0].init.headers).get(name);

beforeEach(() => {
  calls.length = 0;
  respond = () => json({});
});

describe("addressing", () => {
  it("trims the server url and authenticates every call", async () => {
    respond = () => json([]);
    await client().listKbs();
    expect(calls[0].url).toBe("http://box:8787/v1/kbs");
    expect(header("Authorization")).toBe("Bearer tok");
  });

  it("percent-encodes each path segment but not the separator", async () => {
    // Entry ids are routinely CJK and may contain '#' or '%'; encoding the
    // whole path would escape the '/' that separates category from id.
    respond = () => new Response(new Uint8Array([1]), { status: 200 });
    await client().downloadEntry("kb", "characters/爱丽丝 #2");
    expect(calls[0].url).toBe(
      "http://box:8787/v1/kbs/kb/entries/characters/%E7%88%B1%E4%B8%BD%E4%B8%9D%20%232",
    );
  });
});

describe("preconditions", () => {
  it("sends If-None-Match for a create and If-Match for a replace", async () => {
    respond = () => new Response(null, { status: 201 });
    await client().uploadEntry("kb", "a/x", "h".repeat(64), new Uint8Array([1]), { kind: "absent" });
    expect(header("If-None-Match")).toBe("*");

    calls.length = 0;
    respond = () => new Response(null, { status: 204 });
    await client().uploadEntry("kb", "a/x", "h".repeat(64), new Uint8Array([1]), {
      kind: "hash",
      hash: "old",
    });
    expect(header("If-Match")).toBe('"old"');
    expect(header("X-Entry-Hash")).toBe("h".repeat(64));
  });

  it("stamps writes with the machine name, and reads without it", async () => {
    // The label is decoration the server shows back in its kb list; a read has
    // no writer, so it carries no claim about one.
    const named = createSyncClient("http://box:8787", "tok", " MacBook-Pro ");
    respond = () => new Response(null, { status: 201 });
    await named.uploadEntry("kb", "a/x", "h", new Uint8Array([1]), { kind: "absent" });
    expect(header("X-Source-Device")).toBe("MacBook-Pro");

    calls.length = 0;
    respond = () => new Response(null, { status: 204 });
    await named.deleteEntry("kb", "a/x", { kind: "any" });
    expect(header("X-Source-Device")).toBe("MacBook-Pro");

    calls.length = 0;
    respond = () => new Response(new Uint8Array([1]), { status: 200 });
    await named.downloadEntry("kb", "a/x");
    expect(header("X-Source-Device")).toBeNull();
  });

  it("omits the header entirely when the machine has no name", async () => {
    respond = () => new Response(null, { status: 201 });
    await client().uploadEntry("kb", "a/x", "h", new Uint8Array([1]), { kind: "absent" });
    expect(header("X-Source-Device")).toBeNull();
  });

  it("sends no condition when the caller opted out", async () => {
    respond = () => new Response(null, { status: 204 });
    await client().uploadEntry("kb", "a/x", "h", new Uint8Array([1]), { kind: "any" });
    expect(header("If-Match")).toBeNull();
    expect(header("If-None-Match")).toBeNull();
  });

  it("turns a 412 into a conflict carrying the server's current hash", async () => {
    // The one error a caller can act on alone: re-fetch the manifest, re-plan.
    respond = () => json({ code: "precondition_failed", message: "moved", currentHash: "abc" }, 412);
    const err = await client()
      .uploadEntry("kb", "a/x", "h", new Uint8Array([1]), { kind: "hash", hash: "old" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SyncConflictError);
    expect(err.currentHash).toBe("abc");
    expect(err.path).toBe("a/x");
  });

  it("reports a 412 whose body says the entry is gone as a null hash", async () => {
    respond = () => json({ code: "precondition_failed", message: "gone", currentHash: null }, 412);
    const err = await client()
      .deleteEntry("kb", "a/x", { kind: "hash", hash: "old" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SyncConflictError);
    expect(err.currentHash).toBeNull();
  });
});

describe("error handling", () => {
  it("surfaces the server's code and message", async () => {
    respond = () => json({ code: "unauthorized", message: "bad token" }, 401);
    const err = await client().listKbs().catch((e) => e);
    expect(err).toBeInstanceOf(SyncHttpError);
    expect([err.status, err.code, err.message]).toEqual([401, "unauthorized", "bad token"]);
  });

  it("still reports something useful when the body is not JSON", async () => {
    // A reverse proxy in front of the server answers with HTML.
    respond = () => new Response("<html>502</html>", { status: 502, statusText: "Bad Gateway" });
    const err = await client().listKbs().catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toContain("502");
  });

  it("treats a 404 on delete as success", async () => {
    // The end state a mirror wants is "not there"; someone else having removed
    // it first achieves that. Failing would wedge the sync on an entry nobody
    // has any more.
    respond = () => new Response(null, { status: 404 });
    await expect(client().deleteEntry("kb", "a/x", { kind: "any" })).resolves.toBeUndefined();
  });

  it("does not treat a 404 on download as success", async () => {
    respond = () => json({ code: "not_found", message: "gone" }, 404);
    await expect(client().downloadEntry("kb", "a/x")).rejects.toBeInstanceOf(SyncHttpError);
  });
});

describe("sync log", () => {
  it("reads the per-base history and reports a run as a stamped write", async () => {
    respond = () => json([{ atMs: 1, direction: "push", device: "A", created: 1, replaced: 0, deleted: 0 }]);
    const log = await client().listSyncs("kb");
    expect(log[0].direction).toBe("push");
    expect(calls[0].url).toBe("http://box:8787/v1/kbs/kb/syncs");
    expect(new Headers(calls[0].init.headers).get("X-Source-Device")).toBeNull();

    // The report is a write like any other: it carries the machine name, and
    // the counts the author just watched land — never a timestamp, which is
    // the server's to stamp.
    calls.length = 0;
    const named = createSyncClient("http://box:8787", "tok", "MacBook-Pro");
    respond = () => json({}, 201);
    await named.reportSync("kb", { direction: "pull", created: 0, replaced: 2, deleted: 1 });
    expect(calls[0].init.method).toBe("POST");
    expect(header("X-Source-Device")).toBe("MacBook-Pro");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      direction: "pull",
      created: 0,
      replaced: 2,
      deleted: 1,
    });
  });

  it("lets a report fail loudly — being best-effort is the caller's decision", async () => {
    // An older server has no /syncs route; the *store* swallows that, so the
    // client must not, or a real failure would vanish twice.
    respond = () => json({ code: "not_found", message: "no such route" }, 404);
    await expect(
      client().reportSync("kb", { direction: "push", created: 1, replaced: 0, deleted: 0 }),
    ).rejects.toBeInstanceOf(SyncHttpError);
  });
});

describe("manifest", () => {
  it("reduces to the hash map the planner takes", () => {
    expect(
      manifestHashes({
        kb: { id: "k", name: "k", createdAtMs: 0, entryCount: 2, updatedAtMs: 0, lastDevice: null },
        digest: "d",
        entries: [
          { path: "a/x", hash: "1", size: 1, updatedAtMs: 0 },
          { path: "b/y", hash: "2", size: 1, updatedAtMs: 0 },
        ],
      }),
    ).toEqual({ "a/x": "1", "b/y": "2" });
  });

  it("reads the download's hash header", async () => {
    respond = () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "x-entry-hash": "deadbeef" },
      });
    const got = await client().downloadEntry("kb", "a/x");
    expect(got.hash).toBe("deadbeef");
    expect([...got.bytes]).toEqual([1, 2, 3]);
  });
});
