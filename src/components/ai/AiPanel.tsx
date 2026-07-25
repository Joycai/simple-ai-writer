import { useState, useRef, useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Square, Play, BookMarked, Sparkles, Layers, Pin } from "lucide-react";
import { useAiTaskStore, type TaskKind } from "../../stores/aiTaskStore";
import { AgentLog } from "./AgentLog";
import { useAiStore } from "../../stores/aiStore";
import { useAppStore, LORE_BUDGET_MIN, LORE_BUDGET_MAX } from "../../stores/appStore";
import { useEditorStore } from "../../stores/editorStore";
import { useLoreStore } from "../../stores/loreStore";
import { useMemoryStore } from "../../stores/memoryStore";
import { useProjectStore } from "../../stores/projectStore";
import type { TaskExtras } from "../../lib/context/rag";
import { parsePins, type LoreActivationReport } from "../../lib/context/loreSelect";
import type { LoreFacet } from "../../lib/lore";
import {
  MEMORY_MIN_DOC_CHARS,
  MEMORY_SUGGEST_THRESHOLD_CHARS,
} from "../../lib/context/memory";
import { LORE_CATEGORIES } from "../../lib/lore";
import { RECENT_WINDOW_MIN_CHARS, STATIC_LORE_BUDGET_MAX_TOKENS } from "../../lib/context/budget";
import { panelFade, springPanel } from "../../lib/motion";
import styles from "./AiPanel.module.css";

const TASK_OPTIONS: { kind: TaskKind; labelKey: string; descKey: string }[] = [
  { kind: "continue", labelKey: "ai.tasks.continue", descKey: "ai.tasks.continueDesc" },
  { kind: "polish",   labelKey: "ai.tasks.polish",   descKey: "ai.tasks.polishDesc" },
  { kind: "rewrite",  labelKey: "ai.tasks.rewrite",  descKey: "ai.tasks.rewriteDesc" },
  { kind: "summary",  labelKey: "ai.tasks.summary",  descKey: "ai.tasks.summaryDesc" },
];

const CONTINUE_LENGTH_OPTIONS = [200, 500, 1000, 2000];
const CONTEXT_CHARS_OPTIONS = [0, 500, 1000, 2000];
/** Verbatim window size used by tasks without a contextChars picker
 *  (continue/custom). Owned by lib/context/budget so it can't drift. */
const DEFAULT_DETAIL_SPAN = RECENT_WINDOW_MIN_CHARS;

