import { readSchemaProfile, validateSchemaForProfile, parseLoreSchema, mergeLoreSchema, applyLoreSchema, type LoreSchema, type SchemaChoices } from "../profile/transferSchema";
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
import { copyPath, fileExists, makeDir, readDir, readFile, removeDir, renamePath } from "../fs/fileio";
import { zipExportDialog, zipImportDialog } from "../fs/transfer";
import { parseFrontmatter } from "../fs/markdown";
import { activeWorkspace, loreCategoryIds } from "../profile/active";
import { CATEGORY_ID_RE } from "../profile/model";
import { uniqueEntityId } from "./entity";
import { baseName } from "../paths";

const LORE_BUNDLE_KIND = "ai-writer-lore-bundle";
const LORE_BUNDLE_VERSION = 2;

/** Staging dir name under `.ai-writer/`. A constant so an aborted import is overwritten by the next one. */
const STAGING_DIR = "lore-import-tmp";

interface LoreBundleManifest {
  schema?: LoreSchema;
  kind: typeof LORE_BUNDLE_KIND;
  version: number;
  exportedAt: string;
  appVersion: string;
  profileId: string;
  entities: { category: string; id: string; name: string }[];
}

interface StagedEntity {
  category: string;
  id: string;
  name: string;
  /** An entity with the same category/id already exists in the project. */
  conflicts: boolean;
}

export interface StagedLoreImport {
  schema?: { source: LoreSchema; target: LoreSchema };
  tempDir: string;
  zipPath: string;
  manifest: LoreBundleManifest | null;
  entities: StagedEntity[];
}

export type ConflictStrategy = "overwrite" | "skip" | "keepBoth";

