/**
 * projectStore's workspace-profile lifecycle.
 *
 * The store is the *only* writer of both the React-visible `profile` field and
 * the `lib/profile/active` module singleton that non-React code reads, so the
 * invariant worth pinning is that the two never disagree — including on the
 * paths where an open fails halfway. The ordering comments in the store assert
 * that; these tests hold them to it.
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
  loadProfileMock: vi.fn(async (_p: string) => null as unknown),
  saveProfileMock: vi.fn(async (_p: string, _prof: unknown) => {}),
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
// active-profile singleton and the real built-ins are kept, since the whole
// point is to observe what the store does to that singleton.
vi.mock("../profile", async () => {
  const actual = await vi.importActual<typeof import("../profile")>("../profile");
  return {
    ...actual,
    loadProfile: h.loadProfileMock,
    saveProfile: (p: string, prof: unknown) => {
      h.calls.push("save");
      return h.saveProfileMock(p, prof);
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
import { activeProfile, resetActiveProfile } from "../profile/active";
import { NOVEL_PROFILE, TTRPG_PROFILE } from "../profile/model";

/** Category ids scaffoldProject was last asked to create. */
function lastScaffoldCategories(): string[] {
  const { calls } = h.scaffoldProject.mock;
  return calls.length > 0 ? calls[calls.length - 1][1] : [];
}

beforeEach(() => {
  h.calls.length = 0;
  vi.clearAllMocks();
  h.loadProfileMock.mockResolvedValue(null);
  h.getDb.mockResolvedValue({});
  useProjectStore.setState({ projectPath: null, profile: NOVEL_PROFILE });
  resetActiveProfile();
});

afterEach(() => resetActiveProfile());

describe("openProject", () => {
  it("activates the project's profile and scaffolds that profile's categories", async () => {
    h.loadProfileMock.mockResolvedValue(TTRPG_PROFILE);

    await useProjectStore.getState().openProject("D:/projects/module");

    expect(useProjectStore.getState().profile).toBe(TTRPG_PROFILE);
    expect(activeProfile()).toBe(TTRPG_PROFILE);
    expect(lastScaffoldCategories()).toEqual(TTRPG_PROFILE.categories.map((c) => c.id));
  });

  it("treats a project with no profile.json as a novel project", async () => {
    await useProjectStore.getState().openProject("D:/projects/old-book");

    expect(activeProfile()).toBe(NOVEL_PROFILE);
    expect(lastScaffoldCategories()).toEqual(NOVEL_PROFILE.categories.map((c) => c.id));
  });

  it("scaffolds before the lore scan, so the folders exist when it runs", async () => {
    h.loadProfileMock.mockResolvedValue(TTRPG_PROFILE);
    await useProjectStore.getState().openProject("D:/projects/module");
    expect(h.calls.indexOf("scaffold")).toBeLessThan(h.calls.indexOf("scanLore"));
  });

  it("leaves the previous project's profile active when the open fails", async () => {
    // The failure has to land *after* the profile is resolved, which is the
    // window the store's ordering comment is about: activating early would point
    // the still-open project's lore/prompt code at the failed project.
    const previous = useProjectStore.getState();
    await previous.openProject("D:/projects/module");
    h.loadProfileMock.mockResolvedValue(TTRPG_PROFILE);
    h.getDb.mockRejectedValueOnce(new Error("db is corrupt"));

    await expect(useProjectStore.getState().openProject("D:/projects/broken")).rejects.toThrow(
      "db is corrupt",
    );

    expect(activeProfile()).toBe(NOVEL_PROFILE);
    expect(useProjectStore.getState().profile).toBe(NOVEL_PROFILE);
    // ...and the path that failed is dropped from recents.
    expect(h.removeRecentProject).toHaveBeenCalledWith("D:/projects/broken");
  });
});

describe("closeProject", () => {
  it("resets the active profile so nothing still reads the closed project's categories", async () => {
    h.loadProfileMock.mockResolvedValue(TTRPG_PROFILE);
    await useProjectStore.getState().openProject("D:/projects/module");
    expect(activeProfile()).toBe(TTRPG_PROFILE);

    await useProjectStore.getState().closeProject();

    expect(activeProfile()).toBe(NOVEL_PROFILE);
    expect(useProjectStore.getState().profile).toBe(NOVEL_PROFILE);
    expect(useProjectStore.getState().projectPath).toBeNull();
  });
});

describe("setProfile", () => {
  beforeEach(async () => {
    await useProjectStore.getState().openProject("D:/projects/book");
    h.calls.length = 0;
    vi.clearAllMocks();
  });

  it("persists, activates, scaffolds the new categories, and rescans lore", async () => {
    await useProjectStore.getState().setProfile(TTRPG_PROFILE);

    expect(activeProfile()).toBe(TTRPG_PROFILE);
    expect(useProjectStore.getState().profile).toBe(TTRPG_PROFILE);
    expect(h.saveProfileMock).toHaveBeenCalledWith("D:/projects/book", TTRPG_PROFILE);
    expect(lastScaffoldCategories()).toEqual(TTRPG_PROFILE.categories.map((c) => c.id));
    // The lore index is keyed by category, so a rescan is not optional.
    expect(h.scanProject).toHaveBeenCalledWith("D:/projects/book");
  });

  it("writes profile.json before touching anything else", async () => {
    // If the write fails, nothing else has moved and the next open still
    // resolves the previous profile — which only holds if it goes first.
    await useProjectStore.getState().setProfile(TTRPG_PROFILE);
    expect(h.calls).toEqual(["save", "scaffold", "scanLore"]);
  });

  it("leaves the profile alone when persisting it fails", async () => {
    h.saveProfileMock.mockRejectedValueOnce(new Error("disk full"));

    await expect(useProjectStore.getState().setProfile(TTRPG_PROFILE)).rejects.toThrow("disk full");

    expect(activeProfile()).toBe(NOVEL_PROFILE);
    expect(useProjectStore.getState().profile).toBe(NOVEL_PROFILE);
    expect(h.scaffoldProject).not.toHaveBeenCalled();
    expect(h.scanProject).not.toHaveBeenCalled();
  });

  it("is a no-op when the profile is already active", async () => {
    await useProjectStore.getState().setProfile(NOVEL_PROFILE);
    expect(h.saveProfileMock).not.toHaveBeenCalled();
    expect(h.scaffoldProject).not.toHaveBeenCalled();
  });

  it("refuses to set a profile with no project open", async () => {
    await useProjectStore.getState().closeProject();
    await expect(useProjectStore.getState().setProfile(TTRPG_PROFILE)).rejects.toThrow(
      /Open a project/,
    );
    expect(h.saveProfileMock).not.toHaveBeenCalled();
  });
});
