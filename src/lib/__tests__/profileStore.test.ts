/**
 * `.ai-writer/profile.json` persistence.
 *
 * `parseProfile` is covered in profile.test.ts and the v1/v2/v3 file shapes in
 * profileFile.test.ts, both with everything handed in explicitly; what is only
 * exercised here is the filesystem wiring — path normalisation, absence and
 * unreadability degrading to null, and the v3 write format (bare ids for
 * built-ins, full custom packs, user categories).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above module scope, so the fake fs has to be built inside
// vi.hoisted for the factory to be able to close over it.
const { files, readFile, writeFile, makeDir, fileExists } = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    readFile: vi.fn(async (path: string) => {
      const body = files.get(path);
      if (body === undefined) throw new Error(`ENOENT: ${path}`);
      return body;
    }),
    writeFile: vi.fn(async (path: string, body: string) => void files.set(path, body)),
    makeDir: vi.fn(async () => {}),
    fileExists: vi.fn(async (path: string) => files.has(path)),
  };
});

vi.mock("../fs/fileio", () => ({ readFile, writeFile, makeDir, fileExists }));

import { loadProfileFile, saveProfileFile } from "../profile/store";
import { BID_PROFILE, NOVEL_PROFILE, TTRPG_PROFILE, type WorkspaceProfile } from "../profile/model";

const ROOT = "D:/projects/my-book";
const PROFILE_PATH = `${ROOT}/.ai-writer/profile.json`;

beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
});

describe("loadProfileFile", () => {
  it("returns null when the project has no profile.json", async () => {
    // Absence is the normal case for a project predating profiles, and it must
    // read as "novel" rather than as an error.
    expect(await loadProfileFile(ROOT)).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("resolves a minimal v1 file naming a builtin to that builtin, alone", async () => {
    // The regression this file exists for: without the builtinProfile(declaredId)
    // lookup, every field the file omits would inherit NOVEL_PROFILE and a TTRPG
    // project would silently get novel task wording in its prompts.
    files.set(PROFILE_PATH, JSON.stringify({ id: "ttrpg" }));
    const selection = await loadProfileFile(ROOT);
    expect(selection?.enabled).toEqual([TTRPG_PROFILE]);
    // Nothing beyond the id — resolves to the built-in exactly, so there is no
    // custom pack to carry.
    expect(selection?.customPacks).toEqual([]);
  });

  it("keeps a customised v1 file as a custom pack", async () => {
    files.set(PROFILE_PATH, JSON.stringify({ id: "ttrpg", sections: { outline: "推进方向" } }));
    const selection = await loadProfileFile(ROOT);
    expect(selection?.enabled[0].sections.outline).toBe("推进方向");
    // Not reverted to the novel defaults just because the file named `sections`.
    expect(selection?.enabled[0].sections.prevTail).toBe(TTRPG_PROFILE.sections.prevTail);
    // The customisation must survive a future save.
    expect(selection?.customPacks).toEqual([selection?.enabled[0]]);
  });

  it("resolves a v2 file's enabled builtins by bare id, primary first", async () => {
    files.set(
      PROFILE_PATH,
      JSON.stringify({ version: 2, primary: "bid", enabled: ["novel", "bid"] }),
    );
    const selection = await loadProfileFile(ROOT);
    expect(selection?.enabled).toEqual([BID_PROFILE, NOVEL_PROFILE]);
    expect(selection?.customPacks).toEqual([]);
  });

  it("degrades to null on malformed JSON instead of throwing", async () => {
    // This runs inside the project-open path: a bad profile must not stop the
    // author from opening their project.
    files.set(PROFILE_PATH, "{ not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadProfileFile(ROOT)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("degrades to null when the file cannot be read", async () => {
    fileExists.mockResolvedValueOnce(true);
    readFile.mockRejectedValueOnce(new Error("EACCES"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadProfileFile(ROOT)).toBeNull();
    warn.mockRestore();
  });

  it("still returns a usable selection when the file has problems, and says so", async () => {
    files.set(PROFILE_PATH, JSON.stringify({ id: "ttrpg", categories: [{ id: "../escape" }] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const selection = await loadProfileFile(ROOT);
    expect(selection?.enabled[0].categories).toEqual(TTRPG_PROFILE.categories);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("escape"), ...[]);
    warn.mockRestore();
  });

  it("normalises a Windows project path to a forward-slash profile.json path", async () => {
    files.set(PROFILE_PATH, JSON.stringify({ id: "ttrpg" }));
    await loadProfileFile("D:\\projects\\my-book");
    expect(fileExists).toHaveBeenCalledWith(PROFILE_PATH);
    expect(readFile).toHaveBeenCalledWith(PROFILE_PATH);
  });
});

describe("saveProfileFile", () => {
  it("writes v3 with bare ids for builtins and creates .ai-writer first", async () => {
    await saveProfileFile(ROOT, {
      enabled: [TTRPG_PROFILE, BID_PROFILE],
      customPacks: [],
      customCategories: [],
      issues: [],
    });
    expect(makeDir).toHaveBeenCalledWith(`${ROOT}/.ai-writer`);
    const body = JSON.parse(files.get(PROFILE_PATH)!);
    expect(body).toEqual({ version: 3, enabled: ["ttrpg", "bid"] });
  });

  it("round-trips the user-defined categories", async () => {
    await saveProfileFile(ROOT, {
      enabled: [NOVEL_PROFILE],
      customPacks: [],
      customCategories: [{ id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" }],
      issues: [],
    });
    const body = JSON.parse(files.get(PROFILE_PATH)!);
    expect(body.categories).toEqual([{ id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" }]);
    const selection = await loadProfileFile(ROOT);
    expect(selection?.customCategories).toEqual([
      { id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" },
    ]);
  });

  it("round-trips an empty selection — a packs-free project stays packs-free", async () => {
    await saveProfileFile(ROOT, {
      enabled: [],
      customPacks: [],
      customCategories: [],
      issues: [],
    });
    const selection = await loadProfileFile(ROOT);
    expect(selection?.enabled).toEqual([]);
  });

  it("round-trips a custom pack through loadProfileFile", async () => {
    const custom: WorkspaceProfile = {
      id: "customdomain",
      labelZh: "自定领域",
      labelEn: "Custom Domain",
      categories: [{ id: "projects", labelZh: "项目", labelEn: "Projects" }],
      sections: { outline: "背景要求" },
      // A single freeform task, to prove the round-trip carries a task list that
      // isn't the built-in one.
      tasks: [{ id: "draft", labelZh: "起草", labelEn: "Draft", tools: "none",
                target: "detached", freeform: true }],
    };
    await saveProfileFile(ROOT, {
      enabled: [custom, NOVEL_PROFILE],
      customPacks: [custom],
      customCategories: [],
      issues: [],
    });
    const selection = await loadProfileFile(ROOT);
    // An unknown-id pack reads as a patch over the novel fallback, so its
    // sections come back layered over novel's own overrides — the same
    // patch-over-fallback contract every hand-written file has.
    const expected = {
      ...custom,
      sections: { ...NOVEL_PROFILE.sections, ...custom.sections },
    };
    expect(selection?.enabled).toEqual([expected, NOVEL_PROFILE]);
    expect(selection?.customPacks).toEqual([expected]);
  });

  it("keeps a disabled custom pack in the file — disabling must not delete it", async () => {
    const custom: WorkspaceProfile = { ...TTRPG_PROFILE, id: "homebrew", labelZh: "自制", labelEn: "Homebrew" };
    await saveProfileFile(ROOT, {
      enabled: [NOVEL_PROFILE],
      customPacks: [custom],
      customCategories: [],
      issues: [],
    });
    const selection = await loadProfileFile(ROOT);
    expect(selection?.enabled).toEqual([NOVEL_PROFILE]);
    expect(selection?.customPacks.map((p) => p.id)).toEqual(["homebrew"]);
  });
});
