import { useState, useRef, useEffect } from "react";
import { useAiTaskStore, type TaskKind } from "../../stores/aiTaskStore";
import { useAiStore } from "../../stores/aiStore";
import { useEditorStore } from "../../stores/editorStore";
import styles from "./AiPanel.module.css";

const TASK_BUTTONS: { kind: TaskKind; label: string; desc: string }[] = [
  { kind: "continue", label: "续写", desc: "从当前位置继续写作" },
  { kind: "polish", label: "润色", desc: "润色选中内容" },
  { kind: "rewrite", label: "重写", desc: "重写选中内容" },
  { kind: "summary", label: "总结", desc: "总结全文或选中段落" },
];

export function AiPanel() {
  const {
    isRunning, output, error, usage,
    runTask, abort, clearOutput, selection, setSelection,
  } = useAiTaskStore();
  const { models, providers, prompts, activeModelId, activePromptId, setActiveModel, setActivePrompt } = useAiStore();
  const { content } = useEditorStore();

  const [customInstr, setCustomInstr] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

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
          <option value="">选择模型…</option>
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
            <option value="">默认系统提示…</option>
            {prompts
              .filter((p) => p.scene === "system")
              .map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
          </select>
        </div>
      )}

      {!hasConfig ? (
        <div className={styles.emptyHint}>请先在 ⚙ AI 配置中添加供应商和模型</div>
      ) : (
        <>
          {/* Selection indicator */}
          {selection && (
            <div className={styles.selectionBadge}>
              已选中 {selection.length} 字
            </div>
          )}

          {/* Task buttons */}
          <div className={styles.taskGrid}>
            {TASK_BUTTONS.map((t) => (
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
                  placeholder="输入自定义指令…"
                  value={customInstr}
                  onChange={(e) => setCustomInstr(e.target.value)}
                />
                <div className={styles.customActions}>
                  <button
                    className={styles.btnSecondary}
                    onClick={() => setShowCustom(false)}
                  >取消</button>
                  <button
                    className={styles.btnPrimary}
                    disabled={!customInstr || isRunning}
                    onClick={() => { clearOutput(); runTask("custom", customInstr); }}
                  >发送</button>
                </div>
              </div>
            ) : (
              <button
                className={styles.customToggle}
                onClick={() => setShowCustom(true)}
              >
                + 自定义指令
              </button>
            )}
          </div>

          {/* Abort button */}
          {isRunning && (
            <button className={styles.abortBtn} onClick={abort}>
              ■ 停止生成
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
                <span className={styles.outputLabel}>生成结果</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className={styles.btnSecondary} onClick={clearOutput}>清除</button>
                  <button className={styles.btnPrimary} onClick={handleInsert}>插入文档</button>
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
              <span>输入 {usage.inputTokens.toLocaleString()} tokens</span>
              <span>输出 {usage.outputTokens.toLocaleString()} tokens</span>
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
