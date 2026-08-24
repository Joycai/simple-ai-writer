/**
 * Automatic pre-write backups for L1 ("write-auto") agent tools.
 *
 * The tiered write policy (docs/feature/agent/unified-agent-plan.md §3.2) lets the agent
 * apply lore/memory writes without a confirmation step — the safety valve is
 * that every overwrite first snapshots the original into
 * `.ai-writer/backups/`, the same flat directory LoreSplitModal already uses,
 * so one place holds everything recoverable.
 *
 * Naming: `agent-<epoch millis>-<flattened relative path>` — flattening keeps
 * the directory listable at a glance and avoids recreating the source tree.
 */

import { fileExists, makeDir, readFile, renamePath, writeFile } from "../fs/fileio";
import { baseName, projectRelative } from "../paths";

/** The flat backup destination for `absPath`, shared by both backup flavours. */
async function backupDest(projectPath: string, absPath: string): Promise<string> {
  const backupDir = `${projectPath}/.ai-writer/backups`;
  await makeDir(backupDir);
  const rel = projectRelative(projectPath, absPath) || baseName(absPath) || "file";
  return `${backupDir}/agent-${Date.now()}-${rel.replace(/\//g, "-")}`;
}

/**
 * Snapshot `absPath` before an agent write. Returns the backup's absolute path,
 * or null when the source doesn't exist yet (creating a new file needs none).
 * Throws on read/write failure — callers must treat a failed backup as a
 * failed write, never write anyway.
 */
export async function backupFile(projectPath: string, absPath: string): Promise<string | null> {
  if (!(await fileExists(absPath))) return null;
  const dest = await backupDest(projectPath, absPath);
  await writeFile(dest, await readFile(absPath));
  return dest;
}

/**
 * Back up `absPath` by MOVING it into `.ai-writer/backups/` — for binary files
 * (gallery images, avatars) that the text-only {@link backupFile} cannot
 * snapshot. The move IS both the backup and the removal, so there is no
 * half-deleted state; same naming as backupFile, same null-on-missing contract.
 */
export async function backupFileByMove(
  projectPath: string,
  absPath: string,
): Promise<string | null> {
  if (!(await fileExists(absPath))) return null;
  const dest = await backupDest(projectPath, absPath);
  await renamePath(absPath, dest);
  return dest;
}