interface LoreImportSummary {
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
 * Optional selectedPaths exports only those entry folders and their category definitions.
 * Returns the saved path, or null when the user cancelled.
 */
export async function exportLoreBundle(projectPath: string, selectedPaths?: readonly string[]): Promise<string | null> {
  const root = loreRoot(projectPath);
  const allEntities = await walkLoreTree(root);
  const selected = selectedPaths === undefined ? undefined : new Set(selectedPaths);
  const entities = selected === undefined ? allEntities : allEntities.filter(
    (e) => selected.has(`${root}/${e.category}/${e.id}`),
  );
  // Refuse stale/foreign paths rather than silently exporting fewer entries.
  if (selected && (!selected.size || entities.length !== selected.size)) {
    throw new Error("The selected entries changed; refresh the knowledge base and select them again.");
  }
  const schema = (await readSchemaProfile(projectPath)).schema;
  if (selected) {
    const categories = new Set(entities.map((e) => e.category));
    schema.categories = schema.categories.filter((c) => categories.has(c.id));
    schema.categoryExtensions = Object.fromEntries(
      Object.entries(schema.categoryExtensions).filter(([id]) => categories.has(id)),
    );
  }

  let appVersion = "";
  try {
    appVersion = await getVersion();
  } catch {
    // browser dev environment — manifest still valid without it
  }

  const manifest: LoreBundleManifest = {
    schema,
    kind: LORE_BUNDLE_KIND,
    version: LORE_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion,
    // Informational only (shown when importing). Packs are equal toggles, so
    // the stamp is the whole enabled list rather than a single profile.
    profileId: activeWorkspace().enabled.map((p) => p.id).join("+") || "none",
    entities,
  };

  const projectName = baseName(projectPath) || "project";
  const date = new Date().toISOString().slice(0, 10);
  const save = (source: string) => zipExportDialog(
    source,
    "lore",
    JSON.stringify(manifest, null, 2),
    `lore-${projectName}-${selected ? "selected-" : ""}${date}.zip`,
  );
  if (!selected) return save(root);

  // Copy whole entry folders, including binary assets. A private snapshot keeps
  // unrelated files out of the archive without changing the native ZIP API.
  const tempDir = `${projectPath}/.ai-writer/tmp/lore-export-${crypto.randomUUID()}`;
  try {
    await makeDir(tempDir);
    for (const e of entities) {
      await makeDir(`${tempDir}/${e.category}`);
      await copyPath(`${root}/${e.category}/${e.id}`, `${tempDir}/${e.category}/${e.id}`);
    }
    return await save(tempDir);
  } finally {
    await cancelLoreImport(tempDir);
  }
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
  let manifest: LoreBundleManifest | null = null;
  if (result.manifest) {
    const parsed = JSON.parse(result.manifest);
    if (parsed?.kind !== LORE_BUNDLE_KIND || ![1, 2].includes(parsed.version)) throw new Error("Unsupported knowledge-base bundle");
    if (parsed.version === 2 && parsed.schema === undefined) throw new Error("Knowledge-base definitions are missing");
    manifest = parsed as LoreBundleManifest;
  }

  const schema = manifest?.schema !== undefined
    ? { source: parseLoreSchema(manifest.schema), target: (await readSchemaProfile(projectPath)).schema }
    : undefined;
  if (!staged.length && (!schema || (!schema.source.categories.length && !Object.keys(schema.source.categoryExtensions).length))) {
    await cancelLoreImport(tempDir);
    throw new Error("empty-bundle");
  }
  if (schema) validateSchemaForProfile(mergeLoreSchema(schema.target, schema.source).schema, (await readSchemaProfile(projectPath)).selection);

  const entities: StagedEntity[] = [];
  for (const e of staged) {
    const conflicts = await fileExists(`${loreRoot(projectPath)}/${e.category}/${e.id}`);
    entities.push({ ...e, conflicts });
  }

  return { tempDir, zipPath: result.zip_path, manifest, entities, ...(schema ? { schema } : {}) };
}

/**
 * Phase 2: move staged entity dirs into the real lore tree under the chosen
 * conflict strategy, then delete the staging dir.
 */
export async function applyLoreImport(
  projectPath: string,
  staged: StagedLoreImport,
  strategy: ConflictStrategy,
  choices: SchemaChoices = {},
): Promise<LoreImportSummary> {
  if (staged.schema) {
    const merged = mergeLoreSchema(staged.schema.target, staged.schema.source, choices);
    await applyLoreSchema(projectPath, staged.schema.target, merged.schema);
  }
  const root = loreRoot(projectPath);
  const activeIds = new Set(loreCategoryIds());
  for (const c of staged.schema?.source.categories ?? []) activeIds.add(c.id);
  const hidden = new Set<string>();
  let imported = 0;
  let skipped = 0;

  for (const e of staged.entities) {
    const from = `${staged.tempDir}/${e.category}/${e.id}`;
    let targetId = e.id;
    let displaced: string | null = null;

    if (e.conflicts) {
      if (strategy === "skip") {
        skipped++;
        continue;
      }
      if (strategy === "overwrite") {
        displaced = await displaceEntity(projectPath, e.category, e.id);
      } else {
        targetId = await uniqueEntityId(projectPath, e.category, e.id);
      }
    }

    const to = `${root}/${e.category}/${targetId}`;
    try {
      await makeDir(`${root}/${e.category}`);
      await renamePath(from, to);
    } catch (err) {
      // The move in failed with the author's entity already out of the way.
      // Put it back before reporting, or "overwrite" would mean "delete" for
      // an import that then didn't happen — a folder gone from both places.
      if (displaced) {
        try {
          await renamePath(displaced, to);
        } catch (restoreErr) {
          throw new Error(
            `Could not import "${e.name}", and the entity it was replacing could not be ` +
              `restored either. It is at ${displaced} — move it back to ${to} by hand. ` +
              `(${String(err)}; ${String(restoreErr)})`,
          );
        }
      }
      throw err;
    }

    imported++;
    if (!activeIds.has(e.category)) hidden.add(e.category);
  }

  await cancelLoreImport(staged.tempDir);
  return { imported, skipped, hiddenCategories: [...hidden] };
}

/**
 * Move the entity an "overwrite" is about to replace into `.ai-writer/backups`
 * and return where it went.
 *
 * This used to be `removeDir` — an unlink, and an unrecoverable one. Two
 * separate problems with that. The obvious one: "overwrite" silently destroyed
 * an entry the author may have spent hours on, including gallery images, with
 * no undo anywhere in the app. The subtler one: delete-then-rename has a window
 * where the entity exists in neither place, so a rename that fails (a locked
 * file, a cross-volume move, a full disk) leaves *nothing*.
 *
 * Moving instead of deleting fixes both, and matches what the agent's
 * `delete_lore_entity` already does — one flat backups directory holds
 * everything recoverable, so there is one place to look.
 */
async function displaceEntity(projectPath: string, category: string, id: string): Promise<string> {
  const backupRoot = `${projectPath}/.ai-writer/backups`;
  await makeDir(backupRoot);
  const dest = `${backupRoot}/replaced-${Date.now()}-${category}-${id}`;
  await renamePath(`${loreRoot(projectPath)}/${category}/${id}`, dest);
  return dest;
}

/** Drop the staging dir (import cancelled or finished). */
export async function cancelLoreImport(tempDir: string): Promise<void> {
  try {
    await removeDir(tempDir);
  } catch {
    // best-effort cleanup
  }
}
