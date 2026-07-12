/**
 * RAG context assembly for V1 — alias-based keyword matching (no embeddings).
 * Scans lore entity aliases and names against selected text / recent content,
 * then assembles a 4-layer context string:
 *   Layer 1 – System prompt (from active prompt)
 *   Layer 2 – Matched lore entity summaries (auto + manually pinned)
 *   Layer 3 – Optional extras: additional knowledge, outline/direction
 *   Layer 4 – Story memory (compacted summary of everything before the
 *             verbatim window — see lib/memory.ts) + recent chapter context
 *             (≤800 tokens before cursor)
 *   Layer 5 – Current selection / task instruction
 */

import i18n from "../i18n";
import { readFile } from "./fileio";
import type { LoreIndex } from "./lore";
import { selectMemoryForContext, type DocMemory } from "./memory";

const MAX_AUTO_LORE_CARDS = 3;
const APPROX_CHARS_PER_TOKEN = 3; // rough CJK-aware estimate
const MAX_LORE_CHARS = 600 * APPROX_CHARS_PER_TOKEN;
const MAX_CONTEXT_CHARS = 800 * APPROX_CHARS_PER_TOKEN;

/** Extra options available for AI tasks (continue / polish / rewrite / summary). */
export interface TaskExtras {
  /** dirPaths of manually pinned lore entities — merged with auto-matched. */
  manualLorePaths?: string[];
  /** Outline or writing direction the model should follow ("continue" only). */
  outline?: string;
  /** Free-form background knowledge not captured in the Lore system ("continue" only). */
  additionalKnowledge?: string;
  /** Extra requirement appended to the task instruction (polish/rewrite/summary). */
  requirement?: string;
  /**
   * Append/continuation mode (the "continue" task). The selection, if any, is
   * an *anchor* — text to write after — not an edit target: no 【选中内容】 block
   * is emitted, and the reference window ends at the selection's END (so the
   * selected text becomes part of 【近期内容】). Falls back to the document end
   * when there is no selection.
   */
  appendMode?: boolean;
  /**
   * How many characters of text *before* the selection to include as reference
   * context (polish/rewrite/summary). 0 = none. Falls back to MAX_CONTEXT_CHARS
   * when undefined (e.g. "continue").
   */
  contextChars?: number;
}

export interface ContextBundle {
  systemPrompt: string;
  loreSnippets: string;
  /** Compacted story-memory summary of text before the verbatim window. */
  storySummary: string;
  recentContext: string;
  taskText: string;
  outline?: string;
  additionalKnowledge?: string;
  /** Rough estimated total token count */
  estimatedTokens: number;
}

// Keep only letters/numbers (drops whitespace, punctuation, and markdown
// markers) so a preview-mode selection can still be located in the raw source.
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Strip a string down to lowercased word characters. */
function normalizeText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (WORD_CHAR.test(s[i])) out += s[i].toLowerCase();
  }
  return out;
}

/** Same, but also record each kept char's original index for mapping back. */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (WORD_CHAR.test(s[i])) {
      norm += s[i].toLowerCase();
      map.push(i);
    }
  }
  return { norm, map };
}

/**
 * Find where `selection` starts in `documentText`, returning its source offset
 * (or -1 if it can't be located). Tries a verbatim match first, then falls back
 * to a word-character-only match so a rendered/preview selection (missing
 * markdown markup and typographic transforms) still resolves to the source.
 */
export function locateSelectionOffset(documentText: string, selection: string): number {
  const exact = documentText.lastIndexOf(selection);
  if (exact >= 0) return exact;

  const nSel = normalizeText(selection);
  if (!nSel) return -1;
  const { norm, map } = normalizeWithMap(documentText);
  const ni = norm.lastIndexOf(nSel);
  return ni >= 0 ? map[ni] : -1;
}

/** Return lore entities whose name or aliases appear in the target text. */
function matchEntities(text: string, lore: LoreIndex): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  for (const [, entities] of Object.entries(lore)) {
    for (const entity of entities) {
      const terms = [entity.name, ...(entity.aliases ?? [])];
      if (terms.some((t) => t && lower.includes(t.toLowerCase()))) {
        matched.push(entity.dirPath);
        if (matched.length >= MAX_AUTO_LORE_CARDS) return matched;
      }
    }
  }
  return matched;
}

/** Load an entity's index.md content (summary section only). */
async function loadEntitySummary(dirPath: string): Promise<string> {
  try {
    const content = await readFile(`${dirPath}/index.md`);
    return content.slice(0, MAX_LORE_CHARS);
  } catch {
    return "";
  }
}

/**
 * Build the context bundle for an AI task.
 *
 * @param systemPrompt     Active system prompt content
 * @param loreIndex        Full lore index from loreStore
 * @param documentText     Full current document text
 * @param selection        Selected text or empty string
 * @param taskInstruction  Human-readable instruction appended after selection
 * @param extras           Optional "continue" task extras (lore pins, outline, knowledge)
 * @param selectionRange   Precise source offsets of the selection (editor mode);
 *                         when given, the "recent context" is sliced exactly
 *                         before it instead of relying on string matching.
 * @param memory           Story memory for the current document, if one exists;
 *                         its segment summaries feed the 【前情提要】 layer.
 */
