import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAiTaskStore, type TaskKind } from "../../stores/aiTaskStore";
import { useAiStore } from "../../stores/aiStore";
import { useEditorStore } from "../../stores/editorStore";
import styles from "./AiPanel.module.css";

const TASK_BUTTONS_CONFIG = [
  { kind: "continue" as TaskKind, labelKey: "ai.tasks.continue", descKey: "ai.tasks.continueDesc" },
  { kind: "polish" as TaskKind, labelKey: "ai.tasks.polish", descKey: "ai.tasks.polishDesc" },
  { kind: "rewrite" as TaskKind, labelKey: "ai.tasks.rewrite", descKey: "ai.tasks.rewriteDesc" },
  { kind: "summary" as TaskKind, labelKey: "ai.tasks.summary", descKey: "ai.tasks.summaryDesc" },
];

export function AiPanel() {
  const { t } = useTranslation();
  const {
    isRunning, output, error, usage,
    runTask, abort, clearOutput, selection, setSelection,
  } = useAiTaskStore();
  const { models, providers, prompts, activeModelId, activePromptId, setActiveModel, setActivePrompt } = useAiStore();
  const { content } = useEditorStore();

  const [customInstr, setCustomInstr] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  const taskButtons = TASK_BUTTONS_CONFIG.map((b) => ({
    ...b,
    label: t(b.labelKey),
    desc: t(b.descKey),
  }));

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  // Sync selection from editor (the editor sets window.getSelection on mouseup)
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
    // Append AI output after current content
    const { setContent } = useEditorStore.getState();
    setContent(content + "\n\n" + output);
    clearOutput();
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

          {/* Task buttons */}
          <div className={styles.taskGrid}>
            {taskButtons.map((t) => (
              <button
                key={t.kind}
                className={styles.taskBtn}
                onClick={() => { clearOutput(); runTask(t.kind); }}
                disabled={isRunning}
                title={t.desc}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Custom instruction */}
          <div className={styles.customRow}>
            {showCustom ? (
              <div className={styles.customForm}>
                <textarea
                  className={styles.textarea}
                  rows={3}
                  placeholder={t("ai.panel.customInstruction")}
                  value={customInstr}
                  onChange={(e) => setCustomInstr(e.target.value)}
                />
                <div className={styles.customActions}>
                  <button
                    className={styles.btnSecondary}
                    onClick={() => setShowCustom(false)}
                  >{t("ai.panel.cancel")}</button>
                  <button
                    className={styles.btnPrimary}
                    disabled={!customInstr || isRunning}
                    onClick={() => { clearOutput(); runTask("custom", customInstr); }}
                  >{t("ai.panel.send")}</button>
                </div>
              </div>
            ) : (
              <button
                className={styles.customToggle}
                onClick={() => setShowCustom(true)}
              >
                + {t("ai.panel.addCustom")}
              </button>
            )}
          </div>

          {/* Abort button */}
          {isRunning && (
            <button className={styles.abortBtn} onClick={abort}>
              {t("ai.panel.stop")}
            </button>
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
