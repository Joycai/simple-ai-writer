/**
 * Navigation history (stores/navStore).
 *
 * The store records by *observing* the three stores that own a location, so
 * these tests navigate the way the app does — by calling the same setters the
 * file tree, the lore wall and the icon rail call — and never touch navStore
 * except to step back and forward.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The test environment is node, but this store's collaborators are browser
// code: appStore reads localStorage and stamps `<html>` at import time, and
// installNavigationHistory listens for the mouse's back/forward buttons.
// Minimal stand-ins, installed before the imports below run.
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

vi.mock("../project", () => ({
  openProjectFolder: vi.fn(async () => null),
  registerProjectRoot: vi.fn(async () => {}),
  scaffoldProject: vi.fn(async () => {}),
  readDirRecursive: vi.fn(async () => []),
  getDb: vi.fn(async () => ({})),
  resetDb: vi.fn(() => {}),
}));

import { useAppStore } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import {
  installNavigationHistory,
  navBack,
  navForward,
  replaceLocation,
  useNavStore,
} from "../../stores/navStore";

const openFile = (path: string | null) => useProjectStore.getState().setActiveFilePath(path);
const openWall = () => useAppStore.getState().setMainView("lore-wall");
const openEditor = () => useAppStore.getState().setMainView("editor");
const openEntity = (dir: string | null) => useLoreStore.getState().openDetail(dir);

const activeFile = () => useProjectStore.getState().activeFilePath;
const mainView = () => useAppStore.getState().mainView;
const detailPath = () => useLoreStore.getState().detailPath;

let uninstall: () => void;

beforeEach(() => {
  useAppStore.setState({ mainView: "editor", showSettings: false, showCommandPalette: false, showOnboarding: false });
  useProjectStore.setState({ activeFilePath: null, projectPath: "D:/book" });
  useLoreStore.setState({ detailPath: null, detailEditing: false });
  uninstall = installNavigationHistory();
});

afterEach(() => uninstall());

describe("navigation history", () => {
  it("steps back and forward through opened files", () => {
    openFile("a.md");
    openFile("b.md");

    navBack();
    expect(activeFile()).toBe("a.md");
    navBack();
    expect(activeFile()).toBe(null);

    navForward();
    expect(activeFile()).toBe("a.md");
    navForward();
    expect(activeFile()).toBe("b.md");
  });

  it("does nothing at the ends of the history", () => {
    navBack();
    expect(activeFile()).toBe(null);
    openFile("a.md");
    navForward();
    expect(activeFile()).toBe("a.md");
  });

  it("treats the main view and the open lore entry as part of the location", () => {
    openFile("a.md");
    openWall();
    openEntity("/lore/characters/lin");

    navBack();
    expect(mainView()).toBe("lore-wall");
    expect(detailPath()).toBe(null);

    navBack();
    expect(mainView()).toBe("editor");
    expect(activeFile()).toBe("a.md");

    navForward();
    navForward();
    expect(mainView()).toBe("lore-wall");
    expect(detailPath()).toBe("/lore/characters/lin");
  });

  it("does not record the steps it replays", () => {
    openFile("a.md");
    openFile("b.md");
    const depth = useNavStore.getState().past.length;

    navBack();
    navForward();
    expect(useNavStore.getState().past.length).toBe(depth);
    expect(useNavStore.getState().future).toHaveLength(0);
  });

  it("drops the forward branch once the author navigates somewhere new", () => {
    openFile("a.md");
    openFile("b.md");
    navBack();
    expect(useNavStore.getState().future).toHaveLength(1);

    openFile("c.md");
    expect(useNavStore.getState().future).toHaveLength(0);
    navBack();
    expect(activeFile()).toBe("a.md");
  });

  it("ignores re-navigating to the location already showing", () => {
    openFile("a.md");
    const depth = useNavStore.getState().past.length;
    openFile("a.md");
    openEditor();
    expect(useNavStore.getState().past.length).toBe(depth);
  });

  it("starts over when another project is opened", () => {
    openFile("a.md");
    openFile("b.md");
    useProjectStore.setState({ projectPath: "D:/other" });

    expect(useNavStore.getState().past).toHaveLength(0);
    expect(useNavStore.getState().future).toHaveLength(0);
    navBack();
    expect(activeFile()).toBe("b.md");
  });

  it("re-addresses the current location without adding a step", () => {
    // Moving a lore entry to another category renames its folder while the
    // author is still looking at it.
    openWall();
    openEntity("/lore/characters/lin");
    const depth = useNavStore.getState().past.length;

    replaceLocation(() => openEntity("/lore/factions/lin"));
    expect(useNavStore.getState().past.length).toBe(depth);

    navBack();
    expect(detailPath()).toBe(null);
    navForward();
    expect(detailPath()).toBe("/lore/factions/lin");
  });

  it("stays put while a blocking overlay is open", () => {
    openFile("a.md");
    openFile("b.md");
    useAppStore.setState({ showSettings: true });

    navBack();
    expect(activeFile()).toBe("b.md");

    useAppStore.setState({ showSettings: false });
    navBack();
    expect(activeFile()).toBe("a.md");
  });
});
