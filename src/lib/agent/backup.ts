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

import { fileExists, makeDir, readFile, writeFile } from "../fs/fileio";
import { baseName, projectRelative } from "../paths";

/**
 * Snapshot `absPath` before an agent write. Returns the backup's absolute path,
 * or null when the source doesn't exist yet (creating a new file needs none).
 * Throws on read/write failure — callers must treat a failed backup as a
 * failed write, never write anyway.
 */
export async function backupFile(projectPath: string, absPath: string): Promise<string | null> {
  if (!(await fileExists(absPath))) return null;

  const backupDir = `${projectPath}/.ai-writer/backups`;
  await makeDir(backupDir);

  const rel = projectRelative(projectPath, absPath) || baseName(absPath) || "file";
  const flat = rel.replace(/\//g, "-");

  const dest = `${backupDir}/agent-${Date.now()}-${flat}`;
  await writeFile(dest, await readFile(absPath));
  return dest;
}
