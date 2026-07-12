/**
 * Book-level continuation memory: assembles the 【全书前情】 recap and the
 * previous chapter's verbatim ending for the "continue" task, resolved from
 * the book spine order (see ./outline) and per-chapter memory files.
 */

import { readFile } from "../fs/fileio";
import { loadMemory, projectRelativePath, type DocMemory } from "./memory";
import { chapterTitle, findChapterContext, resolveVolumes, type Chapter } from "./outline";
import type { FileNode } from "../project";

export interface BookContext {
  /** Ordered recap of prior chapters, from their memory files. */
  priorSummary: string;
  /** Verbatim ending of the immediately-preceding chapter (bridge). */
  prevChapterTail: string;
  /** Title of that previous chapter, for labeling. */
  prevChapterTitle: string;
}

/** Char budget for the 【全书前情】 layer (~1600 tokens). */
const BOOK_PRIOR_BUDGET_CHARS = 5000;
/** How much of the previous chapter's ending to bring in as a bridge. */
const BOOK_PREV_TAIL_CHARS = 2500;
/** Only bridge with the previous chapter's ending when near this chapter's start. */
const BOOK_PREV_TAIL_NEAR_START_CHARS = 4000;

/** A chapter's whole recap = its memory segment summaries joined in order. */
function chapterRecap(mem: DocMemory | null): string {
  if (!mem) return "";
  return mem.segments.map((s) => s.summary.trim()).filter(Boolean).join("\n");
}

/**
 * Assemble the book-level context for continuing the active chapter:
 *   - `priorSummary`: recap of earlier chapters (from their memory files),
 *     newest-first under budget so the closest plot survives truncation.
 *   - `prevChapterTail`: the previous chapter's verbatim ending, included only
 *     when the cursor is near this chapter's start (a fresh chapter) — deeper in,
 *     the chapter's own recent text already carries continuity.
 *
 * Returns null when there is nothing useful (no prior chapters, or no memory and
 * not near a chapter boundary).
 */
export async function buildBookContext(
  projectPath: string,
  fileTree: FileNode[],
  activeFilePath: string,
  anchorOffset: number,
): Promise<BookContext | null> {
  const activeRel = projectRelativePath(projectPath, activeFilePath);
  if (!activeRel) return null;

  const volumes = await resolveVolumes(projectPath, fileTree);
  const ctx = findChapterContext(volumes, activeRel);
  if (!ctx || ctx.prior.length === 0) return null;

  // Prior-chapter recaps, newest-first under budget, then restored to story order.
  const recaps = await Promise.all(
    ctx.prior.map(async (ch) => ({ ch, recap: chapterRecap(await loadMemory(projectPath, ch.path)) })),
  );
  const withRecap = recaps.filter((r) => r.recap);
  const picked: { ch: Chapter; recap: string }[] = [];
  let used = 0;
  for (let i = withRecap.length - 1; i >= 0; i--) {
    const block = withRecap[i];
    const cost = block.recap.length + block.ch.name.length + 8;
    if (picked.length > 0 && used + cost > BOOK_PRIOR_BUDGET_CHARS) break;
    picked.unshift(block);
    used += cost;
  }
  const priorParts = picked.map((p) => `〈${chapterTitle(p.ch)}〉\n${p.recap}`);
  if (picked.length < withRecap.length) {
    priorParts.unshift("……(更早章节的前情已因篇幅省略)");
  }
  const priorSummary = priorParts.join("\n\n");

  // Previous chapter's ending — the bridge for a freshly-started chapter.
  let prevChapterTail = "";
  let prevChapterTitle = "";
  if (ctx.prev && anchorOffset <= BOOK_PREV_TAIL_NEAR_START_CHARS) {
    prevChapterTitle = chapterTitle(ctx.prev);
    try {
      const text = await readFile(ctx.prev.path);
      if (text) {
        let start = Math.max(0, text.length - BOOK_PREV_TAIL_CHARS);
        if (start > 0) {
          // Snap forward to a paragraph boundary so the excerpt reads cleanly.
          const para = text.indexOf("\n\n", start);
          if (para >= 0 && para < text.length - 200) start = para + 2;
        }
        prevChapterTail = text.slice(start).trim();
      }
    } catch {
      /* best-effort — a missing/unreadable prev chapter just yields no bridge */
    }
  }

  if (!priorSummary && !prevChapterTail) return null;
  return { priorSummary, prevChapterTail, prevChapterTitle };
}
