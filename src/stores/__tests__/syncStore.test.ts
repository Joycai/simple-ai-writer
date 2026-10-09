import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncBinding } from "../../lib/sync/model";
import type { RemoteManifest } from "../../lib/sync/client";
import { syncVerdict } from "../../lib/sync/status";

const mocks = vi.hoisted(() => ({
  manifest: vi.fn(), listKbs: vi.fn(), listSyncs: vi.fn(),
  hashes: vi.fn(), loadBinding: vi.fn(), saveBinding: vi.fn(),
  clearBinding: vi.fn(), probe: vi.fn(), run: vi.fn(),
}));
vi.mock("../../lib/sync/client", async (original) => ({
  ...await original<typeof import("../../lib/sync/client")>(),
  createSyncClient: () => ({
    manifest: mocks.manifest, listKbs: mocks.listKbs, listSyncs: mocks.listSyncs,
  }),
  probeHealth: mocks.probe,
}));
vi.mock("../../lib/sync/config", () => ({
  getServerUrl: () => "http://server", loadToken: async () => "token",
  normalizeServerUrl: (s: string) => s.trim().replace(/\/+$/, ""),
  saveToken: async () => {}, setServerUrl: () => {},
}));
vi.mock("../../lib/sync/local", () => ({ deviceLabel: async () => "device", localEntryHashes: mocks.hashes }));
vi.mock("../../lib/sync/store", () => ({
  loadBinding: mocks.loadBinding, saveBinding: mocks.saveBinding, clearBinding: mocks.clearBinding,
}));
vi.mock("../../lib/sync/run", () => ({ runSync: mocks.run }));
vi.mock("../loreStore", () => ({ useLoreStore: { getState: () => ({ scanProject: async () => {} }) } }));
vi.mock("../../lib/prefs", () => ({ readPref: () => null, writePref: () => {} }));

const { useSyncStore } = await import("../syncStore");
const state = () => useSyncStore.getState();
const binding: SyncBinding = {
  serverUrl: "http://server", kbId: "kb", kbName: "Library", snapshot: {}, lastSyncAt: null,
};
const manifest: RemoteManifest = {
  kb: { id: "kb", name: "Library", createdAtMs: 1, entryCount: 0, updatedAtMs: 1, lastDevice: null },
  digest: "digest", entries: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  state().disconnect();
  useSyncStore.setState(useSyncStore.getInitialState());
  vi.resetAllMocks();
  mocks.loadBinding.mockResolvedValue(binding);
  mocks.manifest.mockResolvedValue(manifest);
  mocks.listKbs.mockResolvedValue([manifest.kb]);
  mocks.listSyncs.mockResolvedValue([]);
  mocks.hashes.mockResolvedValue({});
  mocks.probe.mockResolvedValue(true);
});

async function connected() {
  await state().hydrate("/project");
  await state().connect();
}

