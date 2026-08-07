/**
 * lib/fs/projectBackup — whole-project export/restore.
 *
 * The two properties worth pinning are both about *not* destroying anything:
 * a restore refuses a folder that already has something in it, and it never
 * reports success for a bundle that unpacked nothing. The exclude list is
 * asserted too, because a backup that quietly carried `.ai-writer/backups`
 * would be many times the size of the project it is backing up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  // Typed with the real signature so `mock.calls` is indexable — a zero-arg
  // `vi.fn` infers an empty tuple and every argument assertion below fails to
  // compile rather than fails to hold.
  zipExportDialog: vi.fn(
    async (
      _srcDir: string,
      _prefix: string,
      _manifest: string | null,
      _defaultFileName: string,
      _excludes?: string[],
    ) => "/picked/backup.zip" as string | null,
  ),
  zipImportDialog: vi.fn(),
  readDir: vi.fn(async () => [] as { name: string; path: string; isDirectory: boolean }[]),
  openProjectFolder: vi.fn(async () => "/dest" as string | null),
  getDb: vi.fn(async () => ({ select: vi.fn(async () => []) })),
  getVersion: vi.fn(async () => "1.3.1"),
}));

vi.mock("../fs/transfer", () => ({
  zipExportDialog: h.zipExportDialog,
  zipImportDialog: h.zipImportDialog,
}));
vi.mock("../fs/fileio", () => ({ readDir: h.readDir }));
vi.mock("../project", () => ({ getDb: h.getDb, openProjectFolder: h.openProjectFolder }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: h.getVersion }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  exportProjectBundle,
  PROJECT_BACKUP_EXCLUDES,
  PROJECT_BUNDLE_KIND,
  restoreProjectBundle,
  type ProjectBundleManifest,
} from "../fs/projectBackup";

beforeEach(() => {
  h.zipExportDialog.mockClear().mockResolvedValue("/picked/backup.zip");
  h.zipImportDialog.mockReset();
  h.readDir.mockClear().mockResolvedValue([]);
  h.openProjectFolder.mockClear().mockResolvedValue("/dest");
  h.getDb.mockClear();
});

/** The manifest the export handed to the zip command. */
function exportedManifest(): ProjectBundleManifest {
  return JSON.parse(h.zipExportDialog.mock.calls[0][2] ?? "null");
}

describe("PROJECT_BACKUP_EXCLUDES", () => {
  it("skips the trees that are recoverable state or scratch, not project data", () => {
    for (const path of [
      ".ai-writer/backups",
      ".ai-writer/tmp",
      ".ai-writer/lore-import-tmp",
      ".ai-writer/project.db-wal",
      ".ai-writer/project.db-shm",
    ]) {
      expect(PROJECT_BACKUP_EXCLUDES).toContain(path);
    }
  });

  it("does not exclude anything the model actually reads", () => {
    // The whole reason this module exists rather than reusing the lore bundle.
    for (const kept of [
      ".ai-writer/lore",
      ".ai-writer/memory",
      ".ai-writer/profile.json",
      ".ai-writer/outline.json",
      ".ai-writer/imagegen.json",
      ".ai-writer/project.db",
      "writing",
    ]) {
      expect(PROJECT_BACKUP_EXCLUDES).not.toContain(kept);
    }
  });
});

