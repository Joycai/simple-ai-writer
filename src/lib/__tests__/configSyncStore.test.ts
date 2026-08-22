/**
 * The config-backup store's sequencing.
 *
 * Everything decision-shaped lives one layer down and has its own tests. What
 * is only testable here is the *order*, and three orderings carry the safety of
 * the whole feature:
 *
 *   1. A push sends the hash the listing was drawn from, so a second machine
 *      that pushed in between gets a 412 instead of being overwritten.
 *   2. A remembered password that no longer opens the envelope must land on the
 *      prompt — not on "this backup is damaged".
 *   3. Downloading is not applying. `startRestore` stops at a preview.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

// ── the layers below the store ───────────────────────────────────────────────

const uploads: { slotId: string; expect: unknown; bytes: Uint8Array; meta: string }[] = [];
let downloadBytes: Uint8Array = new Uint8Array();
let slots: unknown[] = [];

const fakeClient = {
  listSlots: async () => slots,
  createSlot: async (name: string) => ({
    id: "new",
    name,
    createdAtMs: 1,
    versionCount: 0,
    current: null,
  }),
  listVersions: async () => [],
  download: async () => ({ bytes: downloadBytes, hash: "h", atMs: 7 }),
  upload: async (slotId: string, bytes: Uint8Array, meta: string, expected: unknown) => {
    uploads.push({ slotId, bytes, meta, expect: expected });
    return "newhash";
  },
  deleteSlot: async () => {},
};

vi.mock("../configsync/client", async () => {
  const actual = await vi.importActual<typeof import("../configsync/client")>(
    "../configsync/client",
  );
  return { ...actual, connectedConfigClient: async () => fakeClient };
});

const remembered = new Map<string, string>();
vi.mock("../configsync/password", () => ({
  loadSlotPassword: async (url: string, slot: string) => remembered.get(`${url}:${slot}`) ?? null,
  rememberSlotPassword: async (url: string, slot: string, pw: string) => {
    remembered.set(`${url}:${slot}`, pw);
  },
  forgetSlotPassword: async (url: string, slot: string) => {
    remembered.delete(`${url}:${slot}`);
  },
}));

vi.mock("../sync/config", async () => {
  const actual = await vi.importActual<typeof import("../sync/config")>("../sync/config");
  return { ...actual, getServerUrl: () => "http://box:8787" };
});
vi.mock("../sync/local", () => ({ deviceLabel: async () => "REINE-DESKTOP" }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.23.1" }));

// The bundle builder and the merge both talk to the config database; neither is
// what these tests are about.
let built = { keys: false };
const applied: unknown[] = [];
vi.mock("../ai/configTransfer", async () => {
  const bundle = (withKeys: boolean) => ({
    kind: "ai-writer-config-backup" as const,
    version: 1,
    exportedAt: "2026-08-23T00:00:00.000Z",
    appVersion: "1.23.1",
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiStandard: "openai" as const,
        createdAt: 1,
        ...(withKeys ? { apiKey: "sk-secret" } : {}),
      },
    ],
    models: [],
    prompts: [],
    prefs: [["app:theme", "dark"]] as [string, string][],
  });
  return {
    buildConfigBundle: async (includeKeys: boolean) => {
      built = { keys: includeKeys };
      return bundle(includeKeys);
    },
    parseConfigBundle: (raw: unknown) => {
      const r = raw as { providers?: unknown[]; models?: unknown[]; prompts?: unknown[] };
      return {
        providers: r.providers ?? [],
        models: r.models ?? [],
        prompts: r.prompts ?? [],
        prefs: [],
        keyCount: (r.providers as { apiKey?: string }[] | undefined)?.filter((p) => p.apiKey)
          .length ?? 0,
      };
    },
    applyConfigImport: async (staged: unknown) => void applied.push(staged),
  };
});

vi.mock("../ai/configDb", () => ({ listProviders: async () => [] }));
vi.mock("../project", () => ({ getGlobalDb: async () => ({}) }));
vi.mock("../../stores/appStore", () => ({
  useAppStore: { getState: () => ({ reloadFromPrefs: () => {} }) },
}));

const { useConfigSyncStore } = await import("../../stores/configSyncStore");
const { sealBundle } = await import("../configsync/envelope");

const bundleFor = (withKeys: boolean) => ({
  kind: "ai-writer-config-backup" as const,
  version: 1,
  exportedAt: "2026-08-23T00:00:00.000Z",
  appVersion: "1.23.1",
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiStandard: "openai" as const,
      createdAt: 1,
      ...(withKeys ? { apiKey: "sk-secret" } : {}),
    },
  ],
  models: [],
  prompts: [],
  prefs: [["app:theme", "dark"]] as [string, string][],
});

const slot = (current: { atMs: number; hash: string; size: number; meta: string | null } | null) => ({
  id: "desk",
  name: "书房台式机",
  createdAtMs: 1,
  versionCount: current ? 1 : 0,
  current,
});

beforeEach(() => {
  uploads.length = 0;
  applied.length = 0;
  remembered.clear();
  slots = [];
  built = { keys: false };
  useConfigSyncStore.setState({
    slots: [],
    versions: {},
    loading: false,
    busy: false,
    error: null,
    status: null,
    includeKeys: false,
    password: "",
    remember: false,
    phase: "idle",
    target: null,
    restorePassword: "",
    prepared: null,
  });
});

describe("push", () => {
  it("expects nothing to be stored on a first push", async () => {
    useConfigSyncStore.setState({ slots: [slot(null)] });
    await useConfigSyncStore.getState().push("desk");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].expect).toEqual({ kind: "absent" });
  });

  it("sends the hash the listing was drawn from when replacing", async () => {
    // Without this the configuration of whichever machine pushed in between
    // disappears silently — the failure the precondition rail exists for.
    useConfigSyncStore.setState({
      slots: [slot({ atMs: 1, hash: "old", size: 10, meta: null })],
    });
    await useConfigSyncStore.getState().push("desk");
    expect(uploads[0].expect).toEqual({ kind: "hash", hash: "old" });
  });

  it("refuses to push keys without a password, before any bytes are built", async () => {
    useConfigSyncStore.setState({ slots: [slot(null)], includeKeys: true, password: "" });
    await useConfigSyncStore.getState().push("desk");
    expect(uploads).toHaveLength(0);
    expect(useConfigSyncStore.getState().error).toBe("keys-need-password");
  });

  it("pushes keys once a password is given, and the wire carries no plaintext", async () => {
    useConfigSyncStore.setState({ slots: [slot(null)], includeKeys: true, password: "pw" });
    await useConfigSyncStore.getState().push("desk");
    expect(built.keys).toBe(true);
    expect(new TextDecoder().decode(uploads[0].bytes)).not.toContain("sk-secret");
    expect(useConfigSyncStore.getState().error).toBeNull();
  });

  it("clears the password field after a push", async () => {
    // It is a secret sitting in a React-rendered input; leaving it there means
    // it survives every later render of the settings page.
    useConfigSyncStore.setState({ slots: [slot(null)], includeKeys: true, password: "pw" });
    await useConfigSyncStore.getState().push("desk");
    expect(useConfigSyncStore.getState().password).toBe("");
  });

  it("remembers the password only when asked, and forgets it when unasked", async () => {
    useConfigSyncStore.setState({
      slots: [slot(null)],
      includeKeys: true,
      password: "pw",
      remember: true,
    });
    await useConfigSyncStore.getState().push("desk");
    expect(remembered.get("http://box:8787:desk")).toBe("pw");

    // Unticking has to actually forget: a stale entry would silently unlock a
    // backup the author believes is now only in their head.
    useConfigSyncStore.setState({ password: "pw2", remember: false });
    await useConfigSyncStore.getState().push("desk");
    expect(remembered.has("http://box:8787:desk")).toBe(false);
  });

  it("reports a 412 as a conflict the author can act on", async () => {
    const { SyncConflictError } = await import("../sync/client");
    const original = fakeClient.upload;
    fakeClient.upload = async () => {
      throw new SyncConflictError("desk", "theirs", "it has changed on the server");
    };
    useConfigSyncStore.setState({ slots: [slot({ atMs: 1, hash: "old", size: 1, meta: null })] });
    await useConfigSyncStore.getState().push("desk");
    expect(useConfigSyncStore.getState().error).toBe("conflict");
    fakeClient.upload = original;
  });
});

describe("restore", () => {
  it("stops at a preview — downloading never applies", async () => {
    downloadBytes = (await sealBundle(bundleFor(false), {
      device: "laptop",
      appVersion: "1.23.1",
      password: null,
    })).bytes;
    useConfigSyncStore.setState({ slots: [slot({ atMs: 7, hash: "h", size: 1, meta: null })] });

    await useConfigSyncStore.getState().startRestore("desk");
    expect(useConfigSyncStore.getState().phase).toBe("preview");
    expect(applied).toHaveLength(0);

    await useConfigSyncStore.getState().confirmRestore();
    expect(useConfigSyncStore.getState().phase).toBe("done");
    expect(applied).toHaveLength(1);
  });

  it("asks for a password when the envelope is encrypted", async () => {
    downloadBytes = (await sealBundle(bundleFor(true), {
      device: "laptop",
      appVersion: "1.23.1",
      password: "pw",
    })).bytes;
    useConfigSyncStore.setState({ slots: [slot({ atMs: 7, hash: "h", size: 1, meta: null })] });

    await useConfigSyncStore.getState().startRestore("desk");
    expect(useConfigSyncStore.getState().phase).toBe("password");
    // The header is readable without the password — that is what lets the
    // prompt say which backup it is asking about.
    expect(useConfigSyncStore.getState().target?.header.device).toBe("laptop");
    expect(useConfigSyncStore.getState().target?.header.hasKeys).toBe(true);

    useConfigSyncStore.getState().setRestorePassword("wrong");
    await useConfigSyncStore.getState().submitRestorePassword();
    expect(useConfigSyncStore.getState().phase).toBe("password");
    expect(useConfigSyncStore.getState().error).toBe("bad-password");

    useConfigSyncStore.getState().setRestorePassword("pw");
    await useConfigSyncStore.getState().submitRestorePassword();
    expect(useConfigSyncStore.getState().phase).toBe("preview");
    expect(useConfigSyncStore.getState().prepared?.bundle.keyCount).toBe(1);
  });

  it("uses a remembered password without asking", async () => {
    downloadBytes = (await sealBundle(bundleFor(true), {
      device: "laptop",
      appVersion: "1.23.1",
      password: "pw",
    })).bytes;
    remembered.set("http://box:8787:desk", "pw");
    useConfigSyncStore.setState({ slots: [slot({ atMs: 7, hash: "h", size: 1, meta: null })] });

    await useConfigSyncStore.getState().startRestore("desk");
    expect(useConfigSyncStore.getState().phase).toBe("preview");
  });

  it("falls back to the prompt when the remembered password has gone stale", async () => {
    // The author changed the password from another machine. This must read as
    // "type it again", not as "this backup is damaged" — the second sentence
    // sends them looking for a corrupted file that does not exist.
    downloadBytes = (await sealBundle(bundleFor(true), {
      device: "laptop",
      appVersion: "1.23.1",
      password: "new-password",
    })).bytes;
    remembered.set("http://box:8787:desk", "the-old-one");
    useConfigSyncStore.setState({ slots: [slot({ atMs: 7, hash: "h", size: 1, meta: null })] });

    await useConfigSyncStore.getState().startRestore("desk");
    expect(useConfigSyncStore.getState().phase).toBe("password");
    expect(useConfigSyncStore.getState().error).toBeNull();
  });

  it("does not offer a password prompt for something that is not a backup", async () => {
    // A truncated download is not fixed by typing a password, and a prompt
    // would invite the author to try one until they gave up.
    downloadBytes = new TextEncoder().encode("<html>502 Bad Gateway</html>");
    useConfigSyncStore.setState({ slots: [slot({ atMs: 7, hash: "h", size: 1, meta: null })] });

    await useConfigSyncStore.getState().startRestore("desk");
    expect(useConfigSyncStore.getState().phase).toBe("idle");
    expect(useConfigSyncStore.getState().error).toBe("not-an-envelope");
  });

  it("counts what will be merged from the decrypted bundle, not the header", async () => {
    // `counts` in the envelope header is self-reported and unverifiable once
    // encrypted. The confirmation the author reads has to come from the real
    // parse, so a header that lies changes nothing on screen.
    const sealed = await sealBundle(bundleFor(true), {
      device: "laptop",
      appVersion: "1.23.1",
      password: "pw",
    });
    const doc = JSON.parse(new TextDecoder().decode(sealed.bytes));
    doc.counts = { providers: 999, models: 999, prompts: 999, prefs: 999 };
    downloadBytes = new TextEncoder().encode(JSON.stringify(doc));
    remembered.set("http://box:8787:desk", "pw");
    useConfigSyncStore.setState({ slots: [slot({ atMs: 7, hash: "h", size: 1, meta: null })] });

    await useConfigSyncStore.getState().startRestore("desk");
    expect(useConfigSyncStore.getState().prepared?.bundle.providers).toHaveLength(1);
  });
});
