import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Check, X, Square, Play } from "lucide-react";
import { useAiTaskStore, type TaskKind, type ToolStep } from "../../stores/aiTaskStore";
import { useAiStore } from "../../stores/aiStore";
import { useEditorStore } from "../../stores/editorStore";
import { useLoreStore } from "../../stores/loreStore";
import type { TaskExtras } from "../../lib/rag";
import { LORE_CATEGORIES } from "../../lib/lore";
import styles from "./AiPanel.module.css";

const TASK_OPTIONS: { kind: TaskKind; labelKey: string; descKey: string }[] = [
  { kind: "continue", labelKey: "ai.tasks.continue", descKey: "ai.tasks.continueDesc" },
  { kind: "polish",   labelKey: "ai.tasks.polish",   descKey: "ai.tasks.polishDesc" },
  { kind: "rewrite",  labelKey: "ai.tasks.rewrite",  descKey: "ai.tasks.rewriteDesc" },
  { kind: "summary",  labelKey: "ai.tasks.summary",  descKey: "ai.tasks.summaryDesc" },
];

const CONTINUE_LENGTH_OPTIONS = [200, 500, 1000, 2000];

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

/** Reusable lore reference picker (search + checkbox list). */
function LorePicker({
  entities,
  search,
  setSearch,
  selectedPaths,
  toggle,
}: {
  entities: { dirPath: string; name: string; categoryLabel: string }[];
  search: string;
  setSearch: (v: string) => void;
  selectedPaths: string[];
  toggle: (dirPath: string) => void;
}) {
  const { t } = useTranslation();
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
          entities.map((entity) => (
            <label key={entity.dirPath} className={styles.lorePickerItem}>
              <input
                type="checkbox"
                checked={selectedPaths.includes(entity.dirPath)}
                onChange={() => toggle(entity.dirPath)}
              />
              <span className={styles.lorePickerName}>{entity.name}</span>
              <span className={styles.lorePickerCat}>{entity.categoryLabel}</span>
            </label>
          ))
        )}
      </div>
    </>
  );
}

export function AiPanel() {
  const { t, i18n } = useTranslation();
  const {
    isRunning, output, error, usage, toolSteps,
    runTask, abort, clearOutput, selection, setSelection,
  } = useAiTaskStore();
  const { models, providers, prompts, activeModelId, activePromptId, setActiveModel, setActivePrompt } = useAiStore();
  const { content } = useEditorStore();
  const { index: loreIndex } = useLoreStore();

  const [selectedTask, setSelectedTask] = useState<TaskKind | null>(null);
  const [continueLength, setContinueLength] = useState(500);

  // Lore picker state
  const [selectedLorePaths, setSelectedLorePaths] = useState<string[]>([]);
  const [loreSearch, setLoreSearch] = useState("");

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

  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection()?.toString() ?? "";
      if (sel) setSelection(sel);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [setSelection]);

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
      };
    }
    runTask(
      selectedTask,
      selectedTask === "custom" ? customInstr : undefined,
      selectedTask === "continue" ? continueLength : undefined,
      extras,
    );
  };

  const canRun = !!selectedTask && !isRunning && (selectedTask !== "custom" || !!customInstr.trim());

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
    setSelectedLorePaths((prev) =>
      prev.includes(dirPath) ? prev.filter((p) => p !== dirPath) : [...prev, dirPath]
    );
  };

  return (
    <div className={styles.panel}>
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
          {/* Selection indicator */}
          {selection && (
            <div className={styles.selectionBadge}>
              {t("ai.panel.selectedChars", { count: selection.length })}
            </div>
          )}

          {/* Task selection grid */}
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
                    badge={selectedLorePaths.length > 0 ? String(selectedLorePaths.length) : undefined}
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
                    badge={selectedLorePaths.length > 0 ? String(selectedLorePaths.length) : undefined}
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

              {/* Execute button */}
              <button
                className={styles.runBtn}
                disabled={!canRun}
                onClick={handleRun}
              >
                <Play size={12} fill="currentColor" />
                {t("ai.panel.run")}
              </button>
            </div>
          )}

          {/* Abort button */}
          {isRunning && (
            <button className={styles.abortBtn} onClick={abort}>
              <Square size={11} fill="currentColor" />
              {t("ai.panel.stop")}
            </button>
          )}

          {/* Agent steps (agentic "continue" runs) */}
          {toolSteps.length > 0 && (
            <AgentStepsSection steps={toolSteps} isRunning={isRunning} />
          )}

          {/* Error */}
          {error && (
            <div className={styles.error}>{error}</div>
          )}

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
              <span>{t("ai.panel.inputTokens", { count: usage.inputTokens.toLocaleString() })}</span>
              <span>{t("ai.panel.outputTokens", { count: usage.outputTokens.toLocaleString() })}</span>
              <span>≈ ${usage.cost.toFixed(5)}</span>
            </div>
          )}
        </>
      )}

      {/* Active model info */}
      {activeModel && activeProvider && (
        <div className={styles.modelInfo}>
          {activeProvider.name} · {activeModel.name}
        </div>
      )}
    </div>
  );
}