describe("exportProjectBundle", () => {
  it("checkpoints the database before archiving it", async () => {
    const select = vi.fn(async () => []);
    h.getDb.mockResolvedValueOnce({ select });

    await exportProjectBundle("/proj/我的小说");

    // Without this the archived project.db is missing whatever is still in the
    // write-ahead log — and the -wal file is deliberately not archived.
    expect(select).toHaveBeenCalledWith("PRAGMA wal_checkpoint(TRUNCATE)");
  });

  it("still exports when the checkpoint fails", async () => {
    h.getDb.mockRejectedValueOnce(new Error("database is locked"));
    await expect(exportProjectBundle("/proj/a")).resolves.toBe("/picked/backup.zip");
    expect(h.zipExportDialog).toHaveBeenCalled();
  });

  it("archives the project root under one prefix, with the exclude list", async () => {
    await exportProjectBundle("/proj/我的小说");
    const [srcDir, prefix, , fileName, excludes] = h.zipExportDialog.mock.calls[0];
    expect(srcDir).toBe("/proj/我的小说");
    expect(prefix).toBe("project");
    expect(fileName).toMatch(/^我的小说-backup-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(excludes).toEqual(PROJECT_BACKUP_EXCLUDES);
  });

  it("writes a manifest naming the kind the restore checks for", async () => {
    await exportProjectBundle("/proj/我的小说");
    const m = exportedManifest();
    expect(m.kind).toBe(PROJECT_BUNDLE_KIND);
    expect(m.projectName).toBe("我的小说");
    expect(m.appVersion).toBe("1.3.1");
    expect(Number.isNaN(Date.parse(m.exportedAt))).toBe(false);
  });

  it("handles a project path with a trailing separator", async () => {
    await exportProjectBundle("/proj/我的小说/");
    expect(exportedManifest().projectName).toBe("我的小说");
  });

  it("returns null when the save dialog was cancelled", async () => {
    h.zipExportDialog.mockResolvedValueOnce(null);
    await expect(exportProjectBundle("/proj/a")).resolves.toBeNull();
  });
});

describe("restoreProjectBundle", () => {
  it("refuses a destination that already has something in it", async () => {
    h.readDir.mockResolvedValueOnce([{ name: "writing", path: "/dest/writing", isDirectory: true }]);

    await expect(restoreProjectBundle()).rejects.toThrow("dest-not-empty");
    // Nothing may be unpacked over the author's existing files.
    expect(h.zipImportDialog).not.toHaveBeenCalled();
  });

  it("makes the Rust side verify the bundle kind before it writes anything", async () => {
    h.zipImportDialog.mockResolvedValueOnce({ zip_path: "/b.zip", manifest: null, file_count: 12 });

    await restoreProjectBundle();

    expect(h.zipImportDialog).toHaveBeenCalledWith("/dest", "project", PROJECT_BUNDLE_KIND);
  });

  it("reports where it unpacked and what the backup was", async () => {
    const manifest: ProjectBundleManifest = {
      kind: PROJECT_BUNDLE_KIND,
      version: 1,
      exportedAt: "2026-08-01T00:00:00.000Z",
      appVersion: "1.3.1",
      projectName: "我的小说",
      profileId: "novel",
    };
    h.zipImportDialog.mockResolvedValueOnce({
      zip_path: "/b.zip",
      manifest: JSON.stringify(manifest),
      file_count: 42,
    });

    await expect(restoreProjectBundle()).resolves.toEqual({
      path: "/dest",
      manifest,
      fileCount: 42,
    });
  });

  it("treats an unreadable manifest as missing detail, not a failed restore", async () => {
    h.zipImportDialog.mockResolvedValueOnce({ zip_path: "/b.zip", manifest: "{oops", file_count: 3 });

    const restored = await restoreProjectBundle();
    expect(restored?.manifest).toBeNull();
    expect(restored?.fileCount).toBe(3);
  });

  it("does not call an empty restore a success", async () => {
    h.zipImportDialog.mockResolvedValueOnce({ zip_path: "/b.zip", manifest: null, file_count: 0 });

    await expect(restoreProjectBundle()).rejects.toThrow("empty-bundle");
  });

  it("returns null — without reading the folder — when the folder picker is cancelled", async () => {
    h.openProjectFolder.mockResolvedValueOnce(null);

    await expect(restoreProjectBundle()).resolves.toBeNull();
    expect(h.readDir).not.toHaveBeenCalled();
  });

  it("returns null when the zip picker is cancelled", async () => {
    h.zipImportDialog.mockResolvedValueOnce(null);
    await expect(restoreProjectBundle()).resolves.toBeNull();
  });
});
