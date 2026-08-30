/**
 * lib/prefs — the preference store.
 *
 * Preferences used to be scattered `localStorage` calls, which meant clearing
 * the webview's data reset every one of them and nothing could enumerate the
 * set to back it up. The properties worth pinning here are the ones a careless
 * migration gets wrong: a key must never be dropped from `localStorage` before
 * it is safely in the database, a config backup must not carry paths from
 * another machine, and the per-project keys must actually get collected —
 * that last one is the leak this module was partly written to close.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A `localStorage` that also behaves like one for `Object.keys`, which the
 * migration uses to find what is left over. The methods are non-enumerable so
 * they don't show up as stored keys.
 */
function fakeLocalStorage() {
  const ls: Record<string, string> = {};
  for (const [name, fn] of [
    ["getItem", (k: string) => (k in ls ? ls[k] : null)],
    ["setItem", (k: string, v: string) => void (ls[k] = v)],
    ["removeItem", (k: string) => void delete ls[k]],
  ] as [string, unknown][]) {
    Object.defineProperty(ls, name, { value: fn, enumerable: false, configurable: true });
  }
  return ls as Record<string, string> & Storage;
}

const h = vi.hoisted(() => ({
  // Both parameters are declared so `mock.calls` is indexable and a
  // `mockImplementation` can branch on the SQL — a zero-arg `vi.fn` infers an
  // empty tuple and the assertions below fail to compile rather than to hold.
  execute: vi.fn(async (_sql: string, _args?: unknown[]) => {}),
  select: vi.fn(async (_sql: string) => [] as { key: string; value: string }[]),
  getGlobalDb: vi.fn(),
}));

vi.mock("../project", () => ({ getGlobalDb: h.getGlobalDb }));

// `isTauri` is read once at module load, so the window stub has to precede the
// import — same reason keyStore.test.ts does it this way.
vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
let ls = fakeLocalStorage();
vi.stubGlobal("localStorage", ls);

const prefs = await import("../prefs");

beforeEach(async () => {
  // Drain the previous test's background writes first: the chain outlives a
  // `resetPrefsForTest`, and a late `execute` landing after the mocks are
  // cleared shows up as the *next* test's write.
  await prefs.flushPrefs().catch(() => {});
  ls = fakeLocalStorage();
  vi.stubGlobal("localStorage", ls);
  h.execute.mockReset().mockResolvedValue(undefined);
  h.select.mockReset().mockResolvedValue([]);
  h.getGlobalDb.mockReset().mockResolvedValue({ execute: h.execute, select: h.select });
  prefs.resetPrefsForTest();
});

/** SQL + args of every write the module issued. */
const writes = () => h.execute.mock.calls.map((c) => [String(c[0]), c[1] ?? []] as [string, unknown[]]);
const upserted = () =>
  writes()
    .filter(([sql]) => sql.includes("INSERT OR REPLACE"))
    .map(([, args]) => args as [string, string]);
const deleted = () =>
  writes()
    .filter(([sql]) => sql.includes("DELETE FROM"))
    .map(([, args]) => (args as string[])[0]);

describe("isPrefKey", () => {
  it("recognises the fixed keys", () => {
    expect(prefs.isPrefKey("app:theme")).toBe(true);
    expect(prefs.isPrefKey("ai:activeModelId")).toBe(true);
    expect(prefs.isPrefKey("manuscript:onboarding-done")).toBe(true);
  });

  it("recognises a per-project key but not the bare prefix", () => {
    expect(prefs.isPrefKey(`${prefs.PINNED_LORE_PREFIX}D:/books/a`)).toBe(true);
    expect(prefs.isPrefKey(prefs.PINNED_LORE_PREFIX)).toBe(false);
  });

  it("ignores keys the app does not own", () => {
    // The migration walks all of localStorage; anything else living there is
    // some other tenant's and must be left exactly where it is.
    expect(prefs.isPrefKey("someOtherApp:token")).toBe(false);
    expect(prefs.isPrefKey("app:")).toBe(false);
  });
});

