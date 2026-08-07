/**
 * applyLoreImport's "overwrite" strategy.
 *
 * It used to be `removeDir(existing)` followed by `renamePath(staged, dest)`.
 * Two problems in one line. The entity the author was replacing — including
 * gallery images, which no text backup could have captured — was unlinked with
 * no undo anywhere in the app; and between the two calls the entity existed in
 * neither place, so a rename that failed (locked file, cross-volume move, full
 * disk) left *nothing*. It now displaces into `.ai-writer/backups` and rolls
 * that back if the move in fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fileExists: vi.fn(async () => false),
  makeDir: vi.fn(async () => {}),
  readDir: vi.fn(async () => [] as { name: string; path: string; isDirectory: boolean }[]),
  readFile: vi.fn(async () => ""),
  removeDir: vi.fn(async () => {}),
  renamePath: vi.fn(async (_from: string, _to: string) => {}),
  uniqueEntityId: vi.fn(async (_p: string, _c: string, id: string) => `${id}-2`),
  loreCategoryIds: vi.fn(() => ["characters"]),
}));

vi.mock("../fs/fileio", () => ({
  fileExists: h.fileExists,
  makeDir: h.makeDir,
  readDir: h.readDir,
  readFile: h.readFile,
  removeDir: h.removeDir,
  renamePath: h.renamePath,
}));
vi.mock("../fs/transfer", () => ({ zipExportDialog: vi.fn(), zipImportDialog: vi.fn() }));
vi.mock("../lore/entity", () => ({ uniqueEntityId: h.uniqueEntityId }));
vi.mock("../profile/active", () => ({
  activeProfile: () => ({ id: "novel" }),
  loreCategoryIds: h.loreCategoryIds,
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.3.1" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { applyLoreImport, type StagedLoreImport } from "../lore/transfer";

const PROJECT = "/proj";
const ROOT = `${PROJECT}/.ai-writer/lore`;
const TEMP = `${PROJECT}/.ai-writer/lore-import-tmp`;

function staged(conflicts: boolean): StagedLoreImport {
  return {
    tempDir: TEMP,
    zipPath: "/b.zip",
    manifest: null,
    entities: [{ category: "characters", id: "hero", name: "主角", conflicts }],
  };
}

beforeEach(() => {
  for (const fn of Object.values(h)) (fn as { mockClear: () => void }).mockClear();
  h.renamePath.mockImplementation(async () => {});
  h.uniqueEntityId.mockImplementation(async (_p, _c, id) => `${id}-2`);
});

/** Every rename as a `from → to` pair, in order. */
const renames = () => h.renamePath.mock.calls.map(([from, to]) => [from, to]);

describe("overwrite", () => {
  it("moves the replaced entity into backups instead of deleting it", async () => {
    const summary = await applyLoreImport(PROJECT, staged(true), "overwrite");

    expect(summary.imported).toBe(1);
    expect(h.removeDir).not.toHaveBeenCalledWith(`${ROOT}/characters/hero`);

    const [displace, moveIn] = renames();
    expect(displace[0]).toBe(`${ROOT}/characters/hero`);
    expect(displace[1]).toMatch(/\.ai-writer\/backups\/replaced-\d+-characters-hero$/);
    expect(moveIn).toEqual([`${TEMP}/characters/hero`, `${ROOT}/characters/hero`]);
  });

  it("puts the displaced entity back when the import move fails", async () => {
    // The window that used to lose the folder outright.
    h.renamePath.mockImplementation(async (from: string) => {
      if (from.startsWith(TEMP)) throw new Error("EXDEV: cross-device link");
    });

    await expect(applyLoreImport(PROJECT, staged(true), "overwrite")).rejects.toThrow("EXDEV");

    const [, , restore] = renames();
    expect(restore[0]).toMatch(/backups\/replaced-\d+-characters-hero$/);
    expect(restore[1]).toBe(`${ROOT}/characters/hero`);
  });

  it("says where the entity is when it cannot be put back either", async () => {
    h.renamePath.mockImplementation(async (from: string, to: string) => {
      if (from.startsWith(TEMP)) throw new Error("EXDEV");
      if (to === `${ROOT}/characters/hero`) throw new Error("EACCES");
    });

    // The one case a human has to finish by hand — so the message has to carry
    // the path, not just "import failed".
    await expect(applyLoreImport(PROJECT, staged(true), "overwrite")).rejects.toThrow(
      /backups\/replaced-\d+-characters-hero.*by hand/s,
    );
  });
});

describe("the other strategies are untouched", () => {
  it("skip leaves the existing entity exactly where it is", async () => {
    const summary = await applyLoreImport(PROJECT, staged(true), "skip");

    expect(summary).toMatchObject({ imported: 0, skipped: 1 });
    expect(h.renamePath).not.toHaveBeenCalled();
    expect(h.removeDir).toHaveBeenCalledWith(TEMP); // staging cleanup only
  });

  it("keepBoth imports under a free id and displaces nothing", async () => {
    const summary = await applyLoreImport(PROJECT, staged(true), "keepBoth");

    expect(summary.imported).toBe(1);
    expect(renames()).toEqual([[`${TEMP}/characters/hero`, `${ROOT}/characters/hero-2`]]);
  });

  it("a non-conflicting entity moves straight in", async () => {
    const summary = await applyLoreImport(PROJECT, staged(false), "overwrite");

    expect(summary.imported).toBe(1);
    expect(renames()).toEqual([[`${TEMP}/characters/hero`, `${ROOT}/characters/hero`]]);
    expect(h.makeDir).not.toHaveBeenCalled();
  });

  it("reports a category the active profile does not show", async () => {
    h.loreCategoryIds.mockReturnValueOnce(["world"]);

    const summary = await applyLoreImport(PROJECT, staged(false), "overwrite");

    expect(summary.hiddenCategories).toEqual(["characters"]);
  });
});
