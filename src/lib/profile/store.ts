/**
 * Profile persistence: `.ai-writer/profile.json`.
 *
 * Absence is the normal case for a project created before profiles existed,
 * and it means "novel" — so opening an old project stays read-only and behaves
 * exactly as it used to. The file is written only when the author actually
 * changes the pack selection or the user-defined categories, which is also the
 * only moment a v1/v2 file is rewritten as v3 (see ./file for the formats).
 */

import { fileExists, makeDir, readFile, writeFile } from "../fs/fileio";
import { parseProfileFile, type ProfileSelection } from "./file";
import { dirName, toPosixPath } from "../paths";

const PROFILE_FILE_VERSION = 3;

function profilePath(projectPath: string): string {
  return `${toPosixPath(projectPath)}/.ai-writer/profile.json`;
}

/**
 * Read a project's pack selection, or null when it has none.
 *
 * Never throws: an unreadable or malformed file degrades to null (novel),
 * which is the same state as a project that predates profiles. Problems are
 * reported to the console rather than surfaced as a modal, because this runs
 * inside the project-open path and a bad profile must not block opening the
 * project.
 */
export async function loadProfileFile(projectPath: string): Promise<ProfileSelection | null> {
  const path = profilePath(projectPath);
  try {
    if (!(await fileExists(path))) return null;
    const raw = await readFile(path);
    const data: unknown = JSON.parse(raw);
    const selection = parseProfileFile(data);
    if (selection.issues.length > 0) {
      console.warn(`[profile] ${path} has problems:\n  - ${selection.issues.join("\n  - ")}`);
    }
    return selection;
  } catch (err) {
    console.warn(`[profile] could not read ${path}, using the default profile:`, err);
    return null;
  }
}

export async function saveProfileFile(projectPath: string, selection: ProfileSelection): Promise<void> {
  const path = profilePath(projectPath);
  await makeDir(dirName(path));
  // Built-in packs serialise as bare ids — the file stays hand-readable and a
  // later build's improved built-ins apply without a migration. Custom packs
  // are the part nothing else can reconstruct, so they are written out in
  // full, whether currently enabled or not (disabling a pack must not delete
  // its definition — the same never-silently-lose-data rule the lore
  // directories follow). The user-defined categories ride along the same way.
  const body: Record<string, unknown> = {
    version: PROFILE_FILE_VERSION,
    enabled: selection.enabled.map((p) => p.id),
  };
  if (selection.customPacks.length > 0) body.packs = selection.customPacks;
  if (selection.customCategories.length > 0) body.categories = selection.customCategories;
  // Only the declaration — the membership is on the entries themselves, and an
  // absent list simply means every collection is discovered from them.
  if (selection.collections.length > 0) body.collections = selection.collections;
  await writeFile(path, JSON.stringify(body, null, 2) + "\n");
}