// Pinned-lore selection is persisted per project (keyed by project path) so the
// user doesn't have to re-check the same entities on every reload / task.
const PINNED_LORE_KEY = "ai:pinnedLore";
function loadPinnedLore(projectPath: string | null): string[] {
  if (!projectPath) return [];
  try {
    const raw = localStorage.getItem(`${PINNED_LORE_KEY}:${projectPath}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function savePinnedLore(projectPath: string | null, paths: string[]): void {
  if (!projectPath) return;
  try {
    localStorage.setItem(`${PINNED_LORE_KEY}:${projectPath}`, JSON.stringify(paths));
  } catch {
    // storage may be unavailable/full — non-critical, pins just won't persist
  }
}

// Execution log rendering lives in the shared <AgentLog> component
// (components/ai/AgentLog.tsx), also used by the lore AI modals.

/**
 * Story-memory status strip shown above the task config: coverage / staleness,
 * a create-update button, and — per the "checkpoint" UX — a warning banner when
 * the user is about to run a task whose pre-window text is largely uncovered.
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

  const status = memory
    ? t("ai.memory.statusCovered", {
        covered: freshCovered.toLocaleString(),
        total: content.length.toLocaleString(),
      }) + (staleCount > 0 ? t("ai.memory.statusStale", { count: staleCount }) : "")
    : t("ai.memory.statusNone");

  return (
    <div className={styles.memorySection}>
      <div className={styles.memoryRow}>
        <span className={styles.memoryLabel}>
          <BookMarked size={11} strokeWidth={1.8} />
          {t("ai.memory.title")}
        </span>
        <span className={styles.memoryStatus}>
          {isGenerating && progress
            ? t("ai.memory.generating", { done: progress.done, total: progress.total })
            : status}
        </span>
        {isGenerating ? (
          <button className={styles.memoryBtn} onClick={abort}>
            {t("ai.panel.stop")}
          </button>
        ) : (
          <button className={styles.memoryBtn} onClick={() => void generate()}>
            {memory ? t("ai.memory.btnUpdate") : t("ai.memory.btnCreate")}
          </button>
        )}
      </div>
      {(needsCreate || needsUpdate) && !isGenerating && (
        <div className={styles.memoryHint}>
          {needsCreate
            ? t("ai.memory.hintCreate", { chars: preDetail.toLocaleString() })
            : t("ai.memory.hintUpdate", { chars: gap.toLocaleString() })}
        </div>
      )}
      {notice && !isGenerating && <div className={styles.memoryNotice}>{notice}</div>}
      {error && <div className={styles.memoryError}>{error}</div>}
    </div>
  );
}

/** Collapsible extra-options section used inside the "continue" config panel. */
function ExtraSection({
  label,
  badge,
  children,
}: {
  label: string;
  badge?: string;
  children: React.ReactNode;
}) {
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
 * Lore injection token-budget presets (see loreSelect / appStore). Presets cover
 * the common tiers; the adjacent number field takes any value in
 * [LORE_BUDGET_MIN, LORE_BUDGET_MAX] for large-context models.
 */
const LORE_BUDGET_OPTIONS = [600, 2000, 8000, 32000];

/** Context-window utilization presets (see lib/context/budget). */
const UTILIZATION_OPTIONS = [0.25, 0.5, 0.75, 0.9];

/** Convert a planned char budget back to tokens for display. */
function toTokens(chars: number, charsPerToken: number): number {
  return Math.round(chars / (charsPerToken > 0 ? charsPerToken : 1));
}

/** Compact token count: 32000 → "32k", 1500 → "1.5k", 600 → "600". */
function formatBudget(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

/**
 * Reusable lore reference picker — two-level tree: pin whole entities, or
 * expand one and pin individual facets ("dirPath#file"). Facet pins imply the
 * entity core, and pinning two same-group facets overrides their exclusion.
 */
function LorePicker({
  entities,
  search,
  setSearch,
  selectedPaths,
  toggle,
}: {
  entities: { dirPath: string; name: string; categoryLabel: string; facets: LoreFacet[] }[];
  search: string;
  setSearch: (v: string) => void;
  selectedPaths: string[];
  toggle: (path: string) => void;
}) {
  const { t } = useTranslation();
  const loreBudgetTokens = useAppStore((s) => s.loreBudgetTokens);
  const setLoreBudgetTokens = useAppStore((s) => s.setLoreBudgetTokens);
  const contextUtilization = useAppStore((s) => s.contextUtilization);
  const setContextUtilization = useAppStore((s) => s.setContextUtilization);
  // Dynamic allocation needs a declared window; without one the recap layers
  // fall back to fixed constants and the utilization control does nothing.
  const activeModel = useAiStore((s) => s.models.find((m) => m.id === s.activeModelId));
  const contextSize = activeModel?.contextSize ?? 0;
  const contextAlloc = useAiTaskStore((s) => s.contextAlloc);
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

  return (
    <>
      <input
        className={styles.extraSearchInput}
        placeholder={t("ai.panel.continueLoreSearch")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className={styles.lorePickerList}>
        {entities.length === 0 ? (
          <span className={styles.lorePickerEmpty}>{t("ai.panel.continueLoreEmpty")}</span>
        ) : (
          entities.map((entity) => {
            const facets = entity.facets ?? [];
            const isExpanded = expanded.has(entity.dirPath);
            const pinnedFacetCount = facets.filter((f) =>
              selectedPaths.includes(`${entity.dirPath}#${f.file}`)
            ).length;
            return (
              <div key={entity.dirPath}>
                <label className={styles.lorePickerItem}>
                  <input
                    type="checkbox"
                    checked={selectedPaths.includes(entity.dirPath)}
                    onChange={() => toggle(entity.dirPath)}
                  />
                  <span className={styles.lorePickerName}>{entity.name}</span>
                  <span className={styles.lorePickerCat}>{entity.categoryLabel}</span>
                  {facets.length > 0 && (
                    <button
                      className={styles.lorePickerExpand}
                      onClick={(ev) => { ev.preventDefault(); toggleExpanded(entity.dirPath); }}
                      title={t("ai.panel.loreFacets", { defaultValue: "特征" })}
                    >
                      <Layers size={10} strokeWidth={1.8} />
                      {pinnedFacetCount > 0 ? `${pinnedFacetCount}/${facets.length}` : facets.length}
                      {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    </button>
                  )}
                </label>
                {isExpanded && facets.map((f) => {
                  const pinPath = `${entity.dirPath}#${f.file}`;
                  return (
                    <label key={pinPath} className={`${styles.lorePickerItem} ${styles.lorePickerFacet}`}>
                      <input
                        type="checkbox"
                        checked={selectedPaths.includes(pinPath)}
                        onChange={() => toggle(pinPath)}
                      />
                      <span className={styles.lorePickerName}>{f.title}</span>
                      {f.group && <span className={styles.lorePickerGroup}>{f.group}</span>}
                      <span className={styles.lorePickerCat}>~{Math.ceil(f.charCount / 3)} tk</span>
                    </label>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
      {/* Injection budget — how many tokens the 【设定资料】 block may use. */}
      <div className={styles.loreBudgetRow}>
        <span className={styles.loreBudgetLabel}>
          {t("ai.panel.loreBudget", { defaultValue: "设定预算" })}
        </span>
        <div className={styles.continueLengthOptions}>
          {LORE_BUDGET_OPTIONS.map((n) => (
            <button
              key={n}
              className={`${styles.lengthChip} ${loreBudgetTokens === n ? styles.lengthChipActive : ""}`}
              onClick={() => { setBudgetDraft(null); setLoreBudgetTokens(n); }}
              title={t("ai.panel.loreBudgetHint", {
                defaultValue: "【设定资料】最多占用的 token 数",
                min: LORE_BUDGET_MIN,
                max: LORE_BUDGET_MAX.toLocaleString(),
              })}
            >
              {formatBudget(n)}
            </button>
          ))}
        </div>
        <input
          className={styles.loreBudgetInput}
          type="number"
          min={LORE_BUDGET_MIN}
          max={LORE_BUDGET_MAX}
          step={100}
          value={budgetDraft ?? String(loreBudgetTokens)}
          onChange={(e) => setBudgetDraft(e.target.value)}
          onBlur={commitBudgetDraft}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          title={t("ai.panel.loreBudgetHint", {
            defaultValue: "【设定资料】最多占用的 token 数",
            min: LORE_BUDGET_MIN,
            max: LORE_BUDGET_MAX.toLocaleString(),
          })}
          aria-label={t("ai.panel.loreBudget", { defaultValue: "设定预算" })}
        />
      </div>
      {/* Utilization — the share of the window one request may occupy. Caps how
          much 【前情提要】/【全书前情】 may grow on a large-context model. */}
      <div className={styles.loreBudgetRow}>
        <span className={styles.loreBudgetLabel}>
          {t("ai.panel.contextUtilization", { defaultValue: "上下文利用率" })}
        </span>
        <div className={styles.continueLengthOptions}>
          {UTILIZATION_OPTIONS.map((r) => (
            <button
              key={r}
              className={`${styles.lengthChip} ${Math.abs(contextUtilization - r) < 0.001 ? styles.lengthChipActive : ""}`}
              onClick={() => setContextUtilization(r)}
              disabled={contextSize <= 0}
              title={contextSize > 0
                ? t("ai.panel.contextUtilizationHint", {
                    defaultValue: "单次请求最多占用模型上下文窗口的比例",
                    tokens: Math.floor(contextSize * r).toLocaleString(),
                  })
                : t("ai.panel.contextUtilizationUnset", {
                    defaultValue: "当前模型未设置「上下文大小」，前情层使用固定预算",
                  })}
            >
              {Math.round(r * 100)}%
            </button>
          ))}
        </div>
      </div>
      {loreCapped && (
        <div className={styles.contextPlanLine}>
          {t("ai.panel.loreBudgetStaticCap", {
            defaultValue: "模型未设置「上下文大小」，本次仅注入 {{cap}} tokens 设定",
            cap: STATIC_LORE_BUDGET_MAX_TOKENS.toLocaleString(),
          })}
        </div>
      )}
      {contextAlloc?.dynamic && (
        <div className={styles.contextPlanLine}>
          {t("ai.panel.contextPlan", {
            defaultValue: "上次分配：近期 {{recent}} · 设定 {{lore}} · 前情 {{memory}} · 全书 {{book}}",
            recent: `${formatBudget(toTokens(contextAlloc.recentWindowChars, contextAlloc.charsPerToken))} tk`,
            lore: `${formatBudget(toTokens(contextAlloc.loreChars, contextAlloc.charsPerToken))} tk`,
            memory: `${formatBudget(toTokens(contextAlloc.memoryChars, contextAlloc.charsPerToken))} tk`,
            book: `${formatBudget(toTokens(contextAlloc.bookPriorChars, contextAlloc.charsPerToken))} tk`,
          })}
        </div>
      )}
    </>
  );
}

/** Post-assembly transparency: what got injected, what was dropped and why. */
function LoreReportSection({ report }: { report: LoreActivationReport }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const estTk = (chars: number) => Math.ceil(chars / 3);

  const dropReason = (reason: string) =>
    reason === "no-key" ? t("ai.panel.loreDropNoKey", { defaultValue: "未命中关键词" })
    : reason === "group-lost" ? t("ai.panel.loreDropGroupLost", { defaultValue: "互斥组落选" })
    : reason === "budget" ? t("ai.panel.loreDropBudget", { defaultValue: "超出预算" })
    : t("ai.panel.loreDropManual", { defaultValue: "仅手动" });

  return (
    <div className={styles.loreReport}>
      <button className={styles.agentStepsHeader} onClick={() => setOpen((v) => !v)}>
        <span className={styles.agentStepsChevron}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <span className={styles.agentStepsTitle}>
          {t("ai.panel.loreReportTitle", { defaultValue: "本次注入设定" })}
        </span>
        <span className={styles.agentStepsCount}>
          ({report.entities.length > 0
            ? `~${estTk(report.usedChars)}/${estTk(report.budgetChars)} tk`
            : t("ai.panel.loreReportEmpty", { defaultValue: "无" })})
        </span>
      </button>
      {open && report.entities.length > 0 && (
        <div className={styles.loreReportBody}>
          {report.entities.map((e) => (
            <div key={e.dirPath} className={styles.loreReportEntity}>
              <span className={styles.loreReportName}>
                {e.reason === "pinned" && <Pin size={9} strokeWidth={1.8} />}
                {e.name}
              </span>
              {e.layers.filter((l) => l.kind !== "summary").map((l, i) => (
                <span
                  key={`${l.kind}-${l.file ?? i}`}
                  className={styles.loreReportChip}
                  title={l.matchedKeys?.length
                    ? t("ai.panel.loreMatchedKeys", { keys: l.matchedKeys.join(", "), defaultValue: `命中：${l.matchedKeys.join(", ")}` })
                    : undefined}
                >
                  {l.pinned && <Pin size={8} strokeWidth={1.8} />}
                  {l.kind === "core"
                    ? t("ai.panel.loreCore", { defaultValue: "核心" }) + (l.truncated ? "✂" : "")
                    : l.title}
                  <span className={styles.loreReportTk}>{estTk(l.chars)}tk</span>
                </span>
              ))}
              {e.droppedFacets.map((d) => (
                <span
                  key={`drop-${d.file}`}
                  className={`${styles.loreReportChip} ${styles.loreReportDropped}`}
                  title={dropReason(d.reason)}
                >
                  {d.title}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AiPanel() {
  const { t, i18n } = useTranslation();
  const {
    isRunning, output, error, usage, agentLog, loreReport,
    runTask, abort, clearOutput, selection, selectionRange, requestedTask, setRequestedTask,
  } = useAiTaskStore();
  const { models, providers, prompts, activeModelId, activePromptId, setActiveModel, setActivePrompt } = useAiStore();
  const { content } = useEditorStore();
  const { index: loreIndex } = useLoreStore();
  const activeFilePath = useProjectStore((s) => s.activeFilePath);
  const projectPath = useProjectStore((s) => s.projectPath);

  // Story memory follows the active document; staleness re-checks are hashed
  // over the whole doc, so debounce them behind typing.
  useEffect(() => {
    void useMemoryStore.getState().loadForActiveFile();
  }, [activeFilePath]);
  useEffect(() => {
    const id = setTimeout(() => useMemoryStore.getState().refreshFreshness(), 800);
    return () => clearTimeout(id);
  }, [content]);

  const [selectedTask, setSelectedTask] = useState<TaskKind | null>(null);
  const [continueLength, setContinueLength] = useState(500);
  const [contextChars, setContextChars] = useState(1000);

  // Lore picker state — initialized from persisted pins, reloaded on project switch.
  const [selectedLorePaths, setSelectedLorePaths] = useState<string[]>(() =>
    loadPinnedLore(useProjectStore.getState().projectPath)
  );
  const [loreSearch, setLoreSearch] = useState("");

  useEffect(() => {
    setSelectedLorePaths(loadPinnedLore(projectPath));
  }, [projectPath]);

  // Outline + extra knowledge state (continue)
  const [outline, setOutline] = useState("");
  const [additionalKnowledge, setAdditionalKnowledge] = useState("");

  // Extra requirement for polish / rewrite / summary
  const [requirement, setRequirement] = useState("");

  const [customInstr, setCustomInstr] = useState("");
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  // The floating toolbar opens the panel pre-selecting a task; consume + clear it.
  useEffect(() => {
    if (requestedTask) {
      setSelectedTask(requestedTask);
      clearOutput();
      setRequestedTask(null);
    }
  }, [requestedTask, setRequestedTask, clearOutput]);

  const activeModel = models.find((m) => m.id === activeModelId);
  const activeProvider = activeModel ? providers.find((p) => p.id === activeModel.providerId) : null;
  const hasConfig = !!activeModel;

  // Polish/rewrite edit a passage in place, so their result belongs *where the
  // selection was* — appending it to the end of the document (the only thing
  // this panel used to do) silently duplicated the passage instead. Resolved at
  // apply time, not run time: the author may have kept typing while it streamed.
  const replaceRange = (() => {
    if (selectedTask !== "polish" && selectedTask !== "rewrite") return null;
    if (!selection) return null;
    if (selectionRange && content.slice(selectionRange.from, selectionRange.to) === selection) {
      return selectionRange;
    }
    // Offsets went stale (edits above it, or a preview-mode selection with no
    // range at all) — fall back to a verbatim search. Two guards, because unlike
    // every other selection lookup in the app this one *overwrites* prose:
    //   • only an exact match counts. rag.ts's locateSelectionOffset has a
    //     normalized fallback, but the span it reports isn't `selection.length`
    //     long, so it can't be turned into a replace range;
    //   • the match must be unique. Repeated lines are ordinary in a draft, and
    //     silently rewriting the *last* one would destroy a passage the author
    //     never selected. Ambiguous → fall through to append, which is lossless.
    const first = content.indexOf(selection);
    if (first < 0 || first !== content.lastIndexOf(selection)) return null;
    return { from: first, to: first + selection.length };
  })();

  const handleApply = () => {
    const { setContent } = useEditorStore.getState();
    if (replaceRange) {
      setContent(content.slice(0, replaceRange.from) + output + content.slice(replaceRange.to));
    } else {
      setContent(content + "\n\n" + output);
    }
    clearOutput();
  };

  const supportsExtras =
    selectedTask === "polish" || selectedTask === "rewrite" || selectedTask === "summary";

  const handleRun = () => {
    if (!selectedTask) return;
    clearOutput();
    const manualLorePaths = selectedLorePaths.length > 0 ? selectedLorePaths : undefined;
    let extras: TaskExtras | undefined;
    if (selectedTask === "continue") {
      extras = {
        manualLorePaths,
        outline: outline.trim() || undefined,
        additionalKnowledge: additionalKnowledge.trim() || undefined,
      };
    } else if (supportsExtras) {
      extras = {
        manualLorePaths,
        requirement: requirement.trim() || undefined,
        contextChars,
      };
    }
    runTask(
      selectedTask,
      selectedTask === "custom" ? customInstr : undefined,
      selectedTask === "continue" ? continueLength : undefined,
      extras,
    );
  };

  // Polish / rewrite / summary operate on the selected text — require one.
  const needsSelection = supportsExtras && !selection;
  const canRun =
    !!selectedTask && !isRunning && !needsSelection &&
    (selectedTask !== "custom" || !!customInstr.trim());

  // Flatten lore index to searchable list
  const isZh = i18n.language.startsWith("zh");
  const allLoreEntities = LORE_CATEGORIES.flatMap((cat) =>
    (loreIndex[cat.id] ?? []).map((entity) => ({
      ...entity,
      categoryLabel: isZh ? cat.labelZh : cat.labelEn,
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

  // Results pane shows something whenever a run is in flight or has produced output.
  const hasResults = isRunning || !!output || !!error || agentLog.length > 0 || !!usage;

  return (
    <div className={styles.panel}>
      {/* ══════════ Config column ══════════ */}
      <div className={styles.configCol}>
        <div className={styles.configScroll}>
          {/* Model selector */}
          <div className={styles.configRow}>
            <select
              className={styles.select}
              value={activeModelId ?? ""}
              onChange={(e) => setActiveModel(e.target.value)}
            >
              <option value="">{t("ai.panel.selectModel")}</option>
              {models.map((m) => {
                const pname = providers.find((p) => p.id === m.providerId)?.name ?? "";
                return (
                  <option key={m.id} value={m.id}>
                    {pname} / {m.name}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Prompt selector */}
          {prompts.length > 0 && (
            <div className={styles.configRow}>
              <select
                className={styles.select}
                value={activePromptId ?? ""}
                onChange={(e) => setActivePrompt(e.target.value)}
              >
                <option value="">{t("ai.panel.defaultSystemPrompt")}</option>
                {prompts
                  .filter((p) => p.scene === "system")
                  .map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
              </select>
            </div>
          )}

          {!hasConfig ? (
            <div className={styles.emptyHint}>{t("ai.panel.noProvider")}</div>
          ) : (
            <>
              {/* Selected text — the edit target, shown explicitly. Hidden for
                  continue, which appends after the cursor rather than editing a
                  selection, so there is no "selected content" to act on. */}
              {selection && selectedTask !== "continue" && (
                <div className={styles.selectionCard}>
                  <div className={styles.selectionCardHead}>
                    <span className={styles.selectionCardLabel}>{t("ai.panel.selectedContent")}</span>
                    <span className={styles.selectionCardCount}>
                      {t("ai.panel.selectedChars", { count: selection.length })}
                    </span>
                  </div>
                  <div className={styles.selectionCardBody}>{selection}</div>
                </div>
              )}

              {/* Task selector — compact pill row */}
              <div className={styles.taskGrid}>
                {TASK_OPTIONS.map((opt) => (
                  <button
                    key={opt.kind}
                    className={`${styles.taskOption} ${selectedTask === opt.kind ? styles.taskOptionActive : ""}`}
                    onClick={() => setSelectedTask(opt.kind)}
                    disabled={isRunning}
                    title={t(opt.descKey)}
                  >
                    {t(opt.labelKey)}
                  </button>
                ))}
                <button
                  className={`${styles.taskOptionFull} ${selectedTask === "custom" ? styles.taskOptionActive : ""}`}
                  onClick={() => setSelectedTask("custom")}
                  disabled={isRunning}
                >
                  {t("ai.tasks.custom")}
                </button>
              </div>

              {/* Config panel — appears when a task is selected */}
              {selectedTask && (
                <div className={styles.configPanel}>

                  {/* Story memory status + checkpoint prompt */}
                  <MemorySection
                    detailSpan={supportsExtras ? contextChars : DEFAULT_DETAIL_SPAN}
                    appendMode={selectedTask === "continue"}
                  />

                  {/* Task-specific config — crossfades when the instruction changes.
                      NOTE: keying on `selectedTask` unmounts the outgoing block, so
                      anything in here must keep its state in AiPanel or a store —
                      a local useState inside these branches would be wiped on every
                      task switch. */}
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={selectedTask}
                      variants={panelFade}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      transition={springPanel}
                    >
                  {/* ── Continue options ── */}
                  {selectedTask === "continue" && (
                    <>
                      {/* Length picker */}
                      <div className={styles.continueLengthRow}>
                        <span className={styles.continueLengthLabel}>{t("ai.panel.continueLength")}</span>
                        <div className={styles.continueLengthOptions}>
                          {CONTINUE_LENGTH_OPTIONS.map((len) => (
                            <button
                              key={len}
                              className={`${styles.lengthChip} ${continueLength === len ? styles.lengthChipActive : ""}`}
                              onClick={() => setContinueLength(len)}
                            >
                              {len >= 1000 ? `${len / 1000}k` : len}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Lore picker */}
                      <ExtraSection
                        label={t("ai.panel.continueLorePicker")}
                        badge={pinnedCount > 0 ? String(pinnedCount) : undefined}
                      >
                        <LorePicker
                          entities={filteredLoreEntities}
                          search={loreSearch}
                          setSearch={setLoreSearch}
                          selectedPaths={selectedLorePaths}
                          toggle={toggleLorePath}
                        />
                      </ExtraSection>

                      {/* Outline */}
                      <ExtraSection
                        label={t("ai.panel.continueOutline")}
                        badge={outline.trim() ? "✓" : undefined}
                      >
                        <textarea
                          className={styles.extraTextarea}
                          rows={4}
                          placeholder={t("ai.panel.continueOutlinePlaceholder")}
                          value={outline}
                          onChange={(e) => setOutline(e.target.value)}
                        />
                      </ExtraSection>

                      {/* Additional knowledge */}
                      <ExtraSection
                        label={t("ai.panel.continueExtraKnowledge")}
                        badge={additionalKnowledge.trim() ? "✓" : undefined}
                      >
                        <textarea
                          className={styles.extraTextarea}
                          rows={4}
                          placeholder={t("ai.panel.continueExtraKnowledgePlaceholder")}
                          value={additionalKnowledge}
                          onChange={(e) => setAdditionalKnowledge(e.target.value)}
                        />
                      </ExtraSection>
                    </>
                  )}

                  {/* ── Polish / Rewrite / Summary options ── */}
                  {supportsExtras && (
                    <>
                      {needsSelection && (
                        <div className={styles.selectHint}>{t("ai.panel.selectFirstHint")}</div>
                      )}

                      {/* Reference-context range (text before the selection) */}
                      <div className={styles.continueLengthRow}>
                        <span className={styles.continueLengthLabel}>{t("ai.panel.contextRange")}</span>
                        <div className={styles.continueLengthOptions}>
                          {CONTEXT_CHARS_OPTIONS.map((n) => (
                            <button
                              key={n}
                              className={`${styles.lengthChip} ${contextChars === n ? styles.lengthChipActive : ""}`}
                              onClick={() => setContextChars(n)}
                              title={t("ai.panel.contextRangeHint")}
                            >
                              {n === 0 ? t("ai.panel.contextRangeNone") : n >= 1000 ? `${n / 1000}k` : n}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Extra requirement */}
                      <ExtraSection
                        label={t("ai.panel.taskRequirement")}
                        badge={requirement.trim() ? "✓" : undefined}
                      >
                        <textarea
                          className={styles.extraTextarea}
                          rows={3}
                          placeholder={t("ai.panel.taskRequirementPlaceholder")}
                          value={requirement}
                          onChange={(e) => setRequirement(e.target.value)}
                        />
                      </ExtraSection>

                      {/* Lore reference */}
                      <ExtraSection
                        label={t("ai.panel.continueLorePicker")}
                        badge={pinnedCount > 0 ? String(pinnedCount) : undefined}
                      >
                        <LorePicker
                          entities={filteredLoreEntities}
                          search={loreSearch}
                          setSearch={setLoreSearch}
                          selectedPaths={selectedLorePaths}
                          toggle={toggleLorePath}
                        />
                      </ExtraSection>
                    </>
                  )}

                  {/* ── Custom instruction textarea ── */}
                  {selectedTask === "custom" && (
                    <textarea
                      className={styles.textarea}
                      rows={3}
                      placeholder={t("ai.panel.customInstruction")}
                      value={customInstr}
                      onChange={(e) => setCustomInstr(e.target.value)}
                    />
                  )}
                    </motion.div>
                  </AnimatePresence>
                </div>
              )}
            </>
          )}
        </div>

        {/* Sticky action footer — Run / Stop always reachable without scrolling */}
        {hasConfig && selectedTask && (
          <div className={styles.configFooter}>
            {isRunning ? (
              <button className={styles.abortBtn} onClick={abort}>
                <Square size={11} fill="currentColor" />
                {t("ai.panel.stop")}
              </button>
            ) : (
              <button className={styles.runBtn} disabled={!canRun} onClick={handleRun}>
                <Play size={12} fill="currentColor" />
                {t("ai.panel.run")}
              </button>
            )}
          </div>
        )}
      </div>

      {/* ══════════ Results column ══════════ */}
      <div className={styles.resultCol}>
        <div className={styles.resultScroll}>
          {!hasResults ? (
            <div className={styles.resultEmpty}>
              <Sparkles size={22} strokeWidth={1.4} />
              <span>{t("ai.panel.resultsPlaceholder")}</span>
            </div>
          ) : (
            <>
              {/* Injection transparency: what lore went into this run and why */}
              {loreReport && <LoreReportSection report={loreReport} />}

              {/* Execution log: run lifecycle, rounds, tool calls */}
              {agentLog.length > 0 && (
                <AgentLog log={agentLog} isRunning={isRunning} />
              )}

              {/* Waiting for the first token */}
              {isRunning && !output && !agentLog.some((e) => e.kind === "tool-step") && (
                <div className={styles.thinking}>
                  <span className={styles.agentSpinner} />
                  {t("ai.panel.thinking")}
                </div>
              )}

              {/* Error */}
              {error && <div className={styles.error}>{error}</div>}

              {/* Output */}
              {output && (
                <div className={styles.outputSection}>
                  <div className={styles.outputHeader}>
                    <span className={styles.outputLabel}>{t("ai.panel.generatedOutput")}</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className={styles.btnSecondary} onClick={clearOutput}>{t("ai.panel.clear")}</button>
                      <button className={styles.btnPrimary} onClick={handleApply}>
                        {replaceRange
                          ? t("ai.panel.replaceSelection", { defaultValue: "替换选中内容" })
                          : t("ai.panel.insertToDoc")}
                      </button>
                    </div>
                  </div>
                  <div className={styles.output} ref={outputRef}>
                    {output}
                    {isRunning && <span className={styles.cursor}>▌</span>}
                  </div>
                </div>
              )}

              {/* Token usage */}
              {usage && (
                <div className={styles.usageBar}>
                  <span>{t("ai.panel.inputTokens", { tokens: usage.inputTokens.toLocaleString() })}</span>
                  <span>{t("ai.panel.outputTokens", { tokens: usage.outputTokens.toLocaleString() })}</span>
                  <span>≈ ${usage.cost.toFixed(5)}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Active model info */}
        {activeModel && activeProvider && (
          <div className={styles.modelInfo}>
            {activeProvider.name} · {activeModel.name}
          </div>
        )}
      </div>
    </div>
  );
}