export async function assembleContext(
  systemPrompt: string,
  loreIndex: LoreIndex,
  documentText: string,
  selection: string,
  taskInstruction: string,
  extras?: TaskExtras,
  selectionRange?: { from: number; to: number } | null,
  memory?: DocMemory | null
): Promise<ContextBundle> {
  // Layer 2: auto-match entities, then prepend any manually pinned ones (deduped)
  const matchTarget = selection + documentText.slice(-500);
  const autoEntityPaths = matchEntities(matchTarget, loreIndex);
  const manualPaths = extras?.manualLorePaths ?? [];
  const allEntityPaths = [...new Set([...manualPaths, ...autoEntityPaths])];

  const loreSnippets = (
    await Promise.all(allEntityPaths.map(loadEntitySummary))
  )
    .filter(Boolean)
    .join("\n\n---\n\n");

  // Layer 4: recent context — the text immediately *before* the selection, used
  // only to keep the model's continuation/edit coherent (it is NOT the edit
  // target). Resolve where the selection ends so we can slice what precedes it:
  //   1. Precise source offsets (editor mode) — trust them if they still match.
  //   2. Otherwise locate the selection verbatim in the source.
  //   3. No selection at all ("continue") — use the end of the document.
  // Crucially, when a selection exists but can't be located (e.g. preview-mode
  // rendered text that doesn't match the markdown source), we DO NOT fall back
  // to the document tail — that used to make edits silently target the ending.
  const span = extras?.contextChars ?? MAX_CONTEXT_CHARS;
  const appendMode = extras?.appendMode ?? false;
  let endIdx: number;
  const rangeMatches =
    selectionRange &&
    documentText.slice(selectionRange.from, selectionRange.to) === selection;
  if (appendMode) {
    // Continue: anchor after the selection so the selected text is context, not
    // a target. No selection → continue from the document end.
    if (rangeMatches) {
      endIdx = selectionRange!.to;
    } else if (selection) {
      const off = locateSelectionOffset(documentText, selection);
      endIdx = off >= 0 ? off + selection.length : documentText.length;
    } else {
      endIdx = documentText.length;
    }
  } else if (rangeMatches) {
    endIdx = selectionRange!.from;
  } else if (selection) {
    endIdx = locateSelectionOffset(documentText, selection); // -1 when not found → no context
  } else {
    endIdx = documentText.length;
  }
  const recentContext =
    endIdx >= 0 && span > 0
      ? documentText.slice(Math.max(0, endIdx - span), endIdx).trim()
      : "";

  // Story memory: summaries of everything before the verbatim window. Only
  // segments *before* the window are eligible — for a mid-document selection
  // this deliberately excludes later plot, so an edit can't "know the future".
  // When the selection can't be located (endIdx = -1) we skip memory too for
  // the same reason we skip recent context: we don't know where we are.
  const detailStart = endIdx >= 0 ? Math.max(0, endIdx - span) : -1;
  const storySummary = memory ? selectMemoryForContext(memory, detailStart) : "";

  const requirement = extras?.requirement?.trim();
  const outline = extras?.outline?.trim() || undefined;
  const additionalKnowledge = extras?.additionalKnowledge?.trim() || undefined;

  // Layer 5: task text — base instruction plus any extra requirement. In
  // append mode the selection is an anchor (already folded into 【近期内容】),
  // so it is never echoed back as a 【选中内容】 edit target.
  const baseTask = selection && !appendMode
    ? `【选中内容】\n${selection}\n\n${taskInstruction}`
    : taskInstruction;
  const taskParts = [baseTask];
  if (requirement) taskParts.push(`【额外要求】\n${requirement}`);
  // When an outline was actually filled in, explicitly bind the model to it:
  // the 【大纲/写作方向】 data block alone is easy for smaller local models to
  // treat as background. Empty outline → no directive → free continuation.
  if (outline) taskParts.push(i18n.t("ai.instructions.followOutline"));
  const taskText = taskParts.join("\n\n");

  // Rough token estimate
  const total =
    systemPrompt.length + loreSnippets.length + storySummary.length + recentContext.length +
    taskText.length + (outline?.length ?? 0) + (additionalKnowledge?.length ?? 0);
  const estimatedTokens = Math.ceil(total / APPROX_CHARS_PER_TOKEN);

  return { systemPrompt, loreSnippets, storySummary, recentContext, taskText, outline, additionalKnowledge, estimatedTokens };
}

/** Format the assembled context into a messages array for OpenAI/Gemini APIs. */
export function bundleToMessages(
  bundle: ContextBundle
): { role: "system" | "user"; content: string }[] {
  const parts: string[] = [];

  if (bundle.loreSnippets) {
    parts.push(`【设定资料】\n${bundle.loreSnippets}`);
  }
  if (bundle.additionalKnowledge) {
    parts.push(`【附加知识】\n${bundle.additionalKnowledge}`);
  }
  if (bundle.outline) {
    parts.push(`【大纲/写作方向】\n${bundle.outline}`);
  }
  if (bundle.storySummary) {
    parts.push(`【前情提要】\n${bundle.storySummary}`);
  }
  if (bundle.recentContext) {
    parts.push(`【近期内容】\n${bundle.recentContext}`);
  }
  parts.push(bundle.taskText);

  return [
    { role: "system", content: bundle.systemPrompt || i18n.t("ai.instructions.system") },
    { role: "user", content: parts.join("\n\n") },
  ];
}
