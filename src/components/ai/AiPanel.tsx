/**
 * 生成面板 — the task-driven half of the AI assistant (续写 / 重写 / 润色 /
 * 总结 / 自定义).
 *
 * Two columns:
 *   left  — everything that shapes the request, in the order the author thinks
 *           about it: what task, on what text, inside what context budget, with
 *           which lore. A sticky footer carries the cost forecast + run button.
 *   right — what the run produced: which lore was actually injected, the
 *           execution log, and the streamed result.
 *
 * The context-allocation bar is the panel's centrepiece: it forecasts, live,
 * how the model's window will be divided *before* anything is sent, so the
 * author can trade recap for lore (or the reverse) with the chips right under
 * it instead of guessing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown, ChevronRight, Copy, Crosshair, FileSearch, Layers, ListChecks, Pin, Play,
  Repeat, RotateCw, Square, X,
} from "lucide-react";
import { PromptViewer } from "./PromptViewer";
import type { StreamMessage } from "../../lib/ai/types";
import { BatchRunModal } from "./BatchRunModal";
import { SnippetPicker } from "./SnippetPicker";
import { useSnippetSave } from "./SnippetSaveMenu";
import { useBatchStore } from "../../stores/batchStore";
import { draftCountFor, totalUsage, useAiTaskStore, type TaskKind } from "../../stores/aiTaskStore";
import { useAgentStore } from "../../stores/agentStore";
import { cardsForSurface } from "../../lib/agent/approvalRouting";
import { presetForTools } from "../../lib/agent/presets";
import { plannedToolTokens } from "../../lib/agent/toolCost";
import { useComposerStore } from "../../stores/composerStore";
import { AgentLog } from "./AgentLog";
import { TaskPanel } from "./TaskPanel";
import { sumTokens, taskDocRevision } from "../../lib/agent/logModel";
import { ReasoningControls } from "./ReasoningControls";
import { ApprovalCard } from "./ApprovalCard";
import { PlanCard } from "./PlanCard";
import { RoundLimitCard } from "./RoundLimitCard";
import { TruncationCard } from "./TruncationCard";
import { AutoApproveChip } from "./AutoApproveChip";
import { useAiStore } from "../../stores/aiStore";
import {
  useAppStore, LORE_BUDGET_MIN, LORE_BUDGET_MAX, LORE_BUDGET_OPTIONS,
} from "../../stores/appStore";
import { MAX_DRAFTS } from "../../lib/ai/drafts";
import { focusBlockedByImage, useEditorStore, useWritingFocus } from "../../stores/editorStore";
import { useLoreStore } from "../../stores/loreStore";
import { ScopeBand, ScopeMenu, type ScopeMenuAnchor } from "../lore/collections/ScopePicker";
import { useMemoryStore } from "../../stores/memoryStore";
import { useDocModel, useProjectStore, useSectionLabel, useTerms } from "../../stores/projectStore";
import {
  locateAppendAnchor,
  profileSystemPrompt,
  resolveEditRange,
  spliceContinuation,
  type TaskExtras,
} from "../../lib/context/rag";
import { clearTarget } from "../../lib/editor/aiTarget";
import { flashInserted } from "../../lib/editor/insertFlash";
import { parsePins, type LoreActivationReport } from "../../lib/context/loreSelect";
import {
  indexCategories,
  loadPinnedLore,
  savePinnedLore,
  type LoreFacet,
} from "../../lib/lore";
import {
  MEMORY_MIN_DOC_CHARS,
  MEMORY_SUGGEST_THRESHOLD_CHARS,
} from "../../lib/context/memory";
import {
  categoryLabel, defaultTask, findTask, profileLabel, taskDesc, taskLabel,
  visibleTaskGroups, type ResolvedTask,
} from "../../lib/profile";
import {
  BOOK_PREV_TAIL_CHARS, BOOK_PREV_TAIL_NEAR_START_CHARS,
} from "../../lib/context/bookContext";
import {
  fixedContextChars, measureCharsPerToken, planContextBudget,
  RECENT_WINDOW_MIN_CHARS, STATIC_LORE_BUDGET_MAX_TOKENS,
} from "../../lib/context/budget";
import { chapterTitle, resolveVolumes } from "../../lib/context/outline";
import { contextLabel } from "../../lib/ai/modelLabel";
import { MOD_KEY } from "../../lib/platform";
import { panelFade, springPanel, useMotionPreset } from "../../lib/motion";
import { Select } from "../common/Select";
import styles from "./AiPanel.module.css";
import { baseName, isSamePath } from "../../lib/paths";

const CONTINUE_LENGTH_OPTIONS = [200, 500, 1000, 2000];
const CONTEXT_CHARS_OPTIONS = [0, 500, 1000, 2000];
const DRAFT_COUNT_OPTIONS = Array.from({ length: MAX_DRAFTS }, (_, i) => i + 1);
/** Verbatim window size used by tasks without a contextChars picker
 *  (continue/custom). Owned by lib/context/budget so it can't drift. */
const DEFAULT_DETAIL_SPAN = RECENT_WINDOW_MIN_CHARS;

/**
 * Lore injection token-budget presets (see loreSelect / appStore). Presets cover
 * the common tiers; the adjacent number field takes any value in
 * [LORE_BUDGET_MIN, LORE_BUDGET_MAX] for large-context models.
 */

/** Context-window utilization presets (see lib/context/budget). */
const UTILIZATION_OPTIONS = [0.25, 0.5, 0.75, 0.9];

/** Compact token count: 1000000 → "1M", 32000 → "32k", 600 → "600".
 *  Shares contextLabel's scale so a window reads the same here and in the
 *  model picker's badge. */
function formatBudget(n: number): string {
  return contextLabel(n) ?? String(n);
}

/** File name without its directory or `.md` extension. */
function basename(path: string): string {
  return (baseName(path) || path).replace(/\.md$/i, "");
}

/** Which paragraph (1-based, blank-line separated) an offset falls in. */
function paragraphIndexAt(text: string, offset: number): number {
  if (offset <= 0) return 1;
  return text.slice(0, offset).split(/\n{2,}/).length;
}

/**
 * Where a continuation goes. Named by the author rather than inferred, because
 * the three answers are not distinguishable from document state alone: an
 * opening is offset 0 whether or not anything happens to be selected.
 */
export type ContinueMode = "opening" | "end" | "expand";

/**
 * The mode to start from, when the author has not said.
 *
 * An empty chapter can only be opened; a marked passage is almost always
 * marked *in order to* write from it; anything else is the traditional append.
 */
function defaultContinueMode(content: string, hasTarget: boolean): ContinueMode {
  if (content.trim() === "") return "opening";
  return hasTarget ? "expand" : "end";
}

/** Small uppercase section heading with an optional right-aligned meta slot. */
function SectionHead({
  label, meta, action,
}: { label: string; meta?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={styles.sectionHead}>
      <span className={styles.sectionLabel}>{label}</span>
      {(meta || action) && (
        <span className={styles.sectionRight}>
          {meta && <span className={styles.sectionMeta}>{meta}</span>}
          {action}
        </span>
      )}
    </div>
  );
}

// ─── Context allocation forecast ──────────────────────────────────────────────

interface ContextForecast {
  /** Ordered bar segments; `chars` sum to the request's whole input ceiling. */
  segments: { key: "tools" | "recent" | "lore" | "memory" | "free"; chars: number }[];
  charsPerToken: number;
  /** Ceiling this request may spend on input (tokens). */
  ceilingTokens: number;
  /** Estimated tokens the request will actually spend. */
  usedTokens: number;
  /** Tokens held back for the reply. */
  reservedOutputTokens: number;
}

/**
 * Live pre-flight forecast of how the model's window gets divided.
 *
 * Mirrors the planning `aiTaskStore.runTask` performs for real, minus what
 * needs disk I/O (the book-context build, the actual lore selection). It is a
 * forecast, not a record: the realized split is what the run reports afterwards.
 * Returns null when the model declares no context size — there is no plan to
 * show in that case, only the static-fallback notice.
 */
function useContextForecast(opts: {
  contextSize: number;
  maxOutputTokens: number | undefined;
  utilization: number;
  loreBudgetTokens: number;
  systemPromptChars: number;
  instructionChars: number;
  selectionChars: number;
  outlineChars: number;
  knowledgeChars: number;
  documentText: string;
  anchorOffset: number;
  /** Explicit 参考上文 choice; undefined for tasks without the picker. */
  recentWindowChars: number | undefined;
  isContinue: boolean;
  replyChars: number | undefined;
  memoryChars: number;
  /** Tokens this task's agent toolset will occupy, 0 for a toolless task. */
  toolSchemaTokens: number;
}): ContextForecast | null {
  const {
    contextSize, maxOutputTokens, utilization, loreBudgetTokens, systemPromptChars,
    instructionChars, selectionChars, outlineChars, knowledgeChars, documentText,
    anchorOffset, recentWindowChars, isContinue, replyChars, memoryChars,
    toolSchemaTokens,
  } = opts;

  return useMemo(() => {
    if (contextSize <= 0) return null;
    const charsPerToken = measureCharsPerToken(documentText);
    const fixedChars = fixedContextChars({
      systemPromptChars,
      taskInstructionChars: instructionChars,
      selectionChars,
      outlineChars,
      knowledgeChars,
      prevChapterTailChars: isContinue ? BOOK_PREV_TAIL_CHARS : 0,
    });
    const plan = planContextBudget({
      contextSize,
      maxOutputTokens,
      utilization,
      loreBudgetTokens,
      toolSchemaTokens,
      fixedChars,
      recentWindowChars,
      availableRecentChars: Math.max(0, anchorOffset),
      hasMemory: memoryChars > 0,
      includeBookContext: isContinue,
      replyChars,
      charsPerToken,
    });

    // Clip each layer to what actually exists — a budget the manuscript can't
    // fill is headroom, not usage, and showing it as usage would make the bar
    // lie about how much room is left for lore.
    const recent = Math.min(plan.recentWindowChars, Math.max(0, anchorOffset));
    const lore = plan.loreChars;
    const memory = Math.min(plan.memoryChars, memoryChars) + plan.bookPriorChars;

    // The plannable layers are measured against the **message** ceiling; the
    // tool schemas sit outside it, so the bar's full width is still the whole
    // input ceiling and the toolset reads as space taken from the layers.
    const ceilingChars = Math.floor(plan.messageCeilingTokens * charsPerToken);
    const free = Math.max(0, ceilingChars - fixedChars - recent - lore - memory);
    const toTokens = (chars: number) => Math.round(chars / charsPerToken);
    // Converted for geometry only, and it round-trips exactly: the tooltip
    // divides by the same ratio to print the token count back.
    const toolChars = plan.toolSchemaTokens * charsPerToken;

    return {
      segments: [
        { key: "tools", chars: toolChars },
        { key: "recent", chars: recent },
        { key: "lore", chars: lore },
        { key: "memory", chars: memory },
        { key: "free", chars: free },
      ],
      charsPerToken,
      ceilingTokens: plan.inputCeilingTokens,
      usedTokens: toTokens(fixedChars + recent + lore + memory) + plan.toolSchemaTokens,
      reservedOutputTokens: plan.reservedOutputTokens,
    };
  }, [
    contextSize, maxOutputTokens, utilization, loreBudgetTokens, systemPromptChars,
    instructionChars, selectionChars, outlineChars, knowledgeChars, documentText,
    anchorOffset, recentWindowChars, isContinue, replyChars, memoryChars,
    toolSchemaTokens,
  ]);
}

