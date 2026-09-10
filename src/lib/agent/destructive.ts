/**
 * Which approved lore steps still stop and ask (设计稿 02h 1g / 1i, threshold 1z B).
 *
 * A lore plan is one card for a whole pass, and the writes that follow land
 * without asking — that is the bargain that keeps a twenty-step tidy-up from
 * being twenty cards nobody reads. Two kinds of step break the bargain, because
 * they are the two a backup cannot really undo: the backup has the bytes, but
 * not the author's memory of what the entry said and why.
 *
 *   删条目            — a whole entry goes.
 *   替换超过六成正文  — most of an entry's text is replaced by something else.
 *
 * Everything here is pure except the citation scan, which reads documents.
 */

import { dice, diffDocument, diffInline, MAX_INLINE_CHARS } from "../diff";
import { BACKLINK_MAX_FILES, workspaceDocuments } from "../fs/links";
import { readFile } from "../fs/fileio";
import type { LoreEntity, LoreIndex } from "../lore";
import { collectCiteTargets, resolveCitation } from "../lore/citations";
import { projectRelative } from "../paths";

/** Share of an entry's text a write may replace before the step stops (1z B). */
export const MAJOR_REWRITE_RATIO = 0.6;

/**
 * Entries shorter than this never stop, however much of them is replaced.
 *
 * Not in the design, and deliberately so: the rule is about text an author
 * would miss, and the commonest write that replaces 100% of an entry is filling
 * in a stub — 「待补充」 becoming three paragraphs. Stopping there would teach
 * the author that this card fires on nothing, which is how a guard stops being
 * read.
 */
export const MAJOR_REWRITE_MIN_CHARS = 200;

/** An entry file's text without its frontmatter — 「正文」, which is what the ratio is of. */
export function bodyOf(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/**
 * How much of the old body a write replaces: removed characters over the old
 * body's length.
 *
 * Token-level where the texts are small enough, so a correction threaded
 * through a paragraph counts the characters it touched rather than the
 * paragraph; whole changed lines past that, and the whole body when even a line
 * diff is refused.
 */
export function rewriteRatio(before: string, after: string): { removed: number; original: number } {
  const old = bodyOf(before);
  const next = bodyOf(after);
  return { removed: removedChars(old, next), original: old.length };
}

/** Whether a write replaces enough of a substantial entry to stop and ask. */
export function isMajorRewrite(before: string, after: string): boolean {
  const { removed, original } = rewriteRatio(before, after);
  if (original < MAJOR_REWRITE_MIN_CHARS) return false;
  return removed / original >= MAJOR_REWRITE_RATIO;
}

function removedChars(old: string, next: string): number {
  if (old === next) return 0;
  if (old.length <= MAX_INLINE_CHARS && next.length <= MAX_INLINE_CHARS) {
    const segs = diffInline(old, next);
    // Two texts that share almost nothing are not an edit at all; counting
    // their incidental common characters as "kept" would understate the loss.
    if (segs && dice(segs) > 0) {
      return segs.reduce((n, s) => (s.type === "del" ? n + s.text.length : n), 0);
    }
    if (segs) return old.length;
  }
  const diff = diffDocument(old, next, { inline: false });
  return diff.degraded ? old.length : diff.stats.removedChars;
}

export interface Citations {
  /** Documents citing the entity, project-relative. */
  documents: string[];
  /** False when the scan hit its cap: the list is a floor, not a total. */
  complete: boolean;
}

/**
 * Documents that cite an entity with `[[lore:…]]`.
 *
 * The one fact on a 删条目 card that stops being knowable once the entry is
 * gone: afterwards those citations simply fail to resolve, and nothing says
 * they ever pointed anywhere. Resolved through the index the way the renderer
 * resolves them — name, then alias, then `category/id` — so a citation written
 * with an alias counts.
 */
export async function citingDocuments(
  projectPath: string,
  entity: LoreEntity,
  loreIndex: LoreIndex,
): Promise<Citations> {
  let files: string[];
  try {
    files = await workspaceDocuments(projectPath);
  } catch {
    return { documents: [], complete: false };
  }

  const documents: string[] = [];
  for (const file of files.slice(0, BACKLINK_MAX_FILES)) {
    let text: string;
    try {
      text = await readFile(file);
    } catch {
      continue;
    }
    const cites = collectCiteTargets(text).some(
      (target) => resolveCitation(target, loreIndex)?.dirPath === entity.dirPath,
    );
    if (cites) documents.push(projectRelative(projectPath, file) ?? file);
  }
  return { documents, complete: files.length <= BACKLINK_MAX_FILES };
}
