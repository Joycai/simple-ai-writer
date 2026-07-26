/**
 * Book-level continuation memory: assembles the 【全书前情】 recap and the
 * previous chapter's verbatim ending for the "continue" task, resolved from
 * the book spine order (see ./outline) and per-chapter memory files.
 */

import { readFile } from "../fs/fileio";
import { BOOK_PRIOR_BUDGET_CHARS } from "./budget";
import { loadMemory, projectRelativePath, type DocMemory } from "./memory";
import {
  chapterTitle, findChapterContext, resolveVolumes,
  type Chapter, type ChapterContext, type Volume,
} from "./outline";
import type { FileNode } from "../project";

export interface BookContext {
  /** Ordered recap of prior chapters, from their memory files. */
  priorSummary: string;
  /** Verbatim ending of the immediately-preceding chapter (bridge). */
  prevChapterTail: string;
  /** Title of that previous chapter, for labeling. */
  prevChapterTitle: string;
}

/** How much of the previous chapter's ending to bring in as a bridge. */
export const BOOK_PREV_TAIL_CHARS = 2500;
/**
 * Only bridge with the previous chapter's ending when near this chapter's start.
 * Doubles as the UI's threshold for "this chapter is new enough that how it
 * opens is still an open question" — see AiPanel's 开篇方式 control.
 */
export const BOOK_PREV_TAIL_NEAR_START_CHARS = 4000;

/** A chapter's whole recap = its memory segment summaries joined in order. */
function chapterRecap(mem: DocMemory | null): string {
  if (!mem) return "";
  return mem.segments.map((s) => s.summary.trim()).filter(Boolean).join("\n");
}

/**
 * Which chapter's ending bridges into this one.
 *   - `undefined` — decide automatically: the preceding chapter, and only when
 *     the anchor sits near this chapter's start.
 *   - `null` — no bridge. The author declared this an independent opening.
 *   - a path — bridge with that chapter, wherever it sits in the book.
 */
export type BridgeChoice = string | null | undefined;

/**
 * Which chapter's ending (if any) bridges into the one being continued.
 *
 * The author's answer wins outright — including "none", and including a chapter
 * in an earlier volume, which the automatic pick can never reach because
 * findChapterContext only looks inside the current volume. With no answer, the
 * old rule stands: the preceding chapter, and only near this chapter's start,
 * where the chapter's own text isn't yet carrying continuity.
 */
export function resolveBridgeChapter(
  volumes: Volume[],
  ctx: ChapterContext,
  anchorOffset: number,
  bridge: BridgeChoice,
): Chapter | null {
  if (bridge === null) return null;
  if (bridge !== undefined) {
    // An unknown path (renamed or deleted since the author picked it) must not
    // silently fall back to the automatic pick — they asked for a specific
    // chapter, and quietly substituting another is worse than no bridge.
    return volumes.flatMap((v) => v.chapters).find((c) => c.path === bridge) ?? null;
  }
  return anchorOffset <= BOOK_PREV_TAIL_NEAR_START_CHARS ? ctx.prev : null;
}

/**
 * Assemble the book-level context for continuing the active chapter:
 *   - `priorSummary`: recap of earlier chapters (from their memory files),
 *     newest-first under budget so the closest plot survives truncation.
 *   - `prevChapterTail`: a chapter's verbatim ending, as the bridge into this
 *     one. Chosen by `bridge`; left out entirely when the author opted out.
 *
 * Returns null when there is nothing useful (no prior chapters, or no memory and
 * no bridge).
 *
 * @param priorBudgetChars Char budget for `priorSummary`, from the context budget
 *   planner (see ./budget). Defaults to the static constant when the caller has
 *   no plan — e.g. a model with no declared context size.
 * @param bridge The author's explicit bridge choice; see BridgeChoice.
 */
export async function buildBookContext(
  projectPath: string,
  fileTree: FileNode[],
  activeFilePath: string,
  anchorOffset: number,
  priorBudgetChars: number = BOOK_PRIOR_BUDGET_CHARS,
  bridge: BridgeChoice = undefined,
): Promise<BookContext | null> {
  const activeRel = projectRelativePath(projectPath, activeFilePath);
  if (!activeRel) return null;

  const volumes = await resolveVolumes(projectPath, fileTree);
  const ctx = findChapterContext(volumes, activeRel);
  if (!ctx) return null;
  // No earlier chapter in this volume is normally the end of it — unless the
  // author named a bridge chapter, which may well live in an earlier volume.
  if (ctx.prior.length === 0 && !bridge) return null;

  // Prior-chapter recaps, newest-first under budget, then restored to story order.
  const recaps = await Promise.all(
    ctx.prior.map(async (ch) => ({ ch, recap: chapterRecap(await loadMemory(projectPath, ch.path)) })),
  );
  // A zero budget means the planner found no room at all — honor it literally
  // rather than falling through to the "always keep the newest one" guarantee.
  const withRecap = priorBudgetChars > 0 ? recaps.filter((r) => r.recap) : [];
  const picked: { ch: Chapter; recap: string }[] = [];
  let used = 0;
  for (let i = withRecap.length - 1; i >= 0; i--) {
    const block = withRecap[i];
    const cost = block.recap.length + block.ch.name.length + 8;
    if (picked.length > 0 && used + cost > priorBudgetChars) break;
    picked.unshift(block);
    used += cost;
  }
  const priorParts = picked.map((p) => `〈${chapterTitle(p.ch)}〉\n${p.recap}`);
  if (picked.length < withRecap.length) {
    priorParts.unshift("……(更早章节的前情已因篇幅省略)");
  }
  const priorSummary = priorParts.join("\n\n");

  const bridgeChapter = resolveBridgeChapter(volumes, ctx, anchorOffset, bridge);

  let prevChapterTail = "";
  let prevChapterTitle = "";
  if (bridgeChapter) {
    prevChapterTitle = chapterTitle(bridgeChapter);
    try {
      const text = await readFile(bridgeChapter.path);
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
