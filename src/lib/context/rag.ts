/**
 * RAG context assembly for V1 — alias-based keyword matching (no embeddings).
 * Scans lore entity aliases and names against selected text / recent content,
 * then assembles a 4-layer context string:
 *   Layer 1 – System prompt (from active prompt)
 *   Layer 2 – Matched lore (auto + manually pinned), selected per-facet under
 *             a shared budget — see ./loreSelect
 *   Layer 3 – Optional extras: additional knowledge, outline/direction
 *   Layer 4 – Story memory (compacted summary of everything before the
 *             verbatim window — see ./memory) + recent chapter context
 *             (≤800 tokens before cursor)
 *   Layer 5 – Current selection / task instruction
 */

import i18n from "../../i18n";
import type { MessageContent } from "../ai/types";
import type { LoreEntity, LoreIndex } from "../lore";
import { promptParams, sectionLabel } from "../profile/active";
import { RECENT_WINDOW_MIN_CHARS } from "./budget";
import { selectLore, type LoreActivationReport } from "./loreSelect";
import { selectMemoryForContext, type DocMemory } from "./memory";

const APPROX_CHARS_PER_TOKEN = 3; // rough CJK-aware estimate
/**
 * Default verbatim recent-content window when a task declares no contextChars.
 * Re-exported from the budget planner, which owns the constant so the planner,
 * this assembler and the AI panel can't drift apart.
 */
export const MAX_CONTEXT_CHARS = RECENT_WINDOW_MIN_CHARS;

/** Extra options available for AI tasks (continue / polish / rewrite / summary). */
export interface TaskExtras {
  /**
   * The pack that declared the task being assembled (`ResolvedTask.packId`) —
   * scopes the 【…】 block labels to that pack's wording. Omitted (base tasks,
   * chat) → the app-level neutral labels.
   */
  packId?: string;
  /** dirPaths of manually pinned lore entities — merged with auto-matched. */
  manualLorePaths?: string[];
  /** Outline or writing direction the model should follow ("continue" only). */
  outline?: string;
  /** Free-form background knowledge not captured in the Lore system ("continue" only). */
  additionalKnowledge?: string;
  /** Extra requirement appended to the task instruction (polish/rewrite/summary). */
  requirement?: string;
  /**
   * Which chapter's ending bridges into this one ("continue" only).
   * `undefined` = decide automatically, `null` = independent opening, a path =
   * that chapter. Consumed by aiTaskStore before assembly — see ./bookContext.
   */
  bridgeChapter?: string | null;
  /**
   * Append/continuation mode (the "continue" task). The selection, if any, is
   * an *anchor* — text to write after — not an edit target: no 【选中内容】 block
   * is emitted, and the reference window ends at the selection's END (so the
   * selected text becomes part of 【近期内容】). Falls back to the document end
   * when there is no selection.
   */
  appendMode?: boolean;
  /**
   * Exact offset a continuation attaches at, when the caller has already
   * decided ("continue" only, with appendMode).
   *
   * The AiPanel offers an explicit position — chapter opening, chapter end, or
   * after the marked passage — and that choice cannot be re-derived downstream
   * from the selection alone: an opening is offset 0 whether or not anything is
   * selected. Passing the resolved offset keeps the prompt's reference window,
   * the budget, the book-context bridge and the eventual insert all measuring
   * from the one place the author was shown. Omitted → derived as before.
   */
  appendAnchor?: number;
  /**
   * How many characters of text *before* the selection to include as reference
   * context (polish/rewrite/summary). 0 = none. Falls back to MAX_CONTEXT_CHARS
   * when undefined (e.g. "continue").
   */
  contextChars?: number;
  /**
   * Book-level continuation memory (the "continue" task), resolved from the
   * outline order: a recap of prior chapters plus the previous chapter's ending.
   * See ./bookContext. Only consumed in appendMode.
   */
  bookContext?: {
    priorSummary: string;
    prevChapterTail: string;
    prevChapterTitle: string;
  };
  /**
   * Project-relative path of the document being worked on, emitted as its own
   * block for **tool-using tasks only**.
   *
   * Without it a task that browses the project can't tell which of the files it
   * lists is the one it was invoked on — 「找到本文档之前最近的一份周报」 has no
   * anchor. 对照上期 happened to work in testing because the draft's own heading
   * said 「第 31 周」; a document that doesn't name its period would have left the
   * model guessing, and picking the wrong file produces output that looks
   * entirely normal.
   *
   * Omitted for toolless tasks: they can't look at anything else, so naming the
   * file only spends tokens.
   */
  currentFilePath?: string;
  /**
   * A description of the current document to send *instead of* its text —
   * title, length, heading outline (see ./docFocus). Rendered under the same
   * 【当前文件】 block, right after the path.
   *
   * The chat's default: most questions are not about the file that happens to
   * be open, and a tool-using assistant can read it the moment it decides one
   * is. Pass `contextChars: 0` alongside it — a brief and a window are two
   * answers to the same question.
   */
  documentBrief?: string;
  /**
   * Extra text folded into the lore **match target** without being injected.
   *
   * The match target is otherwise the selection plus the text around it, which
   * is right for a writing task (the lore that matters is the lore in the
   * passage) and wrong for a conversation, where the question is the thing
   * worth matching on — and, once the document window stops being injected by
   * default, the only thing left to match on at all.
   */
  extraMatchText?: string;
}

