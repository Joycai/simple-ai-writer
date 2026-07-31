/**
 * Lore bundle export/import.
 *
 * A bundle is a zip with a root `manifest.json` plus the whole on-disk lore
 * tree stored under `lore/<category>/<entity>/…` — *all* categories present on
 * disk, not just the active profile's, so a bundle is lossless across profile
 * switches (mirroring how the scanner treats inactive categories: kept, just
 * hidden).
 *
 * Import is two-phase so the user can decide about conflicts before anything
 * touches the real lore tree:
 *   1. `stageLoreImport` — extract into `.ai-writer/lore-import-tmp`, walk the
 *      staged tree and report entities + conflicts.
 *   2. `applyLoreImport` / `cancelLoreImport` — move entity dirs into place
 *      under the chosen conflict strategy, then delete the staging dir.
 */

import { getVersion } from "@tauri-apps/api/app";
import { fileExists, makeDir, readDir, readFile, removeDir, renamePath } from "../fs/fileio";
import { zipExportDialog, zipImportDialog } from "../fs/transfer";
import { parseFrontmatter } from "../fs/markdown";
import { activeProfile, loreCategoryIds } from "../profile/active";
import { CATEGORY_ID_RE } from "../profile/model";
import { uniqueEntityId } from "./entity";

export const LORE_BUNDLE_KIND = "ai-writer-lore-bundle";
export const LORE_BUNDLE_VERSION = 1;

/** Staging dir name under `.ai-writer/`. A constant so an aborted import is overwritten by the next one. */
const STAGING_DIR = "lore-import-tmp";

export interface LoreBundleManifest {
  kind: typeof LORE_BUNDLE_KIND;
  version: number;
  exportedAt: string;
  appVersion: string;
  profileId: string;
  entities: { category: string; id: string; name: string }[];
}

export interface StagedEntity {
  category: string;
  id: string;
  name: string;
  /** An entity with the same category/id already exists in the project. */
  conflicts: boolean;
}

export interface StagedLoreImport {
  tempDir: string;
  zipPath: string;
  manifest: LoreBundleManifest | null;
  entities: StagedEntity[];
}

export type ConflictStrategy = "overwrite" | "skip" | "keepBoth";

export interface LoreImportSummary {
  imported: number;
  skipped: number;
  /** Categories imported to disk but not part of the active profile (hidden in the UI). */
  hiddenCategories: string[];
}

function loreRoot(projectPath: string): string {
  return `${projectPath}/.ai-writer/lore`;
}

/**
 * Walk a lore tree on disk: `<root>/<category>/<entity>/`. Category dirs that
 * don't look like a category id are skipped — they can only appear in a
 * hand-crafted bundle and would otherwise import folders the app never shows.
 */
async function walkLoreTree(root: string): Promise<{ category: string; id: string; name: string }[]> {
  const out: { category: string; id: string; name: string }[] = [];
  let catDirs;
  try {
    catDirs = await readDir(root);
  } catch {
    return out;
  }
  for (const cat of catDirs) {
    if (!cat.isDirectory || !CATEGORY_ID_RE.test(cat.name)) continue;
    let entityDirs;
    try {
      entityDirs = await readDir(cat.path);
    } catch {
      continue;
    }
    for (const ent of entityDirs) {
      if (!ent.isDirectory) continue;
      let name = ent.name;
      try {
        const raw = await readFile(`${ent.path}/index.md`);
        const { data } = parseFrontmatter(raw);
        if (typeof data.name === "string" && data.name.trim()) name = data.name;
      } catch {
        // index.md missing — fall back to the dir name
      }
      out.push({ category: cat.name, id: ent.name, name });
    }
  }
  return out;
}

/**
 * Export the project's lore tree as a zip bundle via the native save dialog.
 * Returns the saved path, or null when the user cancelled.
 */
export async function exportLoreBundle(projectPath: string): Promise<string | null> {
  const root = loreRoot(projectPath);
  const entities = await walkLoreTree(root);

  let appVersion = "";
  try {
    appVersion = await getVersion();
  } catch {
    // browser dev environment — manifest still valid without it
  }

  const manifest: LoreBundleManifest = {
    kind: LORE_BUNDLE_KIND,
    version: LORE_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion,
    profileId: activeProfile().id,
    entities,
  };

  const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? "project";
  const date = new Date().toISOString().slice(0, 10);
  return zipExportDialog(
    root,
    "lore",
    JSON.stringify(manifest, null, 2),
    `lore-${projectName}-${date}.zip`,
  );
}

/**
 * Phase 1 of import: pick a bundle, extract it into the staging dir and report
 * what it contains. Returns null when the user cancelled the file dialog.
 * Throws when the picked zip contains no lore payload (not a bundle).
 */
export async function stageLoreImport(projectPath: string): Promise<StagedLoreImport | null> {
  const tempDir = `${projectPath}/.ai-writer/${STAGING_DIR}`;
  // A previous aborted import may have left the staging dir behind.
  try {
    await removeDir(tempDir);
  } catch {}
  await makeDir(tempDir);

  const result = await zipImportDialog(tempDir, "lore");
  if (!result) {
    try {
      await removeDir(tempDir);
    } catch {}
    return null;
  }

  const staged = await walkLoreTree(tempDir);
  if (staged.length === 0) {
    try {
      await removeDir(tempDir);
    } catch {}
    throw new Error("empty-bundle");
  }

  let manifest: LoreBundleManifest | null = null;
  if (result.manifest) {
    try {
      const parsed = JSON.parse(result.manifest);
      if (parsed && parsed.kind === LORE_BUNDLE_KIND) manifest = parsed as LoreBundleManifest;
    } catch {
      // manifest unreadable — the extracted tree is still importable
    }
  }

  const entities: StagedEntity[] = [];
  for (const e of staged) {
    const conflicts = await fileExists(`${loreRoot(projectPath)}/${e.category}/${e.id}`);
    entities.push({ ...e, conflicts });
  }

  return { tempDir, zipPath: result.zip_path, manifest, entities };
}

/**
 * Phase 2: move staged entity dirs into the real lore tree under the chosen
 * conflict strategy, then delete the staging dir.
 */
export async function applyLoreImport(
  projectPath: string,
  staged: StagedLoreImport,
  strategy: ConflictStrategy,
): Promise<LoreImportSummary> {
  const root = loreRoot(projectPath);
  const activeIds = new Set(loreCategoryIds());
  const hidden = new Set<string>();
  let imported = 0;
  let skipped = 0;

  for (const e of staged.entities) {
    const from = `${staged.tempDir}/${e.category}/${e.id}`;
    let targetId = e.id;

    if (e.conflicts) {
      if (strategy === "skip") {
        skipped++;
        continue;
      }
      if (strategy === "overwrite") {
        await removeDir(`${root}/${e.category}/${e.id}`);
      } else {
        targetId = await uniqueEntityId(projectPath, e.category, e.id);
      }
    }

    await renamePath(from, `${root}/${e.category}/${targetId}`);
    imported++;
    if (!activeIds.has(e.category)) hidden.add(e.category);
  }

  await cancelLoreImport(staged.tempDir);
  return { imported, skipped, hiddenCategories: [...hidden] };
}

/** Drop the staging dir (import cancelled or finished). */
export async function cancelLoreImport(tempDir: string): Promise<void> {
  try {
    await removeDir(tempDir);
  } catch {
    // best-effort cleanup
  }
}
