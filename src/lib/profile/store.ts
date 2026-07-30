/**
 * Profile persistence: `.ai-writer/profile.json`.
 *
 * Absence is the normal case for a project created before profiles existed, and
 * it means "novel" — so opening an old project stays read-only and behaves
 * exactly as it used to. The file is written only when the author actually picks
 * a profile.
 */

import { fileExists, makeDir, readFile, writeFile } from "../fs/fileio";
import { builtinProfile, NOVEL_PROFILE, parseProfile, type WorkspaceProfile } from "./model";

/**
 * Written into profile.json for forward compatibility. Nothing reads it yet:
 * `parseProfile` validates field by field and tolerates anything missing, so a
 * future format change can branch on this without needing it today.
 */
const PROFILE_FILE_VERSION = 1;

function profilePath(projectPath: string): string {
  return `${projectPath.replace(/\\/g, "/")}/.ai-writer/profile.json`;
}

/**
 * Read a project's profile, or null when it has none.
 *
 * Never throws: an unreadable or malformed file degrades to null (novel), which
 * is the same state as a project that predates profiles. Problems are reported
 * to the console rather than surfaced as a modal, because this runs inside the
 * project-open path and a bad profile must not block opening the project.
 */
export async function loadProfile(projectPath: string): Promise<WorkspaceProfile | null> {
  const path = profilePath(projectPath);
  try {
    if (!(await fileExists(path))) return null;
    const raw = await readFile(path);
    const data: unknown = JSON.parse(raw);
    // A file naming a built-in inherits that profile's defaults for anything it
    // leaves out, so `{"id":"ttrpg"}` is a complete, valid profile.
    const declaredId =
      data && typeof data === "object" && typeof (data as { id?: unknown }).id === "string"
        ? (data as { id: string }).id
        : "";
    const fallback = builtinProfile(declaredId) ?? NOVEL_PROFILE;
    const { profile, issues } = parseProfile(data, fallback);
    if (issues.length > 0) {
      console.warn(`[profile] ${path} has problems:\n  - ${issues.join("\n  - ")}`);
    }
    return profile;
  } catch (err) {
    console.warn(`[profile] could not read ${path}, using the default profile:`, err);
    return null;
  }
}

export async function saveProfile(projectPath: string, profile: WorkspaceProfile): Promise<void> {
  const path = profilePath(projectPath);
  await makeDir(path.slice(0, path.lastIndexOf("/")));
  const body = { version: PROFILE_FILE_VERSION, ...profile };
  await writeFile(path, JSON.stringify(body, null, 2) + "\n");
}