export interface ContextBundle {
  systemPrompt: string;
  loreSnippets: string;
  /** Why each entity/facet was (or wasn't) injected — surfaced in the UI. */
  loreReport: LoreActivationReport;
  /** Cross-chapter recap of everything before the current chapter (continue). */
  priorChaptersSummary: string;
  /** Verbatim ending of the previous chapter (continue, near chapter start). */
  prevChapterTail: string;
  /** Title of the previous chapter, for labeling the tail block. */
  prevChapterTitle: string;
  /** Compacted story-memory summary of text before the verbatim window. */
  storySummary: string;
  recentContext: string;
  /** Project-relative path of the current document (tool-using tasks only). */
  currentFilePath?: string;
  /** The current document described rather than injected — see TaskExtras. */
  documentBrief?: string;
  /**
   * The pack that declared the task this bundle was assembled for — the
   * wording anchor `bundleToMessages` resolves 【…】 labels against. Absent
   * for base tasks and project-scoped assemblies (chat), which speak the
   * app-level neutral wording.
   */
  packId?: string;
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

/**
 * Where a continuation attaches to the document.
 *
 * The single source of truth for "continue": the prompt slices its 【近期内容】
 * backwards from here, the panel labels this spot for the author, and the
 * generated passage is inserted here. Keep those three reading from this
 * function — a continuation that is written from one place and lands in
 * another is the one failure mode none of them can detect on their own.
 *
 * A committed selection anchors the continuation just after it; anything that
 * can no longer be found in the live text falls back to the document end,
 * which is where a continuation belongs anyway.
 */
export function resolveAppendAnchor(
  documentText: string,
  selection: string,
  selectionRange?: { from: number; to: number } | null,
): number {
  return locateAppendAnchor(documentText, selection, selectionRange) ?? documentText.length;
}

/**
 * The same anchor, but null instead of the document end when a non-empty
 * selection cannot be found at all.
 *
 * The difference matters wherever "continue from this passage" was an explicit
 * choice: silently relocating that to the end of the chapter puts prose
 * somewhere the author did not ask for. Callers with no such choice to honour
 * want `resolveAppendAnchor`, where the document end is the right default.
 */
export function locateAppendAnchor(
  documentText: string,
  selection: string,
  selectionRange?: { from: number; to: number } | null,
): number | null {
  if (
    selectionRange &&
    documentText.slice(selectionRange.from, selectionRange.to) === selection
  ) {
    return selectionRange.to;
  }
  if (selection) {
    const off = locateSelectionOffset(documentText, selection);
    return off >= 0 ? off + selection.length : null;
  }
  return documentText.length;
}

/**
 * Where an in-place edit (polish / rewrite) will overwrite the document.
 *
 * Null means "nowhere reliable" — the caller appends instead, which is
 * lossless. That is always the right answer when we cannot be certain, because
 * this range *replaces prose*: guessing wrong destroys a passage the author
 * never pointed at.
 *
 * @param source Which mechanism committed the target; see aiTaskStore.
 *   A marked range's offsets are maintained by CodeMirror itself, so if they
 *   have stopped describing the document then something is wrong that a text
 *   search cannot repair — and overwriting whatever else happens to match the
 *   text would be far worse than appending. Only a dragged selection, whose
 *   offsets are a snapshot (or absent entirely, in the preview pane), earns the
 *   verbatim-search fallback.
 */
export function resolveEditRange(
  documentText: string,
  selection: string,
  selectionRange: { from: number; to: number } | null,
  source: "marker" | "commit" | null,
): { from: number; to: number } | null {
  if (!selection) return null;
  if (
    selectionRange &&
    documentText.slice(selectionRange.from, selectionRange.to) === selection
  ) {
    return selectionRange;
  }
  if (source === "marker") return null;
  // Two guards, because unlike every other selection lookup this one overwrites:
  //   • only an exact match counts. locateSelectionOffset has a normalized
  //     fallback, but the span it reports isn't `selection.length` long, so it
  //     cannot be turned into a replace range;
  //   • the match must be unique. Repeated lines are ordinary in a draft, and
  //     silently rewriting the *last* one would destroy prose the author never
  //     selected. Ambiguous → append.
  const first = documentText.indexOf(selection);
  if (first < 0 || first !== documentText.lastIndexOf(selection)) return null;
  return { from: first, to: first + selection.length };
}

/**
 * Splice a generated continuation into the document at `at`.
 *
 * The mirror of resolveAppendAnchor. It spaces the passage into the prose
 * instead of assuming a blank line is already there: mid-document the
 * following paragraph supplies its own separator, and an empty chapter wants
 * no leading gap at all.
 */
export function spliceContinuation(
  documentText: string,
  at: number,
  passage: string,
): string {
  const before = documentText.slice(0, at);
  const after = documentText.slice(at);
  const lead = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = !after || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return before + lead + passage + trail + after;
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
 * @param loreBudgetChars  Char budget for the lore block (user setting × 3);
 *                         falls back to loreSelect's default when omitted.
 * @param memoryBudgetChars Char budget for the 【前情提要】 layer, from the context
 *                         budget planner (see ./budget); falls back to memory.ts's
 *                         static constant when omitted.
 */
export async function assembleContext(
  systemPrompt: string,
  loreIndex: LoreIndex,
  documentText: string,
  selection: string,
  taskInstruction: string,
  extras?: TaskExtras,
  selectionRange?: { from: number; to: number } | null,
  memory?: DocMemory | null,
  loreBudgetChars?: number,
  memoryBudgetChars?: number
): Promise<ContextBundle> {
  // Resolve where the selection/anchor sits *before* building the lore-match
  // target and the recent-context window below — both need to look at text
  // near the edit, not always the document's end. "Continue" can anchor
  // mid-document (an append-mode selection anchor), and an edit's selection
  // is wherever the author put it, so keying off the tail unconditionally
  // checks the wrong neighborhood whenever the anchor isn't already there.
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
    endIdx = extras?.appendAnchor ?? resolveAppendAnchor(documentText, selection, selectionRange);
  } else if (rangeMatches) {
    endIdx = selectionRange!.from;
  } else if (selection) {
    endIdx = locateSelectionOffset(documentText, selection); // -1 when not found → no context
  } else {
    endIdx = documentText.length;
  }

  // Layer 2: facet-aware layered selection (summary → core → facets under a
  // shared budget) — pins go first, auto-matched entities follow. See
  // ./loreSelect for the algorithm and the activation report it returns.
  // The tail window is anchor-relative, same reasoning as recentContext below
  // (and the same "don't guess when the anchor is lost" rule: endIdx < 0
  // contributes no tail at all rather than falling back to the document end).
  const MATCH_TAIL_CHARS = 500;
  const matchTarget = selection + (
    endIdx >= 0 ? documentText.slice(Math.max(0, endIdx - MATCH_TAIL_CHARS), endIdx) : ""
  ) + (extras?.extraMatchText ? `\n${extras.extraMatchText}` : "");
  const { text: loreSnippets, report: loreReport } = await selectLore(
    matchTarget,
    loreIndex,
    extras?.manualLorePaths ?? [],
    loreBudgetChars,
  );

  // Layer 4: recent context — the text immediately *before* the selection, used
  // only to keep the model's continuation/edit coherent (it is NOT the edit
  // target).
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
  const storySummary = memory
    ? selectMemoryForContext(memory, detailStart, memoryBudgetChars)
    : "";

  // Book-level continuation memory: a recap of prior chapters and the previous
  // chapter's verbatim ending, resolved from the outline order upstream. Only
  // meaningful when continuing (appendMode) — a mid-document edit stays local.
  const book = appendMode ? extras?.bookContext : undefined;
  const priorChaptersSummary = book?.priorSummary?.trim() || "";
  const prevChapterTail = book?.prevChapterTail?.trim() || "";
  const prevChapterTitle = book?.prevChapterTitle || "";

  const packId = extras?.packId;
  const requirement = extras?.requirement?.trim();
  const outline = extras?.outline?.trim() || undefined;
  const additionalKnowledge = extras?.additionalKnowledge?.trim() || undefined;

  // Layer 5: task text — base instruction plus any extra requirement. In
  // append mode the selection is an anchor (already folded into 【近期内容】),
  // so it is never echoed back as a 【选中内容】 edit target.
  const baseTask = selection && !appendMode
    ? `【${sectionLabel("selection", packId)}】\n${selection}\n\n${taskInstruction}`
    : taskInstruction;
  const taskParts = [baseTask];
  if (requirement) taskParts.push(`【${sectionLabel("requirement", packId)}】\n${requirement}`);
  // When an outline was actually filled in, explicitly bind the model to it:
  // the 【大纲/写作方向】 data block alone is easy for smaller local models to
  // treat as background. Empty outline → no directive → free continuation.
  if (outline) taskParts.push(i18n.t("ai.instructions.followOutline", promptParams(i18n.language === "zh-CN", packId)));
  const taskText = taskParts.join("\n\n");

  // Rough token estimate
  const total =
    systemPrompt.length + loreSnippets.length + priorChaptersSummary.length +
    prevChapterTail.length + storySummary.length + recentContext.length +
    taskText.length + (outline?.length ?? 0) + (additionalKnowledge?.length ?? 0);
  const estimatedTokens = Math.ceil(total / APPROX_CHARS_PER_TOKEN);

  return {
    systemPrompt, loreSnippets, loreReport, priorChaptersSummary, prevChapterTail,
    prevChapterTitle, storySummary, recentContext, taskText, outline,
    additionalKnowledge, estimatedTokens, currentFilePath: extras?.currentFilePath,
    documentBrief: extras?.documentBrief,
    packId,
  };
}

/**
 * The system prompt to use when the author has no prompt template selected.
 *
 * One neutral writing-collaborator identity for every project: packs add
 * tasks and categories, they do not preset the AI's persona — the domain
 * expertise lives in each pack task's *instruction* instead (see
 * `ai.instructions.bidRespond` etc.). Every caller that resolves a system
 * prompt still goes through here rather than reaching for the i18n key, so a
 * future per-project override has one seam to land in.
 */
export function profileSystemPrompt(): string {
  return i18n.t("ai.instructions.system");
}

/**
 * Format the assembled context into a messages array for OpenAI/Gemini APIs.
 *
 * Block labels come from the active workspace profile, so a TTRPG module gets
 * 【上一场景结尾】where a novel gets 【上一章结尾】. The wording is not cosmetic:
 * these headings are the only thing telling the model what each block *is*, and
 * a novel-flavoured label on a non-novel project actively misleads it.
 */
/** The 【…】 context sections shared by both message shapes — task text excluded. */
function bundleContextSections(bundle: ContextBundle): string[] {
  const parts: string[] = [];

  // First, because it tells a tool-using task which of the files it is about to
  // list is the one it was invoked on.
  // The brief (when there is one) continues the same block: it is more about
  // the same file, and a second 【…】 header for "and here is what else we know
  // about the path we just gave you" reads as a different subject.
  if (bundle.currentFilePath || bundle.documentBrief) {
    const body = [bundle.currentFilePath, bundle.documentBrief].filter(Boolean).join("\n");
    parts.push(`【${sectionLabel("currentFile", bundle.packId)}】\n${body}`);
  }
  if (bundle.loreSnippets) {
    parts.push(`【${sectionLabel("knowledge", bundle.packId)}】\n${bundle.loreSnippets}`);
  }
  if (bundle.additionalKnowledge) {
    parts.push(`【${sectionLabel("additionalKnowledge", bundle.packId)}】\n${bundle.additionalKnowledge}`);
  }
  if (bundle.outline) {
    parts.push(`【${sectionLabel("outline", bundle.packId)}】\n${bundle.outline}`);
  }
  if (bundle.priorChaptersSummary) {
    parts.push(`【${sectionLabel("priorAll", bundle.packId)}】\n${bundle.priorChaptersSummary}`);
  }
  if (bundle.storySummary) {
    parts.push(`【${sectionLabel("priorRecap", bundle.packId)}】\n${bundle.storySummary}`);
  }
  if (bundle.prevChapterTail) {
    const prevTail = sectionLabel("prevTail", bundle.packId);
    const label = bundle.prevChapterTitle
      ? `【${prevTail}·${bundle.prevChapterTitle}】`
      : `【${prevTail}】`;
    parts.push(`${label}\n${bundle.prevChapterTail}`);
  }
  if (bundle.recentContext) {
    parts.push(`【${sectionLabel("recent", bundle.packId)}】\n${bundle.recentContext}`);
  }
  return parts;
}

export function bundleToMessages(
  bundle: ContextBundle
): { role: "system" | "user"; content: string }[] {
  const parts = [...bundleContextSections(bundle), bundle.taskText];
  return [
    { role: "system", content: bundle.systemPrompt || profileSystemPrompt() },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** What one turn's automatic retrieval produced (docs/feature/agent/chat-memory-plan.md §5). */
export interface TurnInjection {
  /** The 【…】 blocks to append as one user message; "" when nothing net-new. */
  text: string;
  /** Lore activation, for the context-seeded log event. */
  loreReport: LoreActivationReport;
  /** The activated entities resolved back to index objects, for the ledger. */
  matchedEntities: LoreEntity[];
  /** Recent-window chars injected; 0 when the document didn't change. */
  docChars: number;
  memoryChars: number;
}

/**
 * Per-turn retrieval for the chat: what the seed did once, re-run against the
 * *current* question — minus everything the injection ledger says is already
 * in the conversation. Returns text only for the net increase, so an
 * unchanged context appends nothing and the wire history stays append-only
 * (replacing an old block would invalidate the prompt-cache prefix).
 *
 * `doc` is passed when the conversation has to be told something about the
 * open document: that the focus moved to another file (its `brief`), or that
 * this turn is about the manuscript after all and wants the text (`body`).
 * Either half may be sent alone — a switch onto a file nobody asked about is
 * brief-only, and 「把这一段改紧凑些」 five turns into the same file is
 * body-only.
 */
export async function assembleTurnInjection(opts: {
  loreIndex: LoreIndex;
  /** Question + quote + current document tail — same targets the seed used. */
  matchTarget: string;
  excludeDirs: ReadonlySet<string>;
  loreBudgetChars?: number;
  doc?: {
    filePath: string;
    /**
     * The document described rather than injected (./docFocus). Sent when the
     * focus moved to a file the conversation has not been told about — the
     * assistant has to know *where* the author is even on turns whose question
     * has nothing to do with the manuscript.
     */
    brief?: string | null;
    /**
     * The window + recap, for a turn that actually points at the document.
     * Null: the brief alone, and `read_file` if the assistant wants more.
     */
    body?: {
      documentText: string;
      memory: DocMemory | null;
      contextChars?: number;
      memoryBudgetChars?: number;
    } | null;
  } | null;
}): Promise<TurnInjection> {
  const { text: loreSnippets, report } = await selectLore(
    opts.matchTarget,
    opts.loreIndex,
    [],
    opts.loreBudgetChars,
    { excludeDirs: opts.excludeDirs },
  );

  // Same section order as the seed (bundleContextSections): file → lore →
  // recap → recent. The model has already learned that shape once.
  const parts: string[] = [];
  let docChars = 0;
  let memoryChars = 0;
  if (opts.doc) {
    const head = [opts.doc.filePath, opts.doc.brief].filter(Boolean).join("\n");
    parts.push(`【${sectionLabel("currentFile")}】\n${head}`);
  }
  if (loreSnippets) {
    parts.push(`【${sectionLabel("knowledge")}】\n${loreSnippets}`);
  }
  const body = opts.doc?.body;
  if (body) {
    const span = body.contextChars ?? MAX_CONTEXT_CHARS;
    const len = body.documentText.length;
    const detailStart = Math.max(0, len - span);
    const storySummary = body.memory
      ? selectMemoryForContext(body.memory, detailStart, body.memoryBudgetChars)
      : "";
    if (storySummary) {
      parts.push(`【${sectionLabel("priorRecap")}】\n${storySummary}`);
      memoryChars = storySummary.length;
    }
    const recent = body.documentText.slice(detailStart).trim();
    if (recent) {
      parts.push(`【${sectionLabel("recent")}】\n${recent}`);
      docChars = recent.length;
    }
  }

  const byDir = new Map<string, LoreEntity>();
  for (const entities of Object.values(opts.loreIndex)) {
    for (const e of entities ?? []) byDir.set(e.dirPath, e);
  }
  return {
    text: parts.length
      ? `${i18n.t("ai.instructions.chatInjection")}\n\n${parts.join("\n\n")}`
      : "",
    loreReport: report,
    matchedEntities: report.entities
      .map((r) => byDir.get(r.dirPath))
      .filter((e): e is LoreEntity => !!e),
    docChars,
    memoryChars,
  };
}

/** The chat seed, with the two user messages identified for session bookkeeping. */
export interface ChatSeedMessages {
  /** What actually goes on the wire, in order. */
  messages: { role: "system" | "user"; content: MessageContent }[];
  /**
   * The seeded-context message inside `messages` — identified by reference so
   * the session can drop it at compaction time. Null when nothing was seeded
   * (no document open, no lore matched): then there is no message at all,
   * rather than an empty one taking up a slot in every later request.
   */
  seedContext: { role: "user"; content: string } | null;
  /** The author's question message inside `messages`. */
  question: { role: "user"; content: MessageContent };
}

/**
 * Chat variant of {@link bundleToMessages}: same layers, but the seeded context
 * and the author's question are **separate messages**. Merged, the injected
 * lore/memory/window is welded to the first question for the life of the
 * session — it can never be dropped without also dropping what the author
 * asked. Split, the context block is an independent unit the compaction pass
 * (docs/feature/agent/chat-memory-plan.md §4) can discard, because it is retrieval output
 * and reproducible; the question is conversation and is not.
 *
 * `questionContent` overrides what the question message carries on the wire,
 * for a first turn the author attached pictures to. The bundle's `taskText` is
 * still the text the whole context was assembled *around* — retrieval matches
 * on words — so the override adds the image parts beside it rather than
 * replacing what this function was given.
 */
export function bundleToChatMessages(
  bundle: ContextBundle,
  questionContent?: MessageContent,
): ChatSeedMessages {
  const sections = bundleContextSections(bundle);
  const seedContext = sections.length > 0
    ? { role: "user" as const, content: sections.join("\n\n") }
    : null;
  const question = { role: "user" as const, content: questionContent ?? bundle.taskText };
  return {
    messages: [
      { role: "system", content: bundle.systemPrompt || profileSystemPrompt() },
      ...(seedContext ? [seedContext] : []),
      question,
    ],
    seedContext,
    question,
  };
}
