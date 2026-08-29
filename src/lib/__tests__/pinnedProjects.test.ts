/**
 * 固定项目 (appStore.pinProject / unpinProject and what the pin changes about
 * the three existing actions).
 *
 * A pin is a promise about *three* other operations, and each of them used to
 * be unconditional: 清空 takes everything, the cap evicts the eleventh entry,
 * ✕ forgets one row. The tests here are that promise — the pure trimming logic
 * lives in `recentProjects.test.ts`; this file is about the store's wiring and
 * the two preference rows it keeps in step.
 *
 * `prunePrefsWithPrefix` is a no-op while prefs are unhydrated (it sweeps the
 * database cache), so the per-project preference collection that rides along
 * with remove/clear is out of scope here — see the comments in appStore.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// appStore is browser code: it reads preferences and stamps `<html>` at import
// time. Same minimal stand-ins aiDrawerMode.test.ts installs — prefs falls back
// to this localStorage while unhydrated, so the rows asserted on below are the
// real writes, not mocks.
vi.hoisted(() => {
  const mem = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  g.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  };
  const noop = () => {};
  g.window = {
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  };
  g.document = {
    documentElement: { setAttribute: noop, getAttribute: () => null },
    addEventListener: noop,
    removeEventListener: noop,
  };
});

import { useAppStore } from "../../stores/appStore";
import { RECENT_PROJECTS_MAX } from "../recentProjects";

const RECENT_KEY = "app:recentProjects";
const PINNED_KEY = "app:pinnedProjects";
const OPENED_KEY = "app:projectOpenedAt";
const HINT_KEY = "app:pinHintDone";

const state = () => useAppStore.getState();
const row = (key: string) => {
  const raw = localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
};
const seed = (recentProjects: string[], pinnedProjects: string[] = []) => {
  useAppStore.setState({ recentProjects, pinnedProjects });
  localStorage.setItem(RECENT_KEY, JSON.stringify(recentProjects));
  localStorage.setItem(PINNED_KEY, JSON.stringify(pinnedProjects));
};
const many = (n: number, prefix = "/p") => Array.from({ length: n }, (_, i) => `${prefix}/${i}`);

beforeEach(() => {
  for (const k of [RECENT_KEY, PINNED_KEY, OPENED_KEY, HINT_KEY]) localStorage.removeItem(k);
  useAppStore.setState({
    recentProjects: [], pinnedProjects: [], projectOpenedAt: {}, pinHintDone: false,
  });
});

describe("pinProject", () => {
  it("appends to its own row, so the rows already pinned do not move", () => {
    seed(["/p/a", "/p/b"]);
    state().pinProject("/p/b");
    state().pinProject("/p/a");
    expect(state().pinnedProjects).toEqual(["/p/b", "/p/a"]);
    expect(row(PINNED_KEY)).toEqual(["/p/b", "/p/a"]);
  });

  it("is idempotent — pinning twice does not duplicate the row", () => {
    seed(["/p/a"]);
    state().pinProject("/p/a");
    localStorage.removeItem(PINNED_KEY);
    state().pinProject("/p/a");
    expect(state().pinnedProjects).toEqual(["/p/a"]);
    expect(row(PINNED_KEY)).toBe(null); // no second write
  });

  it("leaves the recents row alone — the pin is a marker, not a move", () => {
    seed(["/p/a", "/p/b"]);
    state().pinProject("/p/b");
    expect(state().recentProjects).toEqual(["/p/a", "/p/b"]);
  });
});

describe("clearRecentProjects", () => {
  it("keeps the pinned projects and drops the rest", () => {
    seed(["/p/a", "/p/pin", "/p/b"], ["/p/pin"]);
    state().clearRecentProjects();
    expect(state().recentProjects).toEqual(["/p/pin"]);
    expect(row(RECENT_KEY)).toEqual(["/p/pin"]);
    expect(state().pinnedProjects).toEqual(["/p/pin"]); // the pin row is untouched
  });

  it("still empties the row completely when nothing is pinned", () => {
    seed(["/p/a", "/p/b"]);
    state().clearRecentProjects();
    expect(state().recentProjects).toEqual([]);
    expect(row(RECENT_KEY)).toBe(null);
  });
});

describe("removeRecentProject", () => {
  it("releases the pin too — ✕ means forget this project", () => {
    seed(["/p/a", "/p/pin"], ["/p/pin"]);
    state().removeRecentProject("/p/pin");
    expect(state().recentProjects).toEqual(["/p/a"]);
    expect(state().pinnedProjects).toEqual([]);
    expect(row(PINNED_KEY)).toEqual([]);
  });

  it("does not touch the pin row when the removed project was not pinned", () => {
    seed(["/p/a", "/p/pin"], ["/p/pin"]);
    localStorage.removeItem(PINNED_KEY);
    state().removeRecentProject("/p/a");
    expect(row(PINNED_KEY)).toBe(null);
    expect(state().pinnedProjects).toEqual(["/p/pin"]);
  });
});

describe("addRecentProject", () => {
  it("evicts an unpinned entry rather than the pinned one at the tail", () => {
    seed([...many(RECENT_PROJECTS_MAX), "/p/pin"], ["/p/pin"]);
    state().addRecentProject("/p/fresh");
    const next = state().recentProjects;
    expect(next[0]).toBe("/p/fresh");
    expect(next).toContain("/p/pin");
    expect(next).not.toContain(`/p/${RECENT_PROJECTS_MAX - 1}`); // the oldest unpinned one goes
    expect(next).toHaveLength(RECENT_PROJECTS_MAX + 1);
  });
});

describe("unpinProject", () => {
  it("puts the entry back under the cap immediately", () => {
    seed([...many(RECENT_PROJECTS_MAX), "/p/pin"], ["/p/pin"]);
    state().unpinProject("/p/pin");
    expect(state().pinnedProjects).toEqual([]);
    expect(state().recentProjects).toHaveLength(RECENT_PROJECTS_MAX);
    expect(state().recentProjects).not.toContain("/p/pin"); // it was the eleventh
    expect(row(RECENT_KEY)).toHaveLength(RECENT_PROJECTS_MAX);
  });

  it("writes nothing extra when the list was already within the cap", () => {
    seed(["/p/a", "/p/pin"], ["/p/pin"]);
    localStorage.removeItem(RECENT_KEY);
    state().unpinProject("/p/pin");
    expect(state().recentProjects).toEqual(["/p/a", "/p/pin"]);
    expect(row(RECENT_KEY)).toBe(null);
    expect(row(PINNED_KEY)).toEqual([]);
  });

  it("ignores a path that was not pinned", () => {
    seed(["/p/a"], ["/p/pin"]);
    localStorage.removeItem(PINNED_KEY);
    state().unpinProject("/p/a");
    expect(state().pinnedProjects).toEqual(["/p/pin"]);
    expect(row(PINNED_KEY)).toBe(null);
  });
});

describe("clear · undo · collect", () => {
  it("returns the list as it was, so the panel can offer an undo", () => {
    seed(["/p/a", "/p/pin", "/p/b"], ["/p/pin"]);
    expect(state().clearRecentProjects()).toEqual(["/p/a", "/p/pin", "/p/b"]);
    expect(state().recentProjects).toEqual(["/p/pin"]);
  });

  it("answers empty when there was nothing unpinned to clear", () => {
    seed(["/p/pin"], ["/p/pin"]);
    expect(state().clearRecentProjects()).toEqual([]);
  });

  it("leaves the dropped projects' stamps alone until the window closes", () => {
    seed(["/p/a", "/p/pin"], ["/p/pin"]);
    useAppStore.setState({ projectOpenedAt: { "/p/a": 111, "/p/pin": 222 } });
    state().clearRecentProjects();
    // Still there: an undo five seconds later has to hand back a whole project.
    expect(state().projectOpenedAt).toEqual({ "/p/a": 111, "/p/pin": 222 });
    state().collectUnlistedProjectPrefs();
    expect(state().projectOpenedAt).toEqual({ "/p/pin": 222 });
    expect(row(OPENED_KEY)).toEqual({ "/p/pin": 222 });
  });

  it("restores the previous list verbatim", () => {
    seed(["/p/a", "/p/pin", "/p/b"], ["/p/pin"]);
    const previous = state().clearRecentProjects();
    state().restoreRecentProjects(previous);
    expect(state().recentProjects).toEqual(["/p/a", "/p/pin", "/p/b"]);
    expect(row(RECENT_KEY)).toEqual(["/p/a", "/p/pin", "/p/b"]);
  });

  it("collects nothing while every project is still listed", () => {
    seed(["/p/a"], ["/p/pin"]);
    useAppStore.setState({ projectOpenedAt: { "/p/a": 1, "/p/pin": 2 } });
    localStorage.removeItem(OPENED_KEY);
    state().collectUnlistedProjectPrefs();
    expect(row(OPENED_KEY)).toBe(null); // no write when nothing changed
  });
});

describe("opened-at stamps", () => {
  it("are written when a project is opened", () => {
    const before = Date.now();
    state().addRecentProject("/p/a");
    const stamped = state().projectOpenedAt["/p/a"];
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(row(OPENED_KEY)).toEqual({ "/p/a": stamped });
  });

  it("are dropped when the project is removed from the list", () => {
    seed(["/p/a", "/p/b"]);
    useAppStore.setState({ projectOpenedAt: { "/p/a": 1, "/p/b": 2 } });
    state().removeRecentProject("/p/a");
    expect(state().projectOpenedAt).toEqual({ "/p/b": 2 });
  });
});

describe("the pin hint", () => {
  it("retires for good on the first successful pin", () => {
    seed(["/p/a"]);
    expect(state().pinHintDone).toBe(false);
    state().pinProject("/p/a");
    expect(state().pinHintDone).toBe(true);
    expect(localStorage.getItem(HINT_KEY)).toBe("1");
  });

  it("stays retired after the project is unpinned again", () => {
    seed(["/p/a"]);
    state().pinProject("/p/a");
    state().unpinProject("/p/a");
    expect(state().pinHintDone).toBe(true);
  });
});