/**
 * The registry is load-bearing in three places — migration out of
 * `localStorage`, the config-backup subset, and orphan collection — and all
 * three fail *silently* for a key that is missing from it: the preference keeps
 * working, it just never migrates and never travels. Nothing about writing
 * `writePref("app:newThing", …)` prompts anyone to come back here, so the
 * check is mechanical.
 */
describe("PREF_KEYS covers what the source actually stores", () => {
  it("has an entry for every literal key passed to read/write/deletePref", () => {
    const sources = import.meta.glob("../../**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    const used = new Set<string>();
    const pattern = /\b(?:readPref|writePref|deletePref)\(\s*["'`]([^"'`$]+)["'`]/g;
    for (const [path, source] of Object.entries(sources)) {
      if (path.includes("__tests__")) continue;
      for (const m of source.matchAll(pattern)) used.add(m[1]);
    }

    expect(used.size).toBeGreaterThan(0); // the scan itself still works
    expect([...used].filter((k) => !prefs.isPrefKey(k)).sort()).toEqual([]);
  });

  /**
   * The literal-call scan above has a blind spot the codebase's own house style
   * walks straight into: every flag module writes `const KEY = "app:…"` and
   * calls `readPref(KEY)` — no literal ever reaches the call site. That is
   * exactly how `app:toolPackDev` / `app:toolPackOrchestratorBeta` shipped
   * unregistered and got silently dropped by config-backup restore (and how
   * `ai:translate:linesPerChunk` sat unregistered for a whole release). So scan
   * the *literals themselves*: any owned-prefix string in source is either a
   * registered key or a declared per-project family prefix.
   */
  it("has an entry for every owned-prefix string literal — const-indirected keys included", () => {
    const sources = import.meta.glob("../../**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    const found = new Set<string>();
    // Double/single quotes only: backtick-wrapped mentions in comments (markdown
    // style) and template literals with interpolation are not key declarations.
    const pattern = /["']((?:app|ai|manuscript):[A-Za-z0-9:_-]+)["']/g;
    for (const [path, source] of Object.entries(sources)) {
      if (path.includes("__tests__")) continue;
      for (const m of source.matchAll(pattern)) found.add(m[1]);
    }

    expect(found.size).toBeGreaterThan(30); // the scan itself still works
    const strays = [...found].filter((k) =>
      k.endsWith(":")
        ? !prefs.PREF_KEY_PREFIXES.includes(k as never) // a family declares its prefix
        : !prefs.isPrefKey(k),
    );
    expect(strays.sort()).toEqual([]);
  });
});

describe("before hydration", () => {
  it("reads and writes localStorage, exactly as the app did before", () => {
    prefs.writePref("app:theme", "light");
    expect(ls["app:theme"]).toBe("light");
    expect(prefs.readPref("app:theme")).toBe("light");

    prefs.deletePref("app:theme");
    expect(prefs.readPref("app:theme")).toBeNull();
  });

  it("touches no database", () => {
    prefs.writePref("app:theme", "light");
    expect(h.getGlobalDb).not.toHaveBeenCalled();
  });
});

describe("hydratePrefs", () => {
  it("loads stored rows and makes the database the store", async () => {
    h.select.mockResolvedValueOnce([{ key: "app:theme", value: "light" }]);

    await prefs.hydratePrefs();

    expect(prefs.prefsHydrated()).toBe(true);
    expect(prefs.readPref("app:theme")).toBe("light");
  });

  it("migrates leftovers, writing the database before clearing localStorage", async () => {
    ls["app:fontScheme"] = "song";
    ls["someOtherApp:token"] = "leave me alone";
    const order: string[] = [];
    h.execute.mockImplementation(async (sql) => {
      if (String(sql).includes("INSERT OR REPLACE")) order.push("db-write");
    });
    Object.defineProperty(ls, "removeItem", {
      value: (k: string) => { order.push("ls-remove"); delete ls[k]; },
      enumerable: false,
    });

    await prefs.hydratePrefs();

    expect(order).toEqual(["db-write", "ls-remove"]);
    expect(prefs.readPref("app:fontScheme")).toBe("song");
    expect(ls["app:fontScheme"]).toBeUndefined();
    expect(ls["someOtherApp:token"]).toBe("leave me alone");
  });

  it("keeps a key in localStorage when its migration write fails", async () => {
    ls["app:fontScheme"] = "song";
    h.execute.mockImplementation(async (sql) => {
      if (String(sql).includes("INSERT OR REPLACE")) throw new Error("database is locked");
    });

    await prefs.hydratePrefs();

    // Removing it first would have destroyed the preference outright.
    expect(ls["app:fontScheme"]).toBe("song");
  });

  it("lets the database win over a stale localStorage copy", async () => {
    ls["app:theme"] = "dark";
    h.select.mockResolvedValueOnce([{ key: "app:theme", value: "light" }]);

    await prefs.hydratePrefs();

    expect(prefs.readPref("app:theme")).toBe("light");
    expect(upserted().some(([k]) => k === "app:theme")).toBe(false);
  });

  it("stays on localStorage when the store cannot be opened", async () => {
    h.getGlobalDb.mockRejectedValueOnce(new Error("no such file"));

    await prefs.hydratePrefs();

    expect(prefs.prefsHydrated()).toBe(false);
    prefs.writePref("app:theme", "light");
    expect(ls["app:theme"]).toBe("light");
  });
});

describe("collecting per-project preferences", () => {
  const pin = (path: string) => `${prefs.PINNED_LORE_PREFIX}${path}`;

  it("drops rows for projects no longer in the recents list", async () => {
    h.select.mockResolvedValueOnce([
      { key: "app:recentProjects", value: JSON.stringify(["D:/books/live"]) },
      { key: pin("D:/books/live"), value: "[]" },
      { key: pin("D:/books/renamed-away"), value: "[]" },
      { key: pin("D:/books/deleted"), value: "[]" },
    ]);

    await prefs.hydratePrefs();
    await prefs.flushPrefs();

    expect(prefs.readPref(pin("D:/books/live"))).toBe("[]");
    expect(prefs.readPref(pin("D:/books/renamed-away"))).toBeNull();
    expect(deleted().sort()).toEqual([pin("D:/books/deleted"), pin("D:/books/renamed-away")]);
  });

  it("counts a pinned project as live even when it is not in the recents", async () => {
    // A pin can outlive the recents row (lib/recentProjects → splitProjects,
    // and the cross-instance race its header documents), and it is still on
    // screen in 「已固定」 — sweeping it would delete the lore pins of a
    // project the author deliberately kept.
    h.select.mockResolvedValueOnce([
      { key: "app:recentProjects", value: JSON.stringify(["D:/books/live"]) },
      { key: "app:pinnedProjects", value: JSON.stringify(["D:/books/kept"]) },
      { key: pin("D:/books/kept"), value: "[]" },
      { key: pin("D:/books/gone"), value: "[]" },
    ]);

    await prefs.hydratePrefs();
    await prefs.flushPrefs();

    expect(prefs.readPref(pin("D:/books/kept"))).toBe("[]");
    expect(deleted()).toEqual([pin("D:/books/gone")]);
  });

  it("matches by path identity, not by spelling", async () => {
    h.select.mockResolvedValueOnce([
      { key: "app:recentProjects", value: JSON.stringify(["D:/books/live"]) },
      { key: pin("D:\\books\\live"), value: "[]" },
    ]);

    await prefs.hydratePrefs();
    await prefs.flushPrefs();

    expect(deleted()).toEqual([]);
  });

  it("deletes nothing when the pin list is unreadable", async () => {
    h.select.mockResolvedValueOnce([
      { key: "app:recentProjects", value: JSON.stringify(["D:/books/live"]) },
      { key: "app:pinnedProjects", value: "{not json" },
      { key: pin("D:/books/other"), value: "[]" },
    ]);

    await prefs.hydratePrefs();
    await prefs.flushPrefs();

    expect(prefs.readPref(pin("D:/books/other"))).toBe("[]");
    expect(deleted()).toEqual([]);
  });

  it("deletes nothing when the recents list is unreadable", async () => {
    h.select.mockResolvedValueOnce([
      { key: "app:recentProjects", value: "{not json" },
      { key: pin("D:/books/a"), value: "[]" },
    ]);

    await prefs.hydratePrefs();
    await prefs.flushPrefs();

    expect(prefs.readPref(pin("D:/books/a"))).toBe("[]");
    expect(deleted()).toEqual([]);
  });

  it("prunePrefsWithPrefix removes from the cache synchronously", async () => {
    h.select.mockResolvedValueOnce([
      // Both projects are live, so the startup sweep leaves them alone and
      // this test measures the prune it actually calls.
      { key: "app:recentProjects", value: JSON.stringify(["D:/a", "D:/b"]) },
      { key: pin("D:/a"), value: "[]" },
      { key: pin("D:/b"), value: "[]" },
    ]);
    await prefs.hydratePrefs();

    const dropped = prefs.prunePrefsWithPrefix(prefs.PINNED_LORE_PREFIX, (p) => p === "D:/a");

    expect(dropped).toEqual([pin("D:/b")]);
    // The caller's very next read must not still see it.
    expect(prefs.readPref(pin("D:/b"))).toBeNull();
    expect(prefs.readPref(pin("D:/a"))).toBe("[]");
  });
});

describe("backup subset", () => {
  beforeEach(async () => {
    h.select.mockResolvedValueOnce([
      { key: "app:theme", value: "light" },
      { key: "app:recentProjects", value: '["D:/books/a"]' },
      { key: "manuscript:onboarding-done", value: "true" },
      { key: `${prefs.PINNED_LORE_PREFIX}D:/books/a`, value: "[]" },
    ]);
    await prefs.hydratePrefs();
  });

  it("carries taste, not machine state", () => {
    const keys = prefs.portablePrefEntries().map(([k]) => k);
    expect(keys).toContain("app:theme");
    expect(keys).not.toContain("app:recentProjects");
    expect(keys).not.toContain("manuscript:onboarding-done");
    expect(keys.some((k) => k.startsWith(prefs.PINNED_LORE_PREFIX))).toBe(false);
  });

  it("refuses the same keys on the way back in", () => {
    // A backup written by hand (or a future version) must not be able to plant
    // another machine's project paths.
    const applied = prefs.applyPrefEntries([
      ["app:fontScheme", "song"],
      ["app:recentProjects", '["E:/somebody-elses/project"]'],
      [`${prefs.PINNED_LORE_PREFIX}E:/somebody-elses/project`, "[]"],
      ["someOtherApp:token", "nope"],
    ]);

    expect(applied).toBe(1);
    expect(prefs.readPref("app:fontScheme")).toBe("song");
    expect(prefs.readPref("app:recentProjects")).toBe('["D:/books/a"]');
    expect(prefs.readPref("someOtherApp:token")).toBeNull();
  });
});

describe("persistence", () => {
  it("serialises writes so the last call is the one that lands", async () => {
    await prefs.hydratePrefs();

    prefs.writePref("app:sidebarWidth", "200");
    prefs.writePref("app:sidebarWidth", "260");
    prefs.writePref("app:sidebarWidth", "300");
    await prefs.flushPrefs();

    // Same key three times, in the order they were called — a slider drag must
    // not be able to land its intermediate value last.
    expect(upserted().filter(([k]) => k === "app:sidebarWidth").map(([, v]) => v)).toEqual([
      "200", "260", "300",
    ]);
    expect(prefs.readPref("app:sidebarWidth")).toBe("300");
  });

  it("keeps the in-memory value when the write fails", async () => {
    await prefs.hydratePrefs();
    h.execute.mockRejectedValue(new Error("disk full"));

    prefs.writePref("app:theme", "light");
    await expect(prefs.flushPrefs()).resolves.toBeUndefined();

    expect(prefs.readPref("app:theme")).toBe("light");
  });
});

// Multi-instance: several app processes share one config.db, and each caches
// it in memory. `writePrefMerged` is how a list row survives two instances
// saving their own snapshots; `refreshPrefs` is how one instance's changes
// become visible in another (on window focus — see usePrefsFocusSync).
describe("merged writes", () => {
  /** The database's current row for the WHERE-key select the merge runs. */
  const dbRowIs = (value: string | null) =>
    h.select.mockImplementation(async (sql: string) =>
      sql.includes("WHERE key = ?")
        ? ((value === null ? [] : [{ value }]) as unknown as { key: string; value: string }[])
        : [],
    );

  it("combines the database's row with ours at persist time", async () => {
    await prefs.hydratePrefs();
    dbRowIs("theirs");

    prefs.writePrefMerged("app:recentProjects", "ours", (db, v) => `${db}+${v}`);
    // The synchronous read sees our value before the chain runs…
    expect(prefs.readPref("app:recentProjects")).toBe("ours");
    await prefs.flushPrefs();

    // …and the merged result lands in both the database and the cache.
    expect(upserted()).toContainEqual(["app:recentProjects", "theirs+ours"]);
    expect(prefs.readPref("app:recentProjects")).toBe("theirs+ours");
  });

  it("hands the merge null when the row does not exist yet", async () => {
    await prefs.hydratePrefs();
    dbRowIs(null);

    prefs.writePrefMerged("app:recentProjects", "ours", (db, v) => `${db}+${v}`);
    await prefs.flushPrefs();

    expect(upserted()).toContainEqual(["app:recentProjects", "null+ours"]);
  });

  it("does not let the merged result clobber a later write's cache value", async () => {
    await prefs.hydratePrefs();
    dbRowIs("theirs");

    prefs.writePrefMerged("app:recentProjects", "v1", (db, v) => `${db}+${v}`);
    prefs.writePref("app:recentProjects", "v2");
    await prefs.flushPrefs();

    // The chain persisted both in order — last-call-wins holds in the
    // database — and the cache shows the later value, not the merge of the
    // superseded one.
    expect(
      upserted().filter(([k]) => k === "app:recentProjects").map(([, v]) => v),
    ).toEqual(["theirs+v1", "v2"]);
    expect(prefs.readPref("app:recentProjects")).toBe("v2");
  });
});

describe("refreshPrefs", () => {
  it("adopts another instance's rows and reports the change", async () => {
    h.select.mockResolvedValueOnce([{ key: "app:theme", value: "dark" }]);
    await prefs.hydratePrefs();

    h.select.mockResolvedValueOnce([
      { key: "app:theme", value: "light" },
      { key: "app:language", value: "en" },
    ]);
    await expect(prefs.refreshPrefs()).resolves.toBe(true);

    expect(prefs.readPref("app:theme")).toBe("light");
    expect(prefs.readPref("app:language")).toBe("en");
  });

  it("drops rows another instance deleted", async () => {
    h.select.mockResolvedValueOnce([
      { key: "app:theme", value: "dark" },
      { key: "app:language", value: "en" },
    ]);
    await prefs.hydratePrefs();

    h.select.mockResolvedValueOnce([{ key: "app:theme", value: "dark" }]);
    await expect(prefs.refreshPrefs()).resolves.toBe(true);

    expect(prefs.readPref("app:language")).toBeNull();
  });

  it("reports no change when the database matches the cache", async () => {
    h.select.mockResolvedValueOnce([{ key: "app:theme", value: "dark" }]);
    await prefs.hydratePrefs();

    h.select.mockResolvedValueOnce([{ key: "app:theme", value: "dark" }]);
    // False is what keeps a no-op focus from firing the animated repaint.
    await expect(prefs.refreshPrefs()).resolves.toBe(false);
    expect(prefs.readPref("app:theme")).toBe("dark");
  });

  it("keeps the cache when the re-read fails", async () => {
    h.select.mockResolvedValueOnce([{ key: "app:theme", value: "dark" }]);
    await prefs.hydratePrefs();

    h.select.mockRejectedValueOnce(new Error("locked"));
    await expect(prefs.refreshPrefs()).resolves.toBe(false);
    expect(prefs.readPref("app:theme")).toBe("dark");
  });

  it("is a no-op before hydration", async () => {
    await expect(prefs.refreshPrefs()).resolves.toBe(false);
    expect(h.select).not.toHaveBeenCalled();
  });
});
