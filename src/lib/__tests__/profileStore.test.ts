/**
 * `.ai-writer/profile.json` persistence.
 *
 * `parseProfile` is covered in profile.test.ts with the fallback handed in
 * explicitly; what is only exercised here is the wiring that *chooses* that
 * fallback — `builtinProfile(declaredId) ?? NOVEL_PROFILE` — which is what makes
 * a hand-written `{"id":"ttrpg"}` resolve to a complete TTRPG profile instead of
 * a novel one wearing a ttrpg id.
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

import { loadProfile, saveProfile } from "../profile/store";
import { NOVEL_PROFILE, TTRPG_PROFILE, type WorkspaceProfile } from "../profile/model";

const ROOT = "D:/projects/my-book";
const PROFILE_PATH = `${ROOT}/.ai-writer/profile.json`;

beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
});

describe("loadProfile", () => {
  it("returns null when the project has no profile.json", async () => {
    // Absence is the normal case for a project predating profiles, and it must
    // read as "novel" rather than as an error.
    expect(await loadProfile(ROOT)).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("resolves a minimal file naming a builtin to that whole builtin", async () => {
    // The regression this file exists for: without the builtinProfile(declaredId)
    // lookup, every field the file omits would inherit NOVEL_PROFILE and a TTRPG
    // project would silently get 【上一章结尾】/【设定资料】 in its prompts.
    files.set(PROFILE_PATH, JSON.stringify({ id: "ttrpg" }));
    expect(await loadProfile(ROOT)).toEqual(TTRPG_PROFILE);
  });

  it("keeps the rest of a builtin's wording when the file overrides one section", async () => {
    files.set(PROFILE_PATH, JSON.stringify({ id: "ttrpg", sections: { outline: "推进方向" } }));
    const profile = await loadProfile(ROOT);
    expect(profile?.sections.outline).toBe("推进方向");
    // Not reverted to the novel defaults just because the file named `sections`.
    expect(profile?.sections.prevTail).toBe(TTRPG_PROFILE.sections.prevTail);
    expect(profile?.sections.knowledge).toBe(TTRPG_PROFILE.sections.knowledge);
  });

  it("falls back to novel for what an unrecognised id leaves out", async () => {
    files.set(
      PROFILE_PATH,
      JSON.stringify({ id: "weekly", categories: [{ id: "projects", labelZh: "项目", labelEn: "Projects" }] }),
    );
    const profile = await loadProfile(ROOT);
    expect(profile?.id).toBe("weekly");
    expect(profile?.categories.map((c) => c.id)).toEqual(["projects"]);
    expect(profile?.systemPromptKey).toBe(NOVEL_PROFILE.systemPromptKey);
  });

  it("degrades to null on malformed JSON instead of throwing", async () => {
    // This runs inside the project-open path: a bad profile must not stop the
    // author from opening their project.
    files.set(PROFILE_PATH, "{ not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadProfile(ROOT)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("degrades to null when the file cannot be read", async () => {
    fileExists.mockResolvedValueOnce(true);
    readFile.mockRejectedValueOnce(new Error("EACCES"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadProfile(ROOT)).toBeNull();
    warn.mockRestore();
  });

  it("still returns a usable profile when the file has problems, and says so", async () => {
    files.set(PROFILE_PATH, JSON.stringify({ id: "ttrpg", categories: [{ id: "../escape" }] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const profile = await loadProfile(ROOT);
    expect(profile?.categories).toEqual(TTRPG_PROFILE.categories);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("escape"), ...[]);
    warn.mockRestore();
  });

  it("normalises a Windows project path to a forward-slash profile.json path", async () => {
    files.set(PROFILE_PATH, JSON.stringify({ id: "ttrpg" }));
    await loadProfile("D:\\projects\\my-book");
    expect(fileExists).toHaveBeenCalledWith(PROFILE_PATH);
    expect(readFile).toHaveBeenCalledWith(PROFILE_PATH);
  });
});

describe("saveProfile", () => {
  it("writes a versioned profile and creates .ai-writer first", async () => {
    await saveProfile(ROOT, TTRPG_PROFILE);
    expect(makeDir).toHaveBeenCalledWith(`${ROOT}/.ai-writer`);
    const body = JSON.parse(files.get(PROFILE_PATH)!);
    expect(body.version).toBe(1);
    expect(body.id).toBe("ttrpg");
    expect(body.categories).toEqual(TTRPG_PROFILE.categories);
  });

  it("round-trips through loadProfile", async () => {
    const custom: WorkspaceProfile = {
      id: "weekly",
      labelZh: "周报",
      labelEn: "Weekly",
      categories: [{ id: "projects", labelZh: "项目", labelEn: "Projects" }],
      sections: { knowledge: "背景资料" },
      systemPromptKey: "ai.instructions.system",
    };
    await saveProfile(ROOT, custom);
    expect(await loadProfile(ROOT)).toEqual(custom);
  });
});
