/**
 * projectStore's workspace lifecycle.
 *
 * The store is the *only* writer of both the React-visible `workspace` field
 * and the `lib/profile/active` module singleton that non-React code reads, so
 * the invariant worth pinning is that they never disagree — including on the
 * paths where an open fails halfway. The ordering comments in the store
 * assert that; these tests hold them to it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Ordered log of the side effects whose *sequence* is the thing under test. */
  calls: [] as string[],
  openProjectFolder: vi.fn(async () => "D:/projects/book"),
  registerProjectRoot: vi.fn(async () => {}),
  scaffoldProject: vi.fn(async (_p: string, _c: string[]) => {}),
  readDirRecursive: vi.fn(async () => []),
  getDb: vi.fn(async () => ({})),
  resetDb: vi.fn(() => {}),
  loadProfileFileMock: vi.fn(async (_p: string) => null as unknown),
  saveProfileFileMock: vi.fn(async (_p: string, _sel: unknown) => {}),
  scanProject: vi.fn(async (_p: string) => {}),
  addRecentProject: vi.fn(() => {}),
  removeRecentProject: vi.fn(() => {}),
}));

vi.mock("../project", () => ({
  openProjectFolder: h.openProjectFolder,
  registerProjectRoot: h.registerProjectRoot,
  scaffoldProject: (p: string, c: string[]) => {
    h.calls.push("scaffold");
    return h.scaffoldProject(p, c);
  },
  readDirRecursive: h.readDirRecursive,
  getDb: h.getDb,
  resetDb: h.resetDb,
}));

// The profile *module* is mocked only for its two IO functions; the real
// active-workspace singleton, resolver and built-ins are kept, since the whole
// point is to observe what the store does to that singleton.
vi.mock("../profile", async () => {
  const actual = await vi.importActual<typeof import("../profile")>("../profile");
  return {
    ...actual,
    loadProfileFile: h.loadProfileFileMock,
    saveProfileFile: (p: string, sel: unknown) => {
      h.calls.push("save");
      return h.saveProfileFileMock(p, sel);
    },
  };
});

vi.mock("../fs/fileio", () => ({
  fileExists: vi.fn(async () => false),
  makeDir: vi.fn(async () => {}),
  removeDir: vi.fn(async () => {}),
  removeFile: vi.fn(async () => {}),
  renamePath: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}));
vi.mock("../agent/backup", () => ({ backupFile: vi.fn(async () => null) }));

vi.mock("../../stores/loreStore", () => ({
  useLoreStore: {
    getState: () => ({
      saveTimer: null,
      isDirty: false,
      selectedEntity: null,
      selectedFile: null,
      saveNow: vi.fn(),
      scanProject: (p: string) => {
        h.calls.push("scanLore");
        return h.scanProject(p);
      },
    }),
    setState: vi.fn(),
  },
}));
vi.mock("../../stores/editorStore", () => ({
  useEditorStore: {
    getState: () => ({ saveTimer: null, isDirty: false, filePath: null, saveNow: vi.fn() }),
    setState: vi.fn(),
  },
}));
vi.mock("../../stores/appStore", () => ({
  useAppStore: {
    getState: () => ({
      addRecentProject: h.addRecentProject,
      removeRecentProject: h.removeRecentProject,
    }),
  },
}));

import { useProjectStore } from "../../stores/projectStore";
import { activeWorkspace, loreCategoryIds, resetActiveWorkspace } from "../profile/active";
import { BID_PROFILE, NOVEL_PROFILE, TTRPG_PROFILE } from "../profile/model";
import type { ProfileSelection } from "../profile/file";

/** Category ids scaffoldProject was last asked to create. */
function lastScaffoldCategories(): string[] {
  const { calls } = h.scaffoldProject.mock;
  return calls.length > 0 ? calls[calls.length - 1][1] : [];
}

/** The ids of the packs currently active in the module singleton. */
const activePackIds = () => activeWorkspace().enabled.map((p) => p.id);

/** A selection, as loadProfileFile would return it. */
function selectionOf(...packs: (typeof NOVEL_PROFILE)[]): ProfileSelection {
  return { enabled: packs, customPacks: [], customCategories: [], issues: [] };
}

beforeEach(() => {
  h.calls.length = 0;
  vi.clearAllMocks();
  h.loadProfileFileMock.mockResolvedValue(null);
  h.getDb.mockResolvedValue({});
  useProjectStore.setState({ projectPath: null, customPacks: [], customCategories: [] });
  resetActiveWorkspace();
});

afterEach(() => resetActiveWorkspace());

