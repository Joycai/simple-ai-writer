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

vi.mock("../sync/config", async () => {
  const actual = await vi.importActual<typeof import("../sync/config")>("../sync/config");
  return { ...actual, getServerUrl: () => "http://box:8787", loadToken: async () => "tok" };
});

vi.mock("../sync/local", () => ({ deviceLabel: async () => "REINE-DESKTOP" }));

const { createConfigSyncClient, connectedConfigClient } = await import("../configsync/client");
const { SyncConflictError, SyncHttpError } = await import("../sync/client");
// The value bindings above come from a dynamic import, so the class names are
// not usable as types; these aliases are the same classes, imported for typing.
type ConflictError = import("../sync/client").SyncConflictError;
type HttpError = import("../sync/client").SyncHttpError;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const client = () => createConfigSyncClient("http://box:8787/", "tok", "REINE-DESKTOP");
const header = (name: string, i = 0) => new Headers(calls[i].init.headers).get(name);

beforeEach(() => {
  calls.length = 0;
  respond = () => json({});
});

describe("config sync client", () => {
  it("carries the bearer token on every call", async () => {
    respond = () => json([]);
    await client().listSlots();
    expect(header("Authorization")).toBe("Bearer tok");
  });

  it("normalises a trailing slash out of the server address", async () => {
    // `http://box:8787` and `http://box:8787/` are one server; two spellings
    // would otherwise reach the server as `//v1/configs`.
    respond = () => json([]);
    await client().listSlots();
    expect(calls[0].url).toBe("http://box:8787/v1/configs");
  });

  it("sends a create-only precondition on a first push", async () => {
    respond = () => new Response(null, { status: 201, headers: { "x-config-hash": "abc" } });
    const hash = await client().upload("desk", new Uint8Array([1, 2]), "bWV0YQ==", {
      kind: "absent",
    });
    expect(header("If-None-Match")).toBe("*");
    expect(header("X-Config-Meta")).toBe("bWV0YQ==");
    expect(header("X-Source-Device")).toBe("REINE-DESKTOP");
    expect(hash).toBe("abc");
  });

  it("sends the hash it expects to replace, quoted as a strong ETag", async () => {
    respond = () => new Response(null, { status: 204, headers: { "x-config-hash": "def" } });
    await client().upload("desk", new Uint8Array([1]), "bQ==", { kind: "hash", hash: "abc" });
    expect(header("If-Match")).toBe('"abc"');
    expect(header("If-None-Match")).toBeNull();
  });

  it("turns a 412 into a conflict carrying what is actually stored", async () => {
    // The one error a caller can act on without the author: re-read and re-plan.
    respond = () =>
      json({ code: "precondition_failed", message: "it has changed", currentHash: "zzz" }, 412);
    const err = await client()
      .upload("desk", new Uint8Array([1]), "bQ==", { kind: "hash", hash: "abc" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SyncConflictError);
    expect((err as ConflictError).currentHash).toBe("zzz");
    expect((err as ConflictError).path).toBe("desk");
  });

  it("reports other failures as HTTP errors with the server's code", async () => {
    respond = () => json({ code: "not_found", message: "no config backup named \"nope\"" }, 404);
    const err = await client().download("nope").catch((e) => e);
    expect(err).toBeInstanceOf(SyncHttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).code).toBe("not_found");
  });

  it("survives a server that answers with HTML instead of JSON", async () => {
    // A reverse proxy's 413 page, most often. The status line is still useful.
    respond = () => new Response("<html>413</html>", { status: 413 });
    const err = await client()
      .upload("desk", new Uint8Array([1]), "bQ==", { kind: "any" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SyncHttpError);
    expect((err as HttpError).status).toBe(413);
  });

  it("reads the hash and the version stamp off a download", async () => {
    respond = () =>
      new Response(new Uint8Array([7, 8, 9]), {
        status: 200,
        headers: { "x-config-hash": "abc", "x-config-at": "1787417460529" },
      });
    const got = await client().download("desk");
    expect(Array.from(got.bytes)).toEqual([7, 8, 9]);
    expect(got.hash).toBe("abc");
    expect(got.atMs).toBe(1787417460529);
  });

  it("addresses one historical version by its timestamp", async () => {
    respond = () => new Response(new Uint8Array([1]), { status: 200 });
    await client().download("desk", 1787417460529);
    expect(calls[0].url).toBe("http://box:8787/v1/configs/desk/versions/1787417460529");
  });

  it("percent-encodes a slot id", async () => {
    respond = () => json([]);
    await client().listVersions("a b/c");
    expect(calls[0].url).toBe("http://box:8787/v1/configs/a%20b%2Fc/versions");
  });

  it("uploads only the view's own bytes, not its whole backing buffer", async () => {
    // A `Uint8Array` from `subarray` shares a larger ArrayBuffer; handing that
    // buffer to fetch would silently upload the neighbouring bytes too.
    respond = () => new Response(null, { status: 204 });
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);
    await client().upload("desk", backing.subarray(2, 4), "bQ==", { kind: "any" });
    expect(new Uint8Array(calls[0].init.body as ArrayBuffer)).toEqual(new Uint8Array([3, 4]));
  });

  it("treats a delete of something already gone as success", async () => {
    // The end state a delete wants is "not there"; someone else having got
    // there first achieves it. Failing would strand the author on the slot.
    respond = () => json({ code: "not_found", message: "gone" }, 404);
    await expect(client().deleteSlot("desk")).resolves.toBeUndefined();
  });

  it("omits the device header when the machine has no name", async () => {
    respond = () => new Response(null, { status: 204 });
    await createConfigSyncClient("http://box:8787", "tok", "  ").upload(
      "desk",
      new Uint8Array([1]),
      "bQ==",
      { kind: "any" },
    );
    expect(header("X-Source-Device")).toBeNull();
  });
});

describe("connectedConfigClient", () => {
  it("builds a client from the installation-level connection", async () => {
    // Address and token are not this module's own — they live where the
    // knowledge-base sync already keeps them, because they describe the
    // install, not the project or the resource.
    respond = () => json([]);
    const c = await connectedConfigClient();
    expect(c).not.toBeNull();
    await c!.listSlots();
    expect(calls[0].url).toBe("http://box:8787/v1/configs");
    expect(header("Authorization")).toBe("Bearer tok");
  });
});