describe("sync comparison lifecycle", () => {
  it("compares on the first manual connection without remounting the page", async () => {
    await state().hydrate("/project");
    expect(mocks.manifest).not.toHaveBeenCalled();
    expect(syncVerdict(state())).toBe("offline");
    const pending = deferred<RemoteManifest>();
    mocks.manifest.mockReturnValueOnce(pending.promise);
    const connect = state().connect();
    await vi.waitFor(() => expect(state().comparing).toBe(true));
    expect(syncVerdict(state())).toBe("loading");
    pending.resolve(manifest);
    await connect;
    expect(syncVerdict(state())).toBe("in-sync");
    expect(state()).toMatchObject({ localCount: 0, remoteCount: 0, checking: null });
    expect(mocks.listSyncs).toHaveBeenCalledWith("kb");
  });

  it("connects without a project and does not read a binding or hash files", async () => {
    await state().hydrate("");
    await state().connect();
    expect(state().connection).toBe("connected");
    expect(mocks.loadBinding).not.toHaveBeenCalled();
    expect(mocks.hashes).not.toHaveBeenCalled();
    expect(syncVerdict(state())).toBe("unknown");
  });

  it("automatic connection compares once, and reconnect replaces stale counts", async () => {
    await state().ensureReady("/project");
    expect(mocks.hashes).toHaveBeenCalledTimes(1);
    state().disconnect();
    expect(state().freshness).toBeNull();
    mocks.hashes.mockResolvedValue({ "people/new": "hash" });
    await state().connect();
    expect(state().localCount).toBe(1);
    expect(syncVerdict(state())).toBe("first-sync");
  });

  it.each(["manifest", "hashes"] as const)("exits loading after %s failure and allows retry", async (step) => {
    mocks[step].mockRejectedValueOnce(new Error("unavailable"));
    await connected();
    expect(state().connection).toBe("connected");
    expect(syncVerdict(state())).toBe("error");
    expect(state()).toMatchObject({ comparing: false, checking: null, comparisonError: "unavailable" });
    await state().refreshCounts("/project");
    expect(syncVerdict(state())).toBe("in-sync");
    expect(state().comparisonError).toBeNull();
  });

  it("coalesces concurrent refreshes and makes both callers await the result", async () => {
    await connected();
    const pending = deferred<RemoteManifest>();
    mocks.manifest.mockReturnValueOnce(pending.promise);
    const first = state().refreshCounts("/project");
    let finished = false;
    const second = state().refreshCounts("/project").then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    pending.resolve(manifest);
    await Promise.all([first, second]);
    expect(mocks.manifest).toHaveBeenCalledTimes(2);
    expect(syncVerdict(state())).toBe("in-sync");
  });

  it("does not turn a failed history request into a failed comparison", async () => {
    mocks.listSyncs.mockRejectedValue(new Error("404"));
    await connected();
    expect(syncVerdict(state())).toBe("in-sync");
  });

  it("shows comparison complete even while history is still loading", async () => {
    const history = deferred<[]>();
    mocks.listSyncs.mockReturnValueOnce(history.promise);
    const connection = connected();
    await vi.waitFor(() => expect(syncVerdict(state())).toBe("in-sync"));
    expect(state().checking).toBeNull();
    history.resolve([]);
    await connection;
  });

  it.each(["disconnect", "unbind"] as const)("ignores late responses after %s", async (action) => {
    await connected();
    const pending = deferred<RemoteManifest>();
    mocks.manifest.mockReturnValueOnce(pending.promise);
    const refresh = state().refreshCounts("/project");
    if (action === "disconnect") state().disconnect();
    else await state().unbind("/project");
    pending.resolve(manifest);
    await refresh;
    expect(state()).toMatchObject({ freshness: null, comparing: false, localCount: -1, remoteCount: -1 });
    if (action === "unbind") expect(state().binding).toBeNull();
  });

  it("allows the new project's comparison while the old request is pending", async () => {
    await connected();
    const pending = deferred<RemoteManifest>();
    mocks.manifest.mockReturnValueOnce(pending.promise);
    const old = state().refreshCounts("/project");
    mocks.loadBinding.mockResolvedValue({ ...binding, kbId: "second" });
    mocks.manifest.mockResolvedValue({ ...manifest, kb: { ...manifest.kb, id: "second", name: "Second" } });
    await state().hydrate("/second");
    expect(syncVerdict(state())).toBe("in-sync");
    pending.resolve(manifest);
    await old;
    expect(state().binding?.kbId).toBe("second");
    expect(state().binding?.kbName).toBe("Second");
  });

  it("ignores obsolete hydration and a connection completed after disconnect", async () => {
    const pending = deferred<SyncBinding>();
    mocks.loadBinding.mockReturnValueOnce(pending.promise);
    const old = state().hydrate("/old");
    await state().hydrate("/new");
    pending.resolve({ ...binding, kbId: "old" });
    await old;
    expect(state().hydratedFor).toBe("/new");
    expect(state().binding?.kbId).toBe("kb");
    const listing = deferred<[]>();
    mocks.listKbs.mockReturnValueOnce(listing.promise);
    const connect = state().connect();
    await vi.waitFor(() => expect(mocks.listKbs).toHaveBeenCalled());
    state().disconnect();
    listing.resolve([]);
    await connect;
    expect(state().connection).toBe("disconnected");
  });
  it("binding a new library refreshes it without waiting for an old comparison", async () => {
    await connected();
    const pending = deferred<RemoteManifest>();
    mocks.manifest.mockReturnValueOnce(pending.promise);
    const old = state().refreshCounts("/project");
    await state().bind("/project", { ...manifest.kb, id: "new" });
    pending.resolve(manifest);
    await old;
    expect(state().binding?.kbId).toBe("new");
    expect(syncVerdict(state())).toBe("in-sync");
  });

  it("ignores hashing progress and failures after disconnect", async () => {
    await connected();
    const pending = deferred<Record<string, string>>();
    mocks.hashes.mockReturnValueOnce(pending.promise);
    const old = state().refreshCounts("/project");
    await vi.waitFor(() => expect(mocks.hashes).toHaveBeenCalledTimes(2));
    const progress = mocks.hashes.mock.calls[1][2];
    state().disconnect();
    progress({ done: 1, total: 2, path: "old" });
    pending.reject(new Error("old failure"));
    await old;
    expect(state()).toMatchObject({ checking: null, comparisonError: null, freshness: null });
  });

  it("does not compare when connecting fails", async () => {
    mocks.listKbs.mockRejectedValueOnce(new Error("unauthorized"));
    await connected();
    expect(state()).toMatchObject({ connection: "error", comparing: false });
    expect(mocks.hashes).not.toHaveBeenCalled();
  });

  it("does not let a stale health failure undo a manual connection", async () => {
    await state().hydrate("/project");
    const pending = deferred<boolean>();
    mocks.probe.mockReturnValueOnce(pending.promise);
    const ready = state().ensureReady("/project");
    await connected();
    pending.resolve(false);
    await ready;
    expect(syncVerdict(state())).toBe("in-sync");
  });

  it("still stops push and pull at preview without transferring anything", async () => {
    await connected();
    mocks.hashes.mockResolvedValue({ "people/new": "hash" });
    for (const direction of ["push", "pull"] as const) {
      await state().startPreview("/project", direction);
      expect(state().phase).toBe("preview");
      expect(state().plan?.direction).toBe(direction);
      expect(mocks.run).not.toHaveBeenCalled();
      state().closeModal();
    }
  });

});