describe("openProject", () => {
  it("activates the project's packs and scaffolds their categories", async () => {
    h.loadProfileFileMock.mockResolvedValue(selectionOf(TTRPG_PROFILE));

    await useProjectStore.getState().openProject("D:/projects/module");

    expect(activePackIds()).toEqual(["ttrpg"]);
    expect(lastScaffoldCategories()).toEqual([
      ...TTRPG_PROFILE.categories.map((c) => c.id),
      "custom",
    ]);
  });

  it("scaffolds the union of a multi-pack selection's categories", async () => {
    h.loadProfileFileMock.mockResolvedValue(selectionOf(NOVEL_PROFILE, BID_PROFILE));

    await useProjectStore.getState().openProject("D:/projects/kb");

    expect(activePackIds()).toEqual(["novel", "bid"]);
    const novelIds = NOVEL_PROFILE.categories.map((c) => c.id);
    const scaffolded = lastScaffoldCategories();
    // First pack's categories first, then the bid pack's novel ones — deduped.
    expect(scaffolded.slice(0, novelIds.length)).toEqual(novelIds);
    expect(scaffolded).toContain("capabilities");
    expect(new Set(scaffolded).size).toBe(scaffolded.length);
    expect(loreCategoryIds()).toEqual(scaffolded);
  });

  it("carries the project's user-defined categories into the workspace", async () => {
    h.loadProfileFileMock.mockResolvedValue({
      enabled: [NOVEL_PROFILE],
      customPacks: [],
      customCategories: [{ id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" }],
      issues: [],
    } satisfies ProfileSelection);

    await useProjectStore.getState().openProject("D:/projects/kb");

    expect(loreCategoryIds()).toContain("meetings");
    expect(useProjectStore.getState().customCategories.map((c) => c.id)).toEqual(["meetings"]);
    expect(lastScaffoldCategories()).toContain("meetings");
  });

  it("treats a project with no profile.json as a novel project", async () => {
    await useProjectStore.getState().openProject("D:/projects/old-book");

    expect(activePackIds()).toEqual(["novel"]);
    expect(lastScaffoldCategories()).toEqual([
      ...NOVEL_PROFILE.categories.map((c) => c.id),
      "custom",
    ]);
  });

  it("scaffolds before the lore scan, so the folders exist when it runs", async () => {
    h.loadProfileFileMock.mockResolvedValue(selectionOf(TTRPG_PROFILE));
    await useProjectStore.getState().openProject("D:/projects/module");
    expect(h.calls.indexOf("scaffold")).toBeLessThan(h.calls.indexOf("scanLore"));
  });

  it("leaves the previous project's workspace active when the open fails", async () => {
    // The failure has to land *after* the selection is resolved, which is the
    // window the store's ordering comment is about: activating early would point
    // the still-open project's lore/prompt code at the failed project.
    const previous = useProjectStore.getState();
    await previous.openProject("D:/projects/module");
    h.loadProfileFileMock.mockResolvedValue(selectionOf(TTRPG_PROFILE));
    h.getDb.mockRejectedValueOnce(new Error("db is corrupt"));

    await expect(useProjectStore.getState().openProject("D:/projects/broken")).rejects.toThrow(
      "db is corrupt",
    );

    expect(activePackIds()).toEqual(["novel"]);
    // ...and the path that failed is dropped from recents.
    expect(h.removeRecentProject).toHaveBeenCalledWith("D:/projects/broken");
  });
});

describe("closeProject", () => {
  it("resets the workspace so nothing still reads the closed project's categories", async () => {
    h.loadProfileFileMock.mockResolvedValue(selectionOf(TTRPG_PROFILE));
    await useProjectStore.getState().openProject("D:/projects/module");
    expect(activePackIds()).toEqual(["ttrpg"]);

    await useProjectStore.getState().closeProject();

    expect(activePackIds()).toEqual(["novel"]);
    expect(useProjectStore.getState().projectPath).toBeNull();
  });
});

describe("setPacks", () => {
  beforeEach(async () => {
    await useProjectStore.getState().openProject("D:/projects/book");
    h.calls.length = 0;
    vi.clearAllMocks();
  });

  it("persists, activates, scaffolds the new categories, and rescans lore", async () => {
    await useProjectStore.getState().setPacks(["ttrpg"]);

    expect(activePackIds()).toEqual(["ttrpg"]);
    expect(h.saveProfileFileMock).toHaveBeenCalledWith(
      "D:/projects/book",
      expect.objectContaining({ enabled: [TTRPG_PROFILE] }),
    );
    expect(lastScaffoldCategories()).toEqual([
      ...TTRPG_PROFILE.categories.map((c) => c.id),
      "custom",
    ]);
    // The lore index is keyed by category, so a rescan is not optional.
    expect(h.scanProject).toHaveBeenCalledWith("D:/projects/book");
  });

  it("enables a second pack: categories union, tasks union", async () => {
    await useProjectStore.getState().setPacks(["novel", "bid"]);

    const { workspace } = useProjectStore.getState();
    expect(workspace.enabled).toEqual([NOVEL_PROFILE, BID_PROFILE]);
    // The bid pack's tasks joined the menu, tagged with their pack...
    const respond = workspace.tasks.find((t) => t.id === "respond");
    expect(respond?.packId).toBe("bid");
    // ...while a base task keeps its base identity (novel's override tags it).
    expect(workspace.tasks.find((t) => t.id === "continue")?.packId).toBe("novel");
    expect(lastScaffoldCategories()).toContain("qualifications");
  });

  it("supports disabling every pack — a packs-free project stays usable", async () => {
    await useProjectStore.getState().setPacks([]);
    expect(activePackIds()).toEqual([]);
    // The base menu and the custom bucket survive with nothing enabled.
    expect(useProjectStore.getState().workspace.tasks.some((t) => t.id === "continue")).toBe(true);
    expect(lastScaffoldCategories()).toEqual(["custom"]);
  });

  it("writes profile.json before touching anything else", async () => {
    // If the write fails, nothing else has moved and the next open still
    // resolves the previous selection — which only holds if it goes first.
    await useProjectStore.getState().setPacks(["ttrpg"]);
    expect(h.calls).toEqual(["save", "scaffold", "scanLore"]);
  });

  it("leaves the workspace alone when persisting it fails", async () => {
    h.saveProfileFileMock.mockRejectedValueOnce(new Error("disk full"));

    await expect(useProjectStore.getState().setPacks(["ttrpg"])).rejects.toThrow("disk full");

    expect(activePackIds()).toEqual(["novel"]);
    expect(h.scaffoldProject).not.toHaveBeenCalled();
    expect(h.scanProject).not.toHaveBeenCalled();
  });

  it("is a no-op when the selection is already active", async () => {
    await useProjectStore.getState().setPacks(["novel"]);
    expect(h.saveProfileFileMock).not.toHaveBeenCalled();
    expect(h.scaffoldProject).not.toHaveBeenCalled();
  });

  it("rejects an unknown pack id without touching anything", async () => {
    await expect(useProjectStore.getState().setPacks(["nope"])).rejects.toThrow(
      /Unknown pack/,
    );
    expect(h.saveProfileFileMock).not.toHaveBeenCalled();
  });

  it("refuses to change packs with no project open", async () => {
    await useProjectStore.getState().closeProject();
    await expect(useProjectStore.getState().setPacks(["ttrpg"])).rejects.toThrow(
      /Open a project/,
    );
    expect(h.saveProfileFileMock).not.toHaveBeenCalled();
  });
});

describe("setCustomCategories", () => {
  beforeEach(async () => {
    await useProjectStore.getState().openProject("D:/projects/book");
    h.calls.length = 0;
    vi.clearAllMocks();
  });

  it("persists, activates, scaffolds and rescans, in that order", async () => {
    await useProjectStore
      .getState()
      .setCustomCategories([{ id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" }]);

    expect(h.calls).toEqual(["save", "scaffold", "scanLore"]);
    expect(loreCategoryIds()).toContain("meetings");
    expect(useProjectStore.getState().customCategories.map((c) => c.id)).toEqual(["meetings"]);
    expect(h.saveProfileFileMock).toHaveBeenCalledWith(
      "D:/projects/book",
      expect.objectContaining({
        customCategories: [{ id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" }],
      }),
    );
    expect(lastScaffoldCategories()).toContain("meetings");
  });

  it("rejects an invalid category id without touching anything", async () => {
    await expect(
      useProjectStore
        .getState()
        .setCustomCategories([{ id: "../escape", labelZh: "坏", labelEn: "bad" }]),
    ).rejects.toThrow(/Invalid categories/);
    expect(h.saveProfileFileMock).not.toHaveBeenCalled();
    expect(loreCategoryIds()).not.toContain("../escape");
  });

  it("is a no-op when the list is unchanged", async () => {
    const cats = [{ id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" }];
    await useProjectStore.getState().setCustomCategories(cats);
    vi.clearAllMocks();
    await useProjectStore.getState().setCustomCategories(cats);
    expect(h.saveProfileFileMock).not.toHaveBeenCalled();
  });

  it("keeps the pack selection intact while categories change", async () => {
    await useProjectStore.getState().setPacks(["novel", "bid"]);
    await useProjectStore
      .getState()
      .setCustomCategories([{ id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" }]);
    expect(activePackIds()).toEqual(["novel", "bid"]);
    expect(loreCategoryIds()).toContain("meetings");
    expect(loreCategoryIds()).toContain("qualifications");
  });
});
