/**
 * The category note: `.ai-writer/lore/<category>/index.md`, the same folder-note
 * format the workspace uses (`lib/fs/folderNote`), read for its summary only.
 *
 * Its one consumer is `formatLoreIndex` — the line after a category's header
 * that says what the category is *for* — read from disk at the moment the
 * model lists the knowledge base, so it costs nothing on a run that never does.
 * It deliberately does **not** enter `LoreIndex` or `IndexedCategory`: a
 * category-level `status` would have to reach `selectLore`, whose invariant is
 * to read nothing but facet frontmatter, and a `title` would have to travel
 * through the scan to label an orphan. Both are the next step's work
 * (folder-note-plan.md §4.2), and this is the cheap half that needs neither.
 */

import { FOLDER_NOTE_FILE, readFolderNote } from "../fs/folderNote";
import { makeDir, writeFile } from "../fs/fileio";

function categoryDir(projectPath: string, categoryId: string): string {
  return `${projectPath}/.ai-writer/lore/${categoryId}`;
}

function categoryNotePath(projectPath: string, categoryId: string): string {
  return `${categoryDir(projectPath, categoryId)}/${FOLDER_NOTE_FILE}`;
}

/** Summaries of the categories that have a note, keyed by id. Silent about the rest. */
export async function readCategoryNotes(
  projectPath: string,
  categoryIds: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!projectPath) return out;
  for (const id of categoryIds) {
    const note = await readFolderNote(categoryDir(projectPath, id));
    if (note?.summary) out[id] = note.summary;
  }
  return out;
}

/**
 * Write a category's note whole. Creates the category folder if it does not
 * exist yet — a declared-but-empty category has no folder until its first
 * entry, and a description is a fine first thing to put there.
 */
export async function writeCategoryNote(
  projectPath: string,
  categoryId: string,
  text: string,
): Promise<void> {
  await makeDir(categoryDir(projectPath, categoryId));
  await writeFile(categoryNotePath(projectPath, categoryId), text.endsWith("\n") ? text : `${text}\n`);
}