/** Stacked bar + legend + the 窗口占用 control that resizes the whole budget. */
function ContextAllocation({ forecast }: { forecast: ContextForecast | null }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const contextUtilization = useAppStore((s) => s.contextUtilization);
  const setContextUtilization = useAppStore((s) => s.setContextUtilization);
  const activeModel = useAiStore((s) => s.models.find((m) => m.id === s.activeModelId));
  const contextSize = activeModel?.contextSize ?? 0;

  const LEGEND: Record<string, { labelKey: string; fallback: string }> = {
    tools:  { labelKey: "ai.panel.allocTools",  fallback: "工具" },
    recent: { labelKey: "ai.panel.allocRecent", fallback: "近期" },
    lore:   { labelKey: "ai.panel.allocLore",   fallback: "设定" },
    memory: { labelKey: "ai.panel.allocMemory", fallback: "前情" },
    free:   { labelKey: "ai.panel.allocFree",   fallback: "余量" },
  };

  const total = forecast ? forecast.segments.reduce((n, s) => n + s.chars, 0) : 0;

  return (
    <div className={styles.section}>
      <SectionHead
        label={t("ai.panel.contextAllocation", { defaultValue: "上下文分配" })}
        meta={
          forecast
            ? `${formatBudget(forecast.ceilingTokens)} / ${formatBudget(contextSize)} tk`
            : undefined
        }
      />

      {forecast && total > 0 ? (
        <>
          <div className={styles.allocBar}>
            {forecast.segments.map((seg) => (
              seg.chars > 0 && (
                <span
                  key={seg.key}
                  className={`${styles.allocSeg} ${styles[`allocSeg_${seg.key}`]}`}
                  style={{ flexGrow: seg.chars }}
                  title={`${t(LEGEND[seg.key].labelKey, { defaultValue: LEGEND[seg.key].fallback, entry: terms.entry })} ≈ ${formatBudget(Math.round(seg.chars / forecast.charsPerToken))} tk`}
                />
              )
            ))}
          </div>
          <div className={styles.allocLegend}>
            {forecast.segments.map((seg) => (
              <span key={seg.key} className={styles.allocLegendItem}>
                <span className={`${styles.allocSwatch} ${styles[`allocSeg_${seg.key}`]}`} />
                {t(LEGEND[seg.key].labelKey, { defaultValue: LEGEND[seg.key].fallback, entry: terms.entry })}
                <span className={styles.allocLegendValue}>
                  {formatBudget(Math.round(seg.chars / forecast.charsPerToken))}
                </span>
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className={styles.hintLine}>
          {t("ai.panel.contextUtilizationUnset")}
        </div>
      )}

      <div className={styles.controlRow}>
        <span className={styles.controlLabel}>
          {t("ai.panel.contextUtilization", { defaultValue: "窗口占用" })}
        </span>
        <div className={styles.chipGroup}>
          {UTILIZATION_OPTIONS.map((r) => (
            <button
              key={r}
              className={`${styles.chip} ${Math.abs(contextUtilization - r) < 0.001 ? styles.chipActive : ""}`}
              onClick={() => setContextUtilization(r)}
              disabled={contextSize <= 0}
              title={contextSize > 0
                ? t("ai.panel.contextUtilizationHint", {
                    tokens: Math.floor(contextSize * r).toLocaleString(),
                  })
                : t("ai.panel.contextUtilizationUnset")}
            >
              {Math.round(r * 100)}%
            </button>
          ))}
        </div>
      </div>

      {/* Directly below 窗口占用: both answer "how much does this run cost me",
          one in prompt tokens and one in thinking tokens. */}
      <ReasoningControls variant="row" />
    </div>
  );
}

// ─── Story memory ─────────────────────────────────────────────────────────────

/**
 * 前情提要 strip: coverage as a progress bar, plus the checkpoint warning when
 * the request is about to skip a large uncovered stretch of the document.
 */
function MemorySection({ detailSpan, appendMode }: { detailSpan: number; appendMode: boolean }) {
  const { t } = useTranslation();
  const { memory, freshness, isGenerating, progress, error, notice, generate, abort } =
    useMemoryStore();
  const content = useEditorStore((s) => s.content);
  const selectionRange = useAiTaskStore((s) => s.selectionRange);

  // Text that will NOT be sent verbatim: everything before the detail window.
  // Its anchor differs by task — edit tasks reference text before the selection
  // (its start); continue writes after the selection (its end) or the doc end.
  const anchor = appendMode
    ? (selectionRange?.to ?? content.length)
    : (selectionRange?.from ?? content.length);
  const preDetail = Math.max(0, anchor - detailSpan);

  const staleCount =
    memory && freshness && freshness.firstStaleIndex >= 0
      ? memory.segments.length - freshness.firstStaleIndex
      : 0;
  const freshCovered = memory
    ? staleCount > 0
      ? freshness!.firstStaleIndex > 0
        ? memory.segments[freshness!.firstStaleIndex - 1].to
        : 0
      : memory.coveredChars
    : 0;
  const gap = Math.max(0, preDetail - freshCovered);

  const needsCreate = !memory && preDetail > MEMORY_SUGGEST_THRESHOLD_CHARS;
  const needsUpdate = !!memory && (gap > MEMORY_SUGGEST_THRESHOLD_CHARS || staleCount > 0);

  // Short docs without a memory need no strip at all.
  if (!memory && content.length < MEMORY_MIN_DOC_CHARS) return null;

  const pct = content.length > 0 ? Math.min(100, Math.round((freshCovered / content.length) * 100)) : 0;
  const tail = Math.max(0, content.length - freshCovered);

  return (
    <div className={styles.section}>
      <SectionHead
        label={t("ai.memory.title")}
        meta={
          isGenerating && progress
            ? t("ai.memory.generating", { done: progress.done, total: progress.total })
            : memory
              ? t("ai.memory.coverage", {
                  defaultValue: "{{covered}} / {{total}} 字已摘要 {{pct}}%",
                  covered: freshCovered.toLocaleString(),
                  total: content.length.toLocaleString(),
                  pct,
                })
              : t("ai.memory.statusNone")
        }
        action={
          isGenerating ? (
            <button className={styles.linkBtn} onClick={abort}>{t("ai.panel.stop")}</button>
          ) : (
            <button className={styles.linkBtn} onClick={() => void generate()}>
              {memory ? t("ai.memory.btnUpdate") : t("ai.memory.btnCreate")}
            </button>
          )
        }
      />

      <div className={styles.progressTrack}>
        <span
          className={`${styles.progressFill} ${staleCount > 0 ? styles.progressFillStale : ""}`}
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </div>

      {memory && tail > 0 && (
        <div className={styles.hintLine}>
          {t("ai.memory.tailNote", {
            defaultValue: "剩余 {{chars}} 字为最近段落，将以原文进入提示。",
            chars: tail.toLocaleString(),
          })}
        </div>
      )}
      {staleCount > 0 && (
        <div className={styles.hintLine}>
          {t("ai.memory.statusStale", { count: staleCount }).replace(/^[，,]\s*/, "")}
        </div>
      )}
      {(needsCreate || needsUpdate) && !isGenerating && (
        <div className={styles.warnLine}>
          {needsCreate
            ? t("ai.memory.hintCreate", { chars: preDetail.toLocaleString() })
            : t("ai.memory.hintUpdate", { chars: gap.toLocaleString() })}
        </div>
      )}
      {notice && !isGenerating && <div className={styles.hintLine}>{notice}</div>}
      {error && <div className={styles.errorLine}>{error}</div>}
    </div>
  );
}

// ─── Lore picker ──────────────────────────────────────────────────────────────

/** Collapsible extra-options section (outline / additional knowledge). */
function ExtraSection({
  label, badge, children,
}: { label: string; badge?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.extraSection}>
      <button className={styles.extraSectionToggle} onClick={() => setOpen((v) => !v)}>
        <span className={styles.extraSectionChevron}>
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
        <span className={styles.extraSectionLabel}>{label}</span>
        {badge && <span className={styles.extraSectionBadge}>{badge}</span>}
      </button>
      {open && <div className={styles.extraSectionContent}>{children}</div>}
    </div>
  );
}

/**
 * 指定设定 — two-level tree: pin whole entities, or expand one and pin
 * individual facets ("dirPath#file"). Facet pins imply the entity core, and
 * pinning two same-group facets overrides their exclusion.
 */
function LoreSection({
  entities, search, setSearch, selectedPaths, toggle, charsPerToken,
}: {
  entities: { dirPath: string; name: string; categoryLabel: string; facets: LoreFacet[] }[];
  search: string;
  setSearch: (v: string) => void;
  selectedPaths: string[];
  toggle: (path: string) => void;
  charsPerToken: number;
}) {
  const { t } = useTranslation();
  const terms = useTerms();
  const knowledgeLabel = useSectionLabel("knowledge");
  const loreBudgetTokens = useAppStore((s) => s.loreBudgetTokens);
  const setLoreBudgetTokens = useAppStore((s) => s.setLoreBudgetTokens);
  const activeModel = useAiStore((s) => s.models.find((m) => m.id === s.activeModelId));
  const contextSize = activeModel?.contextSize ?? 0;
  // Without a declared window there is no dynamic plan *and* no pre-flight
  // check, so the planner hard-caps lore. Say so rather than silently ignoring
  // a bigger setting the author just typed in.
  const loreCapped = contextSize <= 0 && loreBudgetTokens > STATIC_LORE_BUDGET_MAX_TOKENS;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Uncommitted text in the budget field. Held separately so typing "12000"
  // isn't clamped digit-by-digit; committed (and clamped by the store) on
  // blur/Enter, and dropped whenever a preset chip takes over.
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);

  const commitBudgetDraft = () => {
    if (budgetDraft === null) return;
    const parsed = parseInt(budgetDraft, 10);
    if (Number.isFinite(parsed)) setLoreBudgetTokens(parsed);
    setBudgetDraft(null); // revert to the stored (clamped) value either way
  };

  const toggleExpanded = (dirPath: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath); else next.add(dirPath);
      return next;
    });

  const estTk = (chars: number) => Math.ceil(chars / charsPerToken);

  return (
    <div className={styles.section}>
      <SectionHead
        label={t("ai.panel.continueLorePicker", { entry: terms.entry })}
        action={
          <div className={styles.chipGroup}>
            {LORE_BUDGET_OPTIONS.map((n) => (
              <button
                key={n}
                className={`${styles.chip} ${loreBudgetTokens === n ? styles.chipActive : ""}`}
                onClick={() => { setBudgetDraft(null); setLoreBudgetTokens(n); }}
                title={t("ai.panel.loreBudgetHint", {
                  min: LORE_BUDGET_MIN,
                  max: LORE_BUDGET_MAX.toLocaleString(),
                  knowledge: knowledgeLabel,
                })}
              >
                {formatBudget(n)}
              </button>
            ))}
            <input
              className={styles.budgetInput}
              type="number"
              min={LORE_BUDGET_MIN}
              max={LORE_BUDGET_MAX}
              step={100}
              value={budgetDraft ?? String(loreBudgetTokens)}
              onChange={(e) => setBudgetDraft(e.target.value)}
              onBlur={commitBudgetDraft}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              title={t("ai.panel.loreBudgetHint", {
                min: LORE_BUDGET_MIN,
                max: LORE_BUDGET_MAX.toLocaleString(),
                knowledge: knowledgeLabel,
              })}
              aria-label={t("ai.panel.loreBudget", { entry: terms.entry })}
            />
          </div>
        }
      />

      <input
        className={styles.searchInput}
        placeholder={t("ai.panel.continueLoreSearch", { entry: terms.entry })}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className={styles.loreList}>
        {entities.length === 0 ? (
          <span className={styles.loreEmpty}>{t("ai.panel.continueLoreEmpty", { entry: terms.entry })}</span>
        ) : (
          entities.map((entity) => {
            const facets = entity.facets ?? [];
            const isExpanded = expanded.has(entity.dirPath);
            const isPinned = selectedPaths.includes(entity.dirPath);
            const pinnedFacetCount = facets.filter((f) =>
              selectedPaths.includes(`${entity.dirPath}#${f.file}`)
            ).length;
            const entityChars = facets.reduce((n, f) => n + f.charCount, 0);
            return (
              <div key={entity.dirPath}>
                <label className={`${styles.loreItem} ${isPinned ? styles.loreItemPinned : ""}`}>
                  <input
                    type="checkbox"
                    checked={isPinned}
                    onChange={() => toggle(entity.dirPath)}
                  />
                  <span className={styles.loreName}>{entity.name}</span>
                  <span className={styles.loreCat}>{entity.categoryLabel}</span>
                  {facets.length > 0 && (
                    <>
                      <span className={styles.loreCount}>
                        {t("ai.panel.loreFacetCount", {
                          defaultValue: "{{n}} 条",
                          n: facets.length,
                        })}
                      </span>
                      {(isPinned || pinnedFacetCount > 0) && entityChars > 0 && (
                        <span className={styles.loreTk}>· {estTk(entityChars)}tk</span>
                      )}
                      <button
                        className={styles.loreExpand}
                        onClick={(ev) => { ev.preventDefault(); toggleExpanded(entity.dirPath); }}
                        title={t("ai.panel.loreFacets")}
                      >
                        <Layers size={10} strokeWidth={1.8} />
                        {pinnedFacetCount > 0 ? `${pinnedFacetCount}/${facets.length}` : ""}
                        {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                      </button>
                    </>
                  )}
                </label>
                {isExpanded && facets.map((f) => {
                  const pinPath = `${entity.dirPath}#${f.file}`;
                  return (
                    <label key={pinPath} className={`${styles.loreItem} ${styles.loreItemFacet}`}>
                      <input
                        type="checkbox"
                        checked={selectedPaths.includes(pinPath)}
                        onChange={() => toggle(pinPath)}
                      />
                      <span className={styles.loreName}>{f.title}</span>
                      {f.group && <span className={styles.loreGroup}>{f.group}</span>}
                      <span className={styles.loreTk}>~{estTk(f.charCount)} tk</span>
                    </label>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      {loreCapped && (
        <div className={styles.warnLine}>
          {t("ai.panel.loreBudgetStaticCap", {
            cap: STATIC_LORE_BUDGET_MAX_TOKENS.toLocaleString(),
            entry: terms.entry,
          })}
        </div>
      )}
    </div>
  );
}

// ─── Results column ───────────────────────────────────────────────────────────

/** Post-assembly transparency: what got injected, what was dropped and why. */
function LoreReportSection({
  report, charsPerToken, onRaiseBudget,
}: { report: LoreActivationReport; charsPerToken: number; onRaiseBudget: () => void }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const estTk = (chars: number) => Math.ceil(chars / charsPerToken);

  const dropReason = (reason: string) =>
    reason === "no-key" ? t("ai.panel.loreDropNoKey")
    : reason === "group-lost" ? t("ai.panel.loreDropGroupLost")
    : reason === "budget" ? t("ai.panel.loreDropBudget")
    : reason === "resident" ? t("ai.panel.loreDropResident")
    : t("ai.panel.loreDropManual");

  const overBudget = report.entities.some((e) =>
    e.droppedFacets.some((d) => d.reason === "budget"));

  return (
    <div className={styles.resultSection}>
      <SectionHead
        label={t("ai.panel.loreReportTitle", { entry: terms.entry })}
        meta={`${estTk(report.usedChars)} / ${estTk(report.budgetChars)} tk`}
      />
      {report.entities.length === 0 ? (
        <div className={styles.hintLine}>{t("ai.panel.loreReportEmpty")}</div>
      ) : (
        report.entities.map((e) => (
          <div key={e.dirPath} className={styles.injectedEntity}>
            <div className={styles.injectedName}>
              {e.reason === "pinned" && <Pin size={10} strokeWidth={1.8} />}
              {e.name}
              {e.aliases && <span className={styles.injectedAlias}>{e.aliases}</span>}
            </div>
            <div className={styles.chipRow}>
              {e.layers.filter((l) => l.kind !== "summary").map((l, i) => (
                <span
                  key={`${l.kind}-${l.file ?? i}`}
                  className={styles.injectedChip}
                  title={l.matchedKeys?.length
                    ? t("ai.panel.loreMatchedKeys", { keys: l.matchedKeys.join(", ") })
                    : undefined}
                >
                  {l.pinned && <Pin size={8} strokeWidth={1.8} />}
                  {l.kind === "core"
                    ? t("ai.panel.loreCore") + (l.truncated ? "✂" : "")
                    : l.kind === "gallery"
                      ? `${t("ai.panel.loreGallery")} ×${l.count ?? 0}`
                      : l.title}
                  <span className={styles.injectedTk}>{estTk(l.chars)}</span>
                </span>
              ))}
            </div>
            {(e.droppedFacets.length > 0 || e.droppedImages) && (
              <div className={styles.chipRow}>
                <span className={styles.droppedLabel}>
                  {t("ai.panel.loreDroppedTitle", { defaultValue: "超出预算未注入" })}
                </span>
                {e.droppedFacets.map((d) => (
                  <span
                    key={`drop-${d.file}`}
                    className={styles.droppedChip}
                    title={dropReason(d.reason)}
                  >
                    {d.title}
                  </span>
                ))}
                {e.droppedImages ? (
                  <span className={styles.droppedChip} title={dropReason("budget")}>
                    {`${t("ai.panel.loreGallery")} ×${e.droppedImages}`}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        ))
      )}
      {overBudget && (
        <button className={styles.linkBtn} onClick={onRaiseBudget}>
          {t("ai.panel.loreRaiseBudget", { defaultValue: "提高预算" })} →
        </button>
      )}
    </div>
  );
}

/**
 * Error block with the recoveries that are actually actionable here.
 *
 * The order is the order they get reached for. A failure the author can fix by
 * re-running is already fixed by 重试; the ones that aren't — a safety filter, a
 * context overflow, a provider that rejects a tool schema — are answered either
 * by a different model or by reading what was really sent. Copying the message
 * is last because it is for asking someone else.
 */
function ErrorBlock({
  message, onRetry, onSwitchModel, messages,
}: {
  message: string;
  onRetry: (() => void) | null;
  /** Opens the header's model picker; the retry fires once a model is chosen. */
  onSwitchModel?: () => void;
  /** What this run sent — enables 查看完整提示 when the run got that far. */
  messages?: StreamMessage[] | null;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(message).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1600); },
      () => { /* clipboard may be blocked — the text is on screen either way */ },
    );
  };

  return (
    <div className={styles.errorBlock}>
      <div className={styles.errorBody}>{message}</div>
      <div className={styles.errorActions}>
        {onRetry && (
          <button className={styles.btnSecondary} onClick={onRetry}>
            <RotateCw size={10} strokeWidth={1.8} /> {t("ai.panel.retry", { defaultValue: "重试" })}
          </button>
        )}
        {onRetry && onSwitchModel && (
          <button
            className={styles.btnSecondary}
            onClick={onSwitchModel}
            title={t("ai.panel.switchModelRetryHint", {
              defaultValue: "打开模型选择器；选定后自动重跑本次请求",
            })}
          >
            <Repeat size={10} strokeWidth={1.8} />
            {t("ai.panel.switchModelRetry", { defaultValue: "换模型重试" })}
          </button>
        )}
        {messages && messages.length > 0 && (
          <button className={styles.btnSecondary} onClick={() => setShowPrompt(true)}>
            <FileSearch size={10} strokeWidth={1.8} />
            {t("ai.panel.viewPrompt", { defaultValue: "查看完整提示词" })}
          </button>
        )}
        <button className={styles.btnSecondary} onClick={copy}>
          <Copy size={10} strokeWidth={1.8} />
          {copied
            ? t("ai.panel.copied", { defaultValue: "已复制" })
            : t("ai.panel.copyError", { defaultValue: "复制错误" })}
        </button>
      </div>
      {showPrompt && messages && (
        <PromptViewer messages={messages} onClose={() => setShowPrompt(false)} />
      )}
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function AiPanel() {
  const { t, i18n } = useTranslation();
  const {
    isRunning, drafts, activeDraftId, error, agentLog, taskWorkspace,
    loreReport, sourceFilePath, lastMessages,
    runTask, abort, clearOutput, setActiveDraft, selection, selectionRange, selectionSource,
    clearSelectionFrom, requestedTask, requestedInstruction, setRequestedTask,
  } = useAiTaskStore();
  // The draft the pane shows and the insert actions target. A run always seeds
  // one, so `output` is empty only before the first run or after a clear.
  const activeDraft = drafts.find((d) => d.id === activeDraftId) ?? drafts[0] ?? null;
  const output = activeDraft?.text ?? "";
  const usage = totalUsage(drafts);
  const {
    models, providers, prompts, activeModelId, activePromptId, setActivePrompt, subAgents,
  } = useAiStore();
  // The focused document — one atomic read of "which file" + "its text", so the
  // panel can never describe one document while the run targets another.
  const focus = useWritingFocus();
  const content = focus.text;
  const activeFilePath = focus.filePath;
  const { index: loreIndex } = useLoreStore();
  const loreScope = useLoreStore((s) => s.scope);
  const setLoreScope = useLoreStore((s) => s.setScope);
  const collections = useProjectStore((s) => s.collections);
  const [scopeMenu, setScopeMenu] = useState<ScopeMenuAnchor | null>(null);
  const projectPath = useProjectStore((s) => s.projectPath);
  const fileTree = useProjectStore((s) => s.fileTree);
  const memory = useMemoryStore((s) => s.memory);
  const docs = useDocModel();
  const terms = useTerms();
  const priorAllLabel = useSectionLabel("priorAll");
  const priorRecapLabel = useSectionLabel("priorRecap");
  const draftCount = useAppStore((s) => s.draftCount);
  const setDraftCount = useAppStore((s) => s.setDraftCount);
  const loreBudgetTokens = useAppStore((s) => s.loreBudgetTokens);
  const setLoreBudgetTokens = useAppStore((s) => s.setLoreBudgetTokens);
  const contextUtilization = useAppStore((s) => s.contextUtilization);
  const openModelPicker = useAppStore((s) => s.openModelPicker);

  // Story memory follows the active document; staleness re-checks are hashed
  // over the whole doc, so debounce them behind typing. Both are skipped when the
  // profile's documents don't use memory — see `memoryChars` below, which must
  // also be zeroed because the store keeps what it already loaded.
  const usesMemory = docs.memory;
  useEffect(() => {
    if (!usesMemory) return;
    void useMemoryStore.getState().loadForActiveFile();
  }, [activeFilePath, usesMemory]);
  useEffect(() => {
    if (!usesMemory) return;
    const id = setTimeout(() => useMemoryStore.getState().refreshFreshness(), 800);
    return () => clearTimeout(id);
  }, [content, usesMemory]);

  // The primary pack's first task is the default: the panel should open on a
  // usable request, not on an empty shell that needs a click before it shows
  // anything. Grouped by pack, and derived from the *subscribed* workspace —
  // enabling or disabling a secondary pack must reshape the task row
  // immediately, and the non-reactive singleton alone would leave it stale
  // when the primary (which `useDocModel` etc. subscribe to) didn't change.
  const workspace = useProjectStore((s) => s.workspace);
  const taskGroups = visibleTaskGroups(workspace);
  const [selectedTask, setSelectedTask] = useState<TaskKind>(() => defaultTask().id);
  // A profile switch can remove the selected task. Fall back rather than render
  // controls for a task that no longer exists (and can no longer be run).
  const task = findTask(selectedTask) ?? defaultTask();
  useEffect(() => {
    if (task.id !== selectedTask) setSelectedTask(task.id);
  }, [task.id, selectedTask]);
  const [continueLength, setContinueLength] = useState(500);
  const [contextChars, setContextChars] = useState(1000);
  // Batch clause run (tasks declaring `batch`) — modal state only; the run
  // itself lives in batchStore and survives the modal being closed.
  const [showBatch, setShowBatch] = useState(false);
  const batchRunning = useBatchStore((s) => s.running);

  // ── Opening mode ──────────────────────────────────────────────────────────
  // A chapter with nothing in it has no 【近期内容】, so whatever bridge gets
  // injected is the only prose in the prompt and "continue from the end" means
  // "continue the previous chapter". Below the threshold the author decides
  // explicitly instead of discovering it in the output.
  const [openingMode, setOpeningMode] = useState<"bridge" | "standalone">("bridge");
  const [bridgePath, setBridgePath] = useState<string | null>(null);
  // Where the continuation attaches. Null means "still following the default" —
  // the author has not overridden it for this file yet.
  const [pickedMode, setPickedMode] = useState<ContinueMode | null>(null);
  const [volumes, setVolumes] = useState<
    { name: string; chapters: { path: string; title: string }[] }[]
  >([]);

  // Whether to bridge is a question about the chapter's *age*, not about where
  // this particular continuation goes — a chapter with barely anything in it
  // has no continuity of its own yet, whichever spot you write at.
  //
  // Gated on the profile too: with no prior-document context there is nothing to
  // bridge *from*, so the control would offer a choice that changes nothing. This
  // also suppresses the spine read below, which would be a disk hit for an
  // ordering the project doesn't have.
  const wantsOpeningChoice =
    docs.priorContext &&
    // `task.continuation` rather than the `isContinue` alias declared further
    // down — this block runs before it, and duplicating the read is cheaper than
    // hoisting the whole task-derived section above the state hooks.
    !!task.continuation && content.trim().length < BOOK_PREV_TAIL_NEAR_START_CHARS;

  // The chosen position belongs to the chapter it was chosen in; a new file
  // starts from the default again.
  useEffect(() => { setPickedMode(null); }, [focus.filePath]);

  // The book's chapter spine, for the bridge picker. Loaded only when the
  // control can actually appear — resolveVolumes reads the outline off disk.
  useEffect(() => {
    if (!wantsOpeningChoice || !projectPath) { setVolumes([]); return; }
    let cancelled = false;
    void (async () => {
      const resolved = await resolveVolumes(projectPath, fileTree);
      if (cancelled) return;
      setVolumes(resolved.map((v) => ({
        name: v.name,
        chapters: v.chapters.map((c) => ({ path: c.path, title: chapterTitle(c) })),
      })));
    })();
    return () => { cancelled = true; };
  }, [wantsOpeningChoice, projectPath, fileTree]);

  // Everything before this chapter in book order — bridging forward would be
  // narratively backwards, so the picker only offers what precedes it. Spans
  // volumes, which the automatic pick (same-volume only) cannot.
  const bridgeCandidates = (() => {
    const flat = volumes.flatMap((v) => v.chapters.map((c) => ({ ...c, volume: v.name })));
    const idx = flat.findIndex((c) => isSamePath(c.path, activeFilePath));
    return idx < 0 ? [] : flat.slice(0, idx);
  })();

  // Default to the chapter immediately before this one; re-evaluated whenever
  // the spine or the focused document changes.
  useEffect(() => {
    setBridgePath(bridgeCandidates.length > 0 ? bridgeCandidates[bridgeCandidates.length - 1].path : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumes, activeFilePath]);

  // Lore picker state — initialized from persisted pins, reloaded on project switch.
  const [selectedLorePaths, setSelectedLorePaths] = useState<string[]>(() =>
    loadPinnedLore(useProjectStore.getState().projectPath)
  );
  const [loreSearch, setLoreSearch] = useState("");

  useEffect(() => {
    setSelectedLorePaths(loadPinnedLore(projectPath));
  }, [projectPath]);

  // Everything the author types lives in composerStore rather than useState:
  // the drawer unmounts when it closes, and an outline typed out by hand must
  // not evaporate because the panel was collapsed to look at the chapter.
  //
  // Outline + extra knowledge state (continue)
  const outline = useComposerStore((s) => s.panelOutline);
  const setOutline = useComposerStore((s) => s.setPanelOutline);
  const additionalKnowledge = useComposerStore((s) => s.panelKnowledge);
  const setAdditionalKnowledge = useComposerStore((s) => s.setPanelKnowledge);

  // Extra requirement for polish / rewrite / summary
  const requirement = useComposerStore((s) => s.panelRequirement);
  const setRequirement = useComposerStore((s) => s.setPanelRequirement);

  const customInstr = useComposerStore((s) => s.panelInstruction);
  const setCustomInstr = useComposerStore((s) => s.setPanelInstruction);
  const instrRef = useRef<HTMLTextAreaElement>(null);
  // Right-click → 存为片段 on the custom-instruction box.
  const snippetSave = useSnippetSave();
  const [agentMode, setAgentMode] = useState(false);
  // 同 AgentChat：只渲染没有 surface 标记的卡片（lib/agent/approvalRouting）。
  const pendingApprovals = cardsForSurface(useAgentStore((s) => s.pending), null);
  const pendingPlans = cardsForSurface(useAgentStore((s) => s.pendingPlans), null);
  const pendingRoundLimits = cardsForSurface(useAgentStore((s) => s.pendingRoundLimits), null);
  const pendingTruncations = cardsForSurface(useAgentStore((s) => s.pendingTruncations), null);
  const taskAbortController = useAiTaskStore((s) => s.abortController);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  // The floating toolbar opens the panel pre-selecting a task; consume + clear
  // it. Held while a run is in flight rather than consumed immediately: the
  // bubble/shortcut that set it are themselves disabled while isRunning (see
  // InlineAiBubble, useGlobalShortcuts), but this guard is the actual
  // backstop — without it, a request landing here mid-stream would clearOutput()
  // the live run's drafts out from under it, discarding whatever had streamed
  // so far while the request kept running (and billing) invisibly in the
  // background. isRunning is a dependency specifically so the request is
  // honored the moment the current run finishes, instead of being dropped.
  useEffect(() => {
    if (requestedTask && !isRunning) {
      setSelectedTask(requestedTask);
      // The toolbar's 自定义指令 box types straight into the panel's own field,
      // so what runs is still whatever is on screen here — reviewable, and
      // editable before ⌘↵.
      if (requestedInstruction !== null) setCustomInstr(requestedInstruction);
      clearOutput();
      setRequestedTask(null);
    }
  }, [requestedTask, requestedInstruction, isRunning, setRequestedTask, clearOutput]);

  const activeModel = models.find((m) => m.id === activeModelId);
  const activeProvider = activeModel ? providers.find((p) => p.id === activeModel.providerId) : null;
  const hasConfig = !!activeModel;

  const isContinue = !!task.continuation;
  const supportsExtras = !!task.referenceWindow;
  // What this task's toolset costs, so the budget bar accounts for the schemas
  // the request will carry. Same function runTask plans with — the forecast and
  // the run cannot disagree about the toolset's size.
  const toolSchemaTokens = useMemo(
    () => plannedToolTokens(presetForTools(task.tools), subAgents, models),
    [task.tools, subAgents, models],
  );

  // The Agent 模式 toggle switches to a *different* task (its own prompt and
  // toolset), so resolve that before asking anything about what will run.
  const agentTask = task.agentTaskId ? findTask(task.agentTaskId) : null;
  const runTaskDef = agentMode && agentTask ? agentTask : task;
  const runKind: TaskKind = runTaskDef.id;
  // Ask the store's own rule what this task can do rather than re-deriving it —
  // part of that rule is a correctness limit, and two copies would drift.
  const maxDrafts = draftCountFor(runTaskDef, MAX_DRAFTS);

  // Polish/rewrite edit a passage in place, so their result belongs *where the
  // selection was* — appending it to the end of the document (the only thing
  // this panel used to do) silently duplicated the passage instead. Resolved at
  // apply time, not run time: the author may have kept typing while it streamed.
  const replaceRange =
    task.target === "replace"
      ? resolveEditRange(content, selection, selectionRange, selectionSource)
      : null;

  // Where a continuation attaches — the author's chosen mode, resolved to one
  // offset that the label, the prompt's reference window, the budget and the
  // insert all share. Recomputed every render: the author keeps typing while
  // the panel is open, and an expand target moves with the text.
  //
  // Expand deliberately yields null rather than the document end when its
  // passage can't be located: this mode exists because the author pointed at a
  // spot, and quietly writing somewhere else is worse than refusing to run.
  const continueMode = pickedMode ?? defaultContinueMode(content, !!selection);
  const continueAnchor = !isContinue
    ? null
    : continueMode === "opening"
    ? 0
    : continueMode === "expand"
    ? (selection ? locateAppendAnchor(content, selection, selectionRange) : null)
    : content.length;

  // The active draft's text was generated from *this* file's context — if the
  // author has switched documents since the run started, `content`/`selection`
  // above already describe the new one, and applying against them would
  // splice one document's output into another. Null on either side means "no
  // file to compare" (nothing to apply into, or the run wasn't file-scoped),
  // so only a genuine, known mismatch blocks the apply actions.
  const outputMismatched =
    !!sourceFilePath && !!activeFilePath && !isSamePath(sourceFilePath, activeFilePath);

  /**
   * Flash the just-landed span once CodeMirror actually shows it.
   *
   * `setContent` lands in the store synchronously, but the doc only reaches
   * the editor once React re-renders `CodeEditor` with the new `value` prop
   * and its (passive, not layout) sync effect dispatches the change — a tick
   * this call stack hasn't reached yet. Flashing before then would paint a
   * range on the *old* document. rAF runs after that effect has committed.
   */
  const scheduleFlash = (from: number, to: number) => {
    requestAnimationFrame(() => {
      const view = useEditorStore.getState().editorView;
      if (view) flashInserted(view, from, to);
    });
  };

  const handleApply = () => {
    if (outputMismatched) return;
    const { setContent } = useEditorStore.getState();
    if (replaceRange) {
      setContent(content.slice(0, replaceRange.from) + output + content.slice(replaceRange.to));
      scheduleFlash(replaceRange.from, replaceRange.from + output.length);
      clearOutput();
      return;
    }
    const at = continueAnchor ?? content.length;
    setContent(spliceContinuation(content, at, output));
    // spliceContinuation may insert a 0/1/2-newline separator before the
    // passage itself (see rag.ts); the flashed span is the passage, not the
    // separator, so mirror its lead calculation to land on the real offset.
    const before = content.slice(0, at);
    const lead = !before || before.endsWith("\n\n") ? 0 : before.endsWith("\n") ? 1 : 2;
    const from = at + lead;
    scheduleFlash(from, from + output.length);
    clearOutput();
  };

  /** Put the caret where the continuation will be inserted. */
  const locateAnchor = () => {
    const view = useEditorStore.getState().editorView;
    if (!view || continueAnchor === null) return;
    const pos = Math.min(continueAnchor, view.state.doc.length);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  };

  /**
   * Drop the current edit target.
   *
   * A committed selection previously had no way out except switching files: it
   * kept the task armed against a passage the author may have moved on from.
   * Marked ranges clear through the editor (which also unpaints them); dragged
   * ones clear in the store.
   */
  const dismissTarget = () => {
    const view = useEditorStore.getState().editorView;
    if (selectionSource === "marker" && view) clearTarget(view);
    else clearSelectionFrom("commit");
  };

  /** Put the caret back on the passage this task will edit. */
  const locateSelection = () => {
    const view = useEditorStore.getState().editorView;
    if (!view || !selectionRange) return;
    const to = Math.min(selectionRange.to, view.state.doc.length);
    const from = Math.min(selectionRange.from, to);
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    view.focus();
  };

  const handleRun = () => {
    clearOutput();
    const manualLorePaths = selectedLorePaths.length > 0 ? selectedLorePaths : undefined;
    let extras: TaskExtras | undefined;
    if (isContinue) {
      extras = {
        manualLorePaths,
        outline: outline.trim() || undefined,
        additionalKnowledge: additionalKnowledge.trim() || undefined,
        // Always explicit now. The automatic rule ("bridge when the anchor sits
        // near the chapter start") reads the anchor, so expanding a marked
        // passage early in a long chapter used to pull in the previous
        // chapter's ending — the chapter has thousands of words of its own
        // continuity by then. Whether to bridge is a question about the
        // chapter's age, which is what the control below is gated on; where to
        // write is a separate question, answered by the mode.
        bridgeChapter: wantsOpeningChoice
          ? (openingMode === "standalone" ? null : bridgePath)
          : null,
        appendAnchor: continueAnchor ?? undefined,
      };
    } else if (supportsExtras) {
      extras = {
        manualLorePaths,
        requirement: requirement.trim() || undefined,
        contextChars,
      };
    }
    runTask(
      // "custom" + Agent 模式 → the full-toolset agent task (see runKind).
      runKind,
      runTaskDef.freeform ? customInstr : undefined,
      isContinue ? continueLength : undefined,
      extras,
    );
  };

  // A task that acts *on* a passage can't run without one.
  //
  // Read from the task's own flag, not from `referenceWindow`: the two happen to
  // coincide on the built-ins, which is why deriving one from the other went
  // unnoticed, but they answer different questions. A profile task can need a
  // selection without wanting a reference-window picker (adapting a passage to
  // another channel, say), and deriving the gate would have let it run on
  // nothing.
  const needsSelection = !!task.needsSelection && !selection;
  // Expand was chosen because the author pointed at a passage. If that passage
  // is gone (or can no longer be found), refuse rather than quietly relocating
  // the continuation to the end of the chapter.
  const needsAnchor = isContinue && continueMode === "expand" && continueAnchor === null;
  // An unsettled focus means the editor still holds the *previous* document.
  // Blocking here turns a silent wrong-document run into a visible short wait.
  // A freeform task is nothing but the author's ask (plus a briefing), so an
  // empty box means there is no request to send. Keyed off the flag rather than
  // the "custom" id: every freeform task has this problem, and 遭遇/随机表 would
  // otherwise run on their briefing alone, with no situation to work from.
  const needsAsk = !!runTaskDef.freeform && !customInstr.trim();
  const canRun =
    hasConfig && !isRunning && !needsSelection && !needsAnchor && !needsAsk && focus.settled;

  // ── 换模型重试 ──
  // A safety refusal or a context overflow is not fixed by pressing 重试 again;
  // it is fixed by a different model. One click therefore has to mean both
  // "let me pick one" and "then run it": asking the author to re-find the run
  // button afterwards is the part that makes the recovery feel like work.
  //
  // Armed only for as long as this failure is on screen. An author who changes
  // model for their own reasons a minute later gets no phantom run, because
  // clearing the error disarms it — and while the card *is* up, a model change
  // is what the button just asked for.
  const [retryArmed, setRetryArmed] = useState(false);
  const failed = !!error || !!activeDraft?.error;
  useEffect(() => { if (!failed) setRetryArmed(false); }, [failed]);
  useEffect(() => {
    if (!retryArmed) return;
    setRetryArmed(false);
    if (canRun) handleRun();
    // Fires on the model change only — arming it must not run anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModelId]);
  const switchModelAndRetry = () => {
    setRetryArmed(true);
    openModelPicker();
  };

  // ⌘/Ctrl+Enter runs from anywhere in the panel, including the textareas.
  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canRun) {
      e.preventDefault();
      handleRun();
    }
  };

  // Flatten lore index to searchable list
  const isZh = i18n.language.startsWith("zh");
  const allLoreEntities = indexCategories(loreIndex).flatMap((cat) =>
    (loreIndex[cat.id] ?? []).map((entity) => ({
      ...entity,
      categoryLabel: categoryLabel(cat, isZh),
    }))
  );
  const filteredLoreEntities = loreSearch.trim()
    ? allLoreEntities.filter((e) => {
        const q = loreSearch.toLowerCase();
        return (
          e.name.toLowerCase().includes(q) ||
          e.aliases.some((a) => a.toLowerCase().includes(q)) ||
          e.categoryLabel.toLowerCase().includes(q)
        );
      })
    : allLoreEntities;

  const toggleLorePath = (dirPath: string) => {
    setSelectedLorePaths((prev) => {
      const next = prev.includes(dirPath)
        ? prev.filter((p) => p !== dirPath)
        : [...prev, dirPath];
      savePinnedLore(projectPath, next);
      return next;
    });
  };

  // Only count/label pins that still resolve to an existing entity or facet —
  // a deleted lore entry can leave a stale path in storage, harmless but
  // shouldn't inflate the badge (it is also ignored downstream when assembling
  // context). Facet pins use the "dirPath#file" form (see loreSelect).
  const pinnedCount = selectedLorePaths.filter((p) => {
    // Whole string matching an entity dirPath = entity pin, even if the path
    // itself contains '#' — mirror loreSelect's index-aware resolution.
    if (allLoreEntities.some((e) => e.dirPath === p)) return true;
    const [pin] = parsePins([p]);
    if (!pin.facetFile) return false;
    const entity = allLoreEntities.find((e) => e.dirPath === pin.dirPath);
    return !!entity && (entity.facets ?? []).some((f) => f.file === pin.facetFile);
  }).length;

  // ── Context forecast ────────────────────────────────────────────────────────
  // Must resolve the same way runTask does, or the forecast sizes a prompt the
  // author is not actually going to send.
  const systemPrompt = prompts.find((p) => p.id === activePromptId)?.content
    ?? profileSystemPrompt();
  // Mirrors how runTask builds the instruction, so the forecast sizes the prompt
  // that is actually going to be sent.
  const instructionText = runTaskDef.freeform
    ? customInstr
    : runTaskDef.instructionKey
      ? t(runTaskDef.instructionKey, { length: continueLength })
      : "";
  // Zero when the profile doesn't use memory, and not only because the load is
  // skipped: switching profiles mid-session leaves whatever memoryStore already
  // held for this document, and counting it here would forecast a layer runTask
  // no longer sends.
  const memoryChars = usesMemory
    ? memory?.segments.reduce((n, s) => n + s.summary.length, 0) ?? 0
    : 0;

  const forecast = useContextForecast({
    contextSize: activeModel?.contextSize ?? 0,
    maxOutputTokens: activeModel?.maxOutput,
    utilization: contextUtilization,
    loreBudgetTokens,
    systemPromptChars: systemPrompt.length,
    instructionChars: instructionText.length,
    selectionChars: isContinue ? 0 : selection.length,
    outlineChars: isContinue ? outline.length : 0,
    knowledgeChars: isContinue ? additionalKnowledge.length : 0,
    documentText: content,
    // Same anchor runTask applies — the forecast must describe the request that
    // will actually be sent, not one built on an offset from another file.
    anchorOffset:
      continueAnchor ??
      (selectionRange && content.slice(selectionRange.from, selectionRange.to) === selection
        ? selectionRange.to
        : content.length),
    recentWindowChars: supportsExtras ? contextChars : undefined,
    isContinue,
    replyChars: isContinue ? continueLength : undefined,
    memoryChars,
    toolSchemaTokens,
  });
  // Report/estimate conversions share the forecast's measured ratio when there
  // is one, so the panel never shows two different token counts for one block.
  const charsPerToken = forecast?.charsPerToken ?? 3;

  /** 提高预算 → step the lore budget up to the next preset tier. */
  const raiseLoreBudget = () => {
    const next = LORE_BUDGET_OPTIONS.find((n) => n > loreBudgetTokens);
    setLoreBudgetTokens(next ?? Math.min(LORE_BUDGET_MAX, loreBudgetTokens * 2));
  };

  // The label of the task that will actually run — Agent 模式 swaps the task, so
  // the run button should name what the click is going to do.
  const currentTaskLabel = taskLabel(runTaskDef, isZh, t);

  // Results pane shows something whenever a run is in flight or has produced output.
  const hasResults = isRunning || !!output || !!error || agentLog.length > 0 || !!usage;

  const sectionVariants = useMotionPreset(panelFade);

  return (
    <div className={styles.panel} onKeyDown={handlePanelKeyDown}>
      {/* 取材范围的骑缝带。任务面板和对话共用同一个控件与同一份状态——两处各存一份
          会让作者在一处切了范围、另一处仍按旧范围跑（设计稿 03 屏 26-B）。 */}
      {loreScope !== null && (
        <ScopeBand
          index={loreIndex}
          scope={loreScope}
          variant="narrow"
          onSwitch={setScopeMenu}
          onReset={() => setLoreScope(projectPath, null)}
        />
      )}
      {scopeMenu && (
        <ScopeMenu
          index={loreIndex}
          declared={collections}
          scope={loreScope}
          anchor={scopeMenu}
          variant="narrow"
          onPick={(next) => setLoreScope(projectPath, next)}
          onClose={() => setScopeMenu(null)}
        />
      )}
      {/* 两栏在带子**下面**一层：骑缝带横跨整个面板，而 `.panel` 因此是列。
          直接把带子塞进行 flex 里，它的 width:100% 会变成第三个栏位，把真正的
          两栏挤出 overflow:hidden——面板上就只剩一条带子。 */}
      <div className={styles.cols}>
        {/* ══════════ Config column ══════════ */}
        <div className={styles.configCol}>
          <div className={styles.configScroll}>
            {!hasConfig ? (
              <div className={styles.emptyHint}>{t("ai.panel.noProvider")}</div>
            ) : (
              <>
                {/* ── Task ── */}
                <div className={styles.section}>
                  <SectionHead label={t("ai.panel.taskLabel", { defaultValue: "任务" })} />
                  {/* Whatever the enabled packs offer, however many — 自定义 is
                      an ordinary entry in that list, not a hardcoded extra
                      button. The base menu (`pack: null`) renders flat — it is
                      the row every project has; each pack's own tasks follow as
                      their own labelled row, so a bid task is findable without
                      diluting the everyday writing row. */}
                  {taskGroups.map((group) => {
                    const renderSegment = (opt: ResolvedTask) => (
                      <button
                        key={opt.id}
                        className={`${styles.taskSegment} ${task.id === opt.id ? styles.taskSegmentActive : ""}`}
                        onClick={() => setSelectedTask(opt.id)}
                        disabled={isRunning}
                        title={taskDesc(opt, isZh, t) || undefined}
                      >
                        {taskLabel(opt, isZh, t)}
                      </button>
                    );
                    return group.pack === null ? (
                      <div key="base" className={styles.taskSegmented}>
                        {group.tasks.map(renderSegment)}
                      </div>
                    ) : (
                      <div key={group.pack.id} className={styles.packTaskGroup}>
                        <span className={styles.packTaskEyebrow}>{profileLabel(group.pack, isZh)}</span>
                        <div className={styles.taskSegmented}>
                          {group.tasks.map(renderSegment)}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* ── Target + instruction ──
                    Enter-only animation, deliberately: an AnimatePresence
                    `mode="wait"` crossfade would hold the outgoing branch on
                    screen for the length of its exit before the new one appears,
                    and a task switch is a direct manipulation that should land
                    under the cursor immediately. `key` still resets the subtree,
                    so anything in here must keep its state in AiPanel or a store —
                    a local useState inside these branches would be wiped on every
                    task switch. */}
                <motion.div
                  key={selectedTask}
                  className={styles.section}
                  variants={sectionVariants}
                  initial="initial"
                  animate="animate"
                  transition={springPanel}
                >
                    {/* Continue has a target too — it just isn't a selection. Name
                        the file and the spot the passage will be written from and
                        inserted at, so "where does this land?" is never a guess. */}
                    {isContinue && focus.filePath && (
                      <div className={styles.targetCard}>
                        <span className={styles.targetLabel}>
                          {continueMode === "opening"
                            ? t("ai.panel.continueTargetOpening", {
                                defaultValue: "续写目标 · 从开头写起 · {{file}}",
                                file: basename(focus.filePath),
                              })
                            : continueMode === "end"
                            ? t("ai.panel.continueTargetEnd", {
                                defaultValue: "续写目标 · 文末 · {{file}}",
                                file: basename(focus.filePath),
                              })
                            : continueAnchor === null
                            ? t("ai.panel.continueTargetLost", {
                                defaultValue: "续写目标 · 选区已失效，请重新标记",
                              })
                            : t("ai.panel.continueTargetPara", {
                                defaultValue: "续写目标 · 第 {{para}} 段之后 · {{file}}",
                                para: paragraphIndexAt(content, continueAnchor),
                                file: basename(focus.filePath),
                              })}
                        </span>
                        <button className={styles.linkBtn} onClick={locateAnchor}>
                          <Crosshair size={10} strokeWidth={1.8} />
                          {t("ai.panel.locateAnchor", { defaultValue: "定位插入点" })}
                        </button>
                      </div>
                    )}

                    {/* Selected text — the edit target, shown explicitly. Hidden for
                        continue, which has its own target card above. */}
                    {!isContinue && selection && (
                      <div className={styles.targetCard}>
                        <span className={styles.targetLabel}>
                          {/* Naming the source ties the card to the band painted
                              in the document, so a highlight is never unexplained. */}
                          {t(selectionSource === "marker"
                            ? "ai.panel.targetSummaryMarked"
                            : "ai.panel.targetSummary", {
                            defaultValue: "{{task}}选区 · 第 {{para}} 段, {{chars}} 字",
                            task: currentTaskLabel,
                            para: paragraphIndexAt(content, selectionRange?.from ?? 0),
                            chars: selection.length,
                          })}
                        </span>
                        {selectionRange && (
                          <button className={styles.linkBtn} onClick={locateSelection}>
                            <Crosshair size={10} strokeWidth={1.8} />
                            {t("ai.panel.locateSelection", { defaultValue: "在正文中定位" })}
                          </button>
                        )}
                        <button className={styles.linkBtn} onClick={dismissTarget}>
                          <X size={10} strokeWidth={1.8} />
                          {t("ai.panel.clearTarget", { defaultValue: "取消目标" })}
                        </button>
                      </div>
                    )}
                    {needsAnchor && (
                      <div className={styles.warnLine}>
                        {t("ai.panel.expandNeedsTarget", {
                          defaultValue: "「扩写选区」需要一段可定位的选区 —— 请标记，或改用文末续写",
                        })}
                      </div>
                    )}
                    {needsSelection && (
                      <div className={styles.warnLine}>{t("ai.panel.selectFirstHint")}</div>
                    )}
                    {task.batch && (
                      <button
                        className={styles.batchBtn}
                        disabled={!hasConfig || isRunning || batchRunning}
                        onClick={() => setShowBatch(true)}
                      >
                        <ListChecks size={12} strokeWidth={1.8} />
                        {batchRunning
                          ? t("ai.batch.runningShort")
                          : t("ai.batch.open", { task: currentTaskLabel })}
                      </button>
                    )}

                    {/* Custom instruction (+ Agent 模式) */}
                    {task.freeform ? (
                      <>
                        <textarea
                          ref={instrRef}
                          className={styles.textarea}
                          rows={4}
                          placeholder={t(
                            agentMode ? "ai.panel.agentInstruction" : "ai.panel.customInstruction",
                            { doc: terms.doc, kb: terms.kb },
                          )}
                          value={customInstr}
                          onChange={(e) => setCustomInstr(e.target.value)}
                          onContextMenu={snippetSave.onTextareaContextMenu}
                        />
                        {/* Insert (not send): a snippet is a starting point the
                            author completes before running. */}
                        <SnippetPicker
                          value={customInstr}
                          onInsert={setCustomInstr}
                          onAfterInsert={() => requestAnimationFrame(() => {
                            const el = instrRef.current;
                            if (!el) return;
                            el.focus();
                            el.setSelectionRange(el.value.length, el.value.length);
                            el.scrollTop = el.scrollHeight;
                          })}
                        />
                        {/* Only where the task names one to switch to — a profile
                            can offer a freeform task with no agent counterpart. */}
                        {agentTask && (
                          <label className={styles.toggleRow}>
                            <input
                              type="checkbox"
                              checked={agentMode}
                              onChange={(e) => setAgentMode(e.target.checked)}
                            />
                            <span>{t("ai.panel.agentModeLabel", { kb: terms.kb })}</span>
                          </label>
                        )}
                        {agentMode && agentTask && (
                          <div className={styles.hintLine}>
                            {t("ai.panel.agentModeHint", { kb: terms.kb, docs: terms.docs })}
                          </div>
                        )}
                      </>
                    ) : isContinue ? (
                      <>
                        <div className={styles.controlRow}>
                          <span className={styles.controlLabel}>{t("ai.panel.continueLength")}</span>
                          <div className={styles.chipGroup}>
                            {CONTINUE_LENGTH_OPTIONS.map((len) => (
                              <button
                                key={len}
                                className={`${styles.chip} ${continueLength === len ? styles.chipActive : ""}`}
                                onClick={() => setContinueLength(len)}
                              >
                                {len >= 1000 ? `${len / 1000}k` : len}
                              </button>
                            ))}
                          </div>
                          <span className={styles.controlUnit}>
                            {t("ai.panel.unitChars", { defaultValue: "字" })}
                          </span>
                        </div>

                        {/* Where the continuation attaches. Explicit, because the
                            three answers are not inferable from document state —
                            and because the panel promises this spot on the card
                            above and then writes there. */}
                        <div className={styles.controlRow}>
                          <span className={styles.controlLabel}>
                            {t("ai.panel.continuePosition", { defaultValue: "续写位置" })}
                          </span>
                          <div className={styles.chipGroup}>
                            {([
                              ["opening", "modeOpening", "开篇", "从本{{doc}}开头写起，插在现有正文之前"],
                              ["end", "modeEnd", "文末", "接在本{{doc}}结尾，传统续写"],
                              ["expand", "modeExpand", "扩写选区", "从选区末尾往下写，插在该段之后"],
                            ] as const).map(([mode, key, label, hint]) => (
                              <button
                                key={mode}
                                className={`${styles.chip} ${continueMode === mode ? styles.chipActive : ""}`}
                                onClick={() => setPickedMode(mode)}
                                title={t(`ai.panel.${key}Hint`, { defaultValue: hint, doc: terms.doc })}
                              >
                                {t(`ai.panel.${key}`, { defaultValue: label })}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* How this chapter opens — only a question while it is
                            still (nearly) empty, and only when something precedes
                            it in the book. Independent of the position above: a
                            chapter with nothing in it lacks continuity of its own
                            wherever you write. */}
                        {wantsOpeningChoice && bridgeCandidates.length > 0 && (
                          <div className={styles.controlRow}>
                            <span className={styles.controlLabel}>
                              {t("ai.panel.openingMode", { defaultValue: "开篇方式" })}
                            </span>
                            <div className={styles.chipGroup}>
                              <button
                                className={`${styles.chip} ${openingMode === "standalone" ? styles.chipActive : ""}`}
                                onClick={() => setOpeningMode("standalone")}
                                title={t("ai.panel.openingStandaloneHint", {
                                  defaultValue: "不注入上一{{doc}}原文，本{{doc}}独立开头（{{priorAll}}与{{priorRecap}}照常提供）",
                                  doc: terms.doc,
                                  priorAll: priorAllLabel,
                                  priorRecap: priorRecapLabel,
                                })}
                              >
                                {t("ai.panel.openingStandalone", { defaultValue: "独立开篇" })}
                              </button>
                              <button
                                className={`${styles.chip} ${openingMode === "bridge" ? styles.chipActive : ""}`}
                                onClick={() => setOpeningMode("bridge")}
                                title={t("ai.panel.openingBridgeHint", {
                                  defaultValue: "注入所选{{doc}}的结尾原文，用来衔接文风与内容",
                                  doc: terms.doc,
                                })}
                              >
                                {t("ai.panel.openingBridge", { defaultValue: "承接前一{{doc}}", doc: terms.doc })}
                              </button>
                            </div>
                            {openingMode === "bridge" && (
                              <Select
                                className={styles.select}
                                value={bridgePath ?? ""}
                                onChange={(v) => setBridgePath(v || null)}
                                ariaLabel={t("ai.panel.openingBridge", { defaultValue: "承接前一{{doc}}", doc: terms.doc })}
                                options={volumes.flatMap((v) =>
                                  v.chapters
                                    .filter((c) => bridgeCandidates.some((b) => b.path === c.path))
                                    .map((c) => ({ value: c.path, label: c.title, group: v.name })),
                                )}
                              />
                            )}
                          </div>
                        )}

                        <ExtraSection
                          label={t("ai.panel.continueOutline")}
                          badge={outline.trim() ? "✓" : undefined}
                        >
                          <textarea
                            className={styles.extraTextarea}
                            rows={4}
                            placeholder={t("ai.panel.continueOutlinePlaceholder", { doc: terms.doc })}
                            value={outline}
                            onChange={(e) => setOutline(e.target.value)}
                          />
                        </ExtraSection>
                        <ExtraSection
                          label={t("ai.panel.continueExtraKnowledge")}
                          badge={additionalKnowledge.trim() ? "✓" : undefined}
                        >
                          <textarea
                            className={styles.extraTextarea}
                            rows={4}
                            placeholder={t("ai.panel.continueExtraKnowledgePlaceholder", { kb: terms.kb })}
                            value={additionalKnowledge}
                            onChange={(e) => setAdditionalKnowledge(e.target.value)}
                          />
                        </ExtraSection>
                      </>
                    ) : (
                      <textarea
                        className={styles.textarea}
                        rows={3}
                        placeholder={t("ai.panel.taskRequirementPlaceholder")}
                        value={requirement}
                        onChange={(e) => setRequirement(e.target.value)}
                      />
                    )}
                </motion.div>

                <hr className={styles.divider} />

                {/* ── Context allocation ── */}
                <ContextAllocation forecast={forecast} />

                <hr className={styles.divider} />

                {/* ── Draft count ──
                    Hidden for the tasks that can't fan out (agent writes to disk;
                    continue shares one execution log) rather than shown disabled —
                    a control that never applies is just noise. See draftCountFor. */}
                {maxDrafts > 1 && (
                  <div className={styles.controlRow}>
                    <span className={styles.controlLabel}>
                      {t("ai.panel.draftCount", { defaultValue: "生成版本" })}
                    </span>
                    <div className={styles.chipGroup}>
                      {DRAFT_COUNT_OPTIONS.map((n) => (
                        <button
                          key={n}
                          className={`${styles.chip} ${draftCount === n ? styles.chipActive : ""}`}
                          onClick={() => setDraftCount(n)}
                          title={t("ai.panel.draftCountHint", {
                            defaultValue: "并行生成多个版本，每个都是一次独立请求（费用相应增加）",
                          })}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                    <span className={styles.controlUnit}>
                      {t("ai.panel.unitDrafts", { defaultValue: "版" })}
                    </span>
                  </div>
                )}

                {/* ── Reference window (edit tasks only — continue has no picker) ── */}
                {supportsExtras && (
                  <div className={styles.controlRow}>
                    <span className={styles.controlLabel}>{t("ai.panel.contextRange")}</span>
                    <div className={styles.chipGroup}>
                      {CONTEXT_CHARS_OPTIONS.map((n) => (
                        <button
                          key={n}
                          className={`${styles.chip} ${contextChars === n ? styles.chipActive : ""}`}
                          onClick={() => setContextChars(n)}
                          title={t("ai.panel.contextRangeHint")}
                        >
                          {n === 0 ? t("ai.panel.contextRangeNone") : n >= 1000 ? `${n / 1000}k` : n}
                        </button>
                      ))}
                    </div>
                    <span className={styles.controlUnit}>
                      {t("ai.panel.unitChars", { defaultValue: "字" })}
                    </span>
                  </div>
                )}

                {/* ── Story memory (only where the profile's documents use it) ── */}
                {usesMemory && (
                  <>
                    <MemorySection
                      detailSpan={supportsExtras ? contextChars : DEFAULT_DETAIL_SPAN}
                      appendMode={isContinue}
                    />
                    <hr className={styles.divider} />
                  </>
                )}

                {/* ── Lore ── */}
                <LoreSection
                  entities={filteredLoreEntities}
                  search={loreSearch}
                  setSearch={setLoreSearch}
                  selectedPaths={selectedLorePaths}
                  toggle={toggleLorePath}
                  charsPerToken={charsPerToken}
                />

                {/* System-prompt override lives at the bottom: set once, rarely touched. */}
                {prompts.some((p) => p.scene === "system") && (
                  <div className={styles.controlRow}>
                    <span className={styles.controlLabel}>
                      {t("ai.panel.systemPromptLabel", { defaultValue: "系统提示词" })}
                    </span>
                    <Select
                      className={styles.select}
                      value={activePromptId ?? ""}
                      onChange={(v) => setActivePrompt(v)}
                      options={[
                        { value: "", label: t("ai.panel.defaultSystemPrompt") },
                        ...prompts
                          .filter((p) => p.scene === "system")
                          .map((p) => ({ value: p.id, label: p.name })),
                      ]}
                      ariaLabel={t("ai.panel.defaultSystemPrompt")}
                    />
                  </div>
                )}
              </>
            )}
          </div>

          {/* Focus not settled: the editor still holds the previous document, so
              say what is being waited on rather than silently disabling Run. */}
          {hasConfig && !focus.settled && (
            <div className={styles.focusNotice}>
              {focusBlockedByImage(focus)
                ? t("ai.panel.focusImage", { defaultValue: "当前打开的是图片，请先打开一个文档" })
                : focus.pendingPath
                  ? t("ai.panel.focusLoading", {
                      defaultValue: "正在载入 {{name}}…",
                      name: basename(focus.pendingPath),
                    })
                  : t("ai.panel.focusNone", { defaultValue: "未打开文档" })}
            </div>
          )}

          {/* Sticky action footer — cost forecast + Run/Stop, always reachable */}
          {hasConfig && (
            <div className={styles.configFooter}>
              <div className={styles.estimate}>
                <span>
                  {t("ai.panel.estInput", { defaultValue: "预计输入" })}{" "}
                  <strong>{forecast ? `${formatBudget(forecast.usedTokens)} tk` : "—"}</strong>
                </span>
                <span>
                  {t("ai.panel.estOutput", { defaultValue: "输出上限" })}{" "}
                  <strong>
                    {forecast ? forecast.reservedOutputTokens.toLocaleString() : "—"}
                    {forecast ? " tk" : ""}
                  </strong>
                </span>
              </div>
              {isRunning ? (
                <button className={styles.abortBtn} onClick={abort}>
                  <Square size={11} fill="currentColor" />
                  {t("ai.panel.stop")}
                </button>
              ) : (
                <button className={styles.runBtn} disabled={!canRun} onClick={handleRun}>
                  <Play size={12} fill="currentColor" />
                  {t("ai.panel.runTask", { defaultValue: "执行{{task}}", task: currentTaskLabel })}
                  <kbd className={styles.runKbd}>{MOD_KEY === "⌘" ? "⌘↵" : "Ctrl ↵"}</kbd>
                </button>
              )}
            </div>
          )}
        </div>

        {/* ══════════ Results column ══════════ */}
        <div className={styles.resultCol}>
          <div className={styles.resultScroll}>
            {/* Injection transparency: what lore went into this run and why */}
            {loreReport && (
              <LoreReportSection
                report={loreReport}
                charsPerToken={charsPerToken}
                onRaiseBudget={raiseLoreBudget}
              />
            )}

            {/* Only while 本次任务都批准 is live. Keyed to the running task's own
                controller, which is exactly what aiTaskStore passed as the grant
                key — so the chip goes out by itself when the run ends. */}
            <AutoApproveChip owner={taskAbortController} />

            {/* Pending lore plans + manuscript edits + round-cap questions — the
                loop is blocked on these */}
            {(pendingPlans.length > 0 || pendingApprovals.length > 0
              || pendingTruncations.length > 0 || pendingRoundLimits.length > 0) && (
              <div className={styles.approvals}>
                {pendingPlans.map((p) => (
                  <PlanCard key={p.plan.id} item={p} />
                ))}
                {pendingApprovals.map((p) => (
                  <ApprovalCard key={p.proposal.id} item={p} />
                ))}
                {pendingTruncations.map((p) => (
                  <TruncationCard key={p.id} item={p} />
                ))}
                {pendingRoundLimits.map((p) => (
                  <RoundLimitCard key={p.id} item={p} />
                ))}
              </div>
            )}

            {/* Execution log: run lifecycle, rounds, tool calls */}
            {(agentLog.length > 0 || error) && (
              <div className={styles.resultSection}>
                <SectionHead
                  label={t("ai.panel.runSection", { defaultValue: "运行" })}
                  meta={t("ai.panel.runCount", { defaultValue: "{{n}} 条", n: agentLog.length })}
                />
                {agentLog.length > 0 && <AgentLog log={agentLog} isRunning={isRunning} flat />}
                {/* Band ④ — the plan, when the agent split the work. Read off
                    disk (see TaskPanel.tsx), so it also shows a task resumed
                    from an earlier session. */}
                <TaskPanel
                  projectPath={projectPath}
                  taskId={taskWorkspace?.taskId}
                  revision={taskDocRevision([agentLog])}
                  tokens={sumTokens([agentLog])}
                />
                {error && (
                  <ErrorBlock
                    message={error}
                    onRetry={canRun ? handleRun : null}
                    onSwitchModel={switchModelAndRetry}
                    messages={lastMessages}
                  />
                )}
              </div>
            )}

            {/* Waiting for the first token */}
            {isRunning && !output && !agentLog.some((e) => e.kind === "tool-step") && (
              <div className={styles.thinking}>
                <span className={styles.spinner} />
                {t("ai.panel.thinking")}
              </div>
            )}

            {/* Result */}
            <div className={`${styles.resultSection} ${styles.resultSectionGrow}`}>
              <SectionHead
                label={t("ai.panel.resultSection", { defaultValue: "结果" })}
                action={output ? (
                  <span className={styles.resultActions}>
                    <button className={styles.btnSecondary} onClick={clearOutput}>
                      {t("ai.panel.clear")}
                    </button>
                    <button
                      className={styles.btnPrimary}
                      onClick={handleApply}
                      disabled={outputMismatched}
                      title={outputMismatched ? t("ai.panel.outputMismatchedTitle") : undefined}
                    >
                      {replaceRange ? t("ai.panel.replaceSelection") : t("ai.panel.insertToDoc")}
                    </button>
                  </span>
                ) : undefined}
              />
              {/* Draft tabs — only when there is a choice to make. A single-draft
                  run keeps the pane exactly as it was. */}
              {drafts.length > 1 && (
                <div className={styles.draftTabs} role="tablist">
                  {drafts.map((d) => (
                    <button
                      key={d.id}
                      role="tab"
                      aria-selected={d.id === activeDraft?.id}
                      className={`${styles.draftTab} ${d.id === activeDraft?.id ? styles.draftTabActive : ""} ${d.error ? styles.draftTabFailed : ""}`}
                      onClick={() => setActiveDraft(d.id)}
                      title={d.error ?? undefined}
                    >
                      {t("ai.panel.draftLabel", { n: d.index, defaultValue: `版本 ${d.index}` })}
                      {/* Per-draft state, because they finish at different times and
                          an empty tab is otherwise indistinguishable from a failed one. */}
                      {d.error ? (
                        <span className={styles.draftTabMark}>!</span>
                      ) : !d.done ? (
                        <span className={styles.draftSpinner} />
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
              {activeDraft?.error ? (
                <ErrorBlock
                  message={activeDraft.error}
                  onRetry={canRun ? handleRun : null}
                  onSwitchModel={switchModelAndRetry}
                  messages={lastMessages}
                />
              ) : output ? (
                <div className={styles.output} ref={outputRef} key={activeDraft?.id}>
                  {output}
                  {isRunning && !activeDraft?.done && <span className={styles.cursor}>▌</span>}
                </div>
              ) : (
                <div className={styles.resultEmpty}>
                  <span>{t("ai.panel.resultsPlaceholder")}</span>
                  <span className={styles.resultEmptySub}>
                    {t("ai.panel.resultsPlaceholderSub", {
                      defaultValue: "可对比、替换或插入到文档",
                    })}
                  </span>
                </div>
              )}
            </div>

            {/* The model hit its max-output length rather than finishing on its
                own — the text above is real, but may stop mid-thought. */}
            {activeDraft?.truncated && !activeDraft.error && (
              <div className={styles.truncatedNotice}>{t("ai.panel.truncatedNotice")}</div>
            )}

            {/* This result was generated against a different document than the
                one now open — applying it here would splice one chapter's
                output into another. Switch back to insert it. */}
            {outputMismatched && sourceFilePath && (
              <div className={styles.truncatedNotice}>
                {t("ai.panel.outputMismatched", { file: basename(sourceFilePath) })}
              </div>
            )}

            {/* Token usage for the finished run */}
            {usage && hasResults && (
              <div className={styles.usageBar}>
                <span>{t("ai.panel.inputTokens", { tokens: usage.inputTokens.toLocaleString() })}</span>
                <span>{t("ai.panel.outputTokens", { tokens: usage.outputTokens.toLocaleString() })}</span>
                <span>≈ ${usage.cost.toFixed(5)}</span>
              </div>
            )}
          </div>

          {/* Status bar — names the focused document, so which file the assistant
              is working on is never something you have to infer. */}
          <div className={styles.statusBar}>
            <span className={styles.statusFocus} title={focus.filePath ?? undefined}>
              {focus.filePath ? basename(focus.filePath) : t("ai.panel.focusNone", { defaultValue: "未打开文档" })}
            </span>
            <span className={styles.statusSep}>|</span>
            <span>
              {t("ai.panel.chapterChars", {
                defaultValue: "本{{doc}} {{chars}} 字",
                doc: terms.doc,
                chars: content.length.toLocaleString(),
              })}
            </span>
            {pinnedCount > 0 && (
              <>
                <span className={styles.statusSep}>|</span>
                <span>
                  {t("ai.panel.pinnedLoreCount", {
                    defaultValue: "引用 {{n}} {{entry}}",
                    n: pinnedCount,
                    entry: terms.entry,
                  })}
                </span>
              </>
            )}
            {activeModel && activeProvider && (
              <span className={styles.statusModel}>
                {activeProvider.name} · {activeModel.name}
              </span>
            )}
          </div>
        </div>
      </div>

      {showBatch && (
        <BatchRunModal
          taskId={task.id}
          taskLabel={currentTaskLabel}
          onClose={() => setShowBatch(false)}
        />
      )}
      {/* 右键 → 存为片段 的菜单与命名浮层。 */}
      {snippetSave.node}
    </div>
  );
}
