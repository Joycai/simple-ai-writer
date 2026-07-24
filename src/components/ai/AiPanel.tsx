import { useState, useRef, useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Check, X, Square, Play, BookMarked, Sparkles, Layers, Pin } from "lucide-react";
import { useAiTaskStore, type TaskKind, type ToolStep } from "../../stores/aiTaskStore";
import { useAiStore } from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
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
 *  (continue/custom) — mirrors rag.ts MAX_CONTEXT_CHARS. */
const DEFAULT_DETAIL_SPAN = 2400;

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

function AgentStepsSection({ steps, isRunning }: { steps: ToolStep[]; isRunning: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);

  return (
    <div className={styles.agentSteps}>
      <button className={styles.agentStepsHeader} onClick={() => setOpen((v) => !v)}>
        <span className={styles.agentStepsChevron}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <span className={styles.agentStepsTitle}>{t("ai.agent.stepsTitle")}</span>
        <span className={styles.agentStepsCount}>({steps.length})</span>
        {isRunning && <span className={styles.agentSpinner} />}
      </button>
      {open && (
        <ul className={styles.agentStepsList}>
          {steps.map((step) => (
            <li key={`${step.toolCallId}-${step.status}`} className={styles.agentStepItem}>
              <span className={`${styles.agentStepIcon} ${step.status === "error" ? styles.agentStepIconError : ""}`}>
                {step.status === "running"
                  ? <span className={styles.agentStepSpinner} />
                  : step.status === "done"
                  ? <Check size={11} />
                  : <X size={11} />}
              </span>
              <span className={styles.agentStepName}>
                {t(`ai.agent.tool.${step.name}`, { defaultValue: step.name })}
              </span>
              {step.argumentSummary && step.argumentSummary !== "{}" && (
                <span className={styles.agentStepArgs}>{step.argumentSummary}</span>
              )}
              {step.resultSummary && step.status !== "running" && (
                <span className={styles.agentStepResult}>{step.resultSummary}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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

/** Lore injection token-budget presets (see loreSelect / appStore). */
const LORE_BUDGET_OPTIONS = [300, 600, 1000, 2000];

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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
              onClick={() => setLoreBudgetTokens(n)}
              title={t("ai.panel.loreBudgetHint", { defaultValue: "【设定资料】最多占用的 token 数" })}
            >
              {n >= 1000 ? `${n / 1000}k` : n}
            </button>
          ))}
        </div>
      </div>
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
    isRunning, output, error, usage, toolSteps, loreReport,
    runTask, abort, clearOutput, selection, requestedTask, setRequestedTask,
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

  const handleInsert = () => {
    const { setContent } = useEditorStore.getState();
    setContent(content + "\n\n" + output);
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
  const hasResults = isRunning || !!output || !!error || toolSteps.length > 0 || !!usage;

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

                  {/* Task-specific config — crossfades when the instruction changes */}
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

              {/* Agent steps (agentic "continue" runs) */}
              {toolSteps.length > 0 && (
                <AgentStepsSection steps={toolSteps} isRunning={isRunning} />
              )}

              {/* Waiting for the first token */}
              {isRunning && !output && toolSteps.length === 0 && (
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
                      <button className={styles.btnPrimary} onClick={handleInsert}>{t("ai.panel.insertToDoc")}</button>
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
