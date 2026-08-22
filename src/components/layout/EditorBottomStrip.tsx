import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import { useEditorStore } from "../../stores/editorStore";
import { clearTarget, markTargetEnd, markTargetStart } from "../../lib/editor/aiTarget";
import { MOD_KEY } from "../../lib/platform";
import styles from "./EditorBottomStrip.module.css";

interface Props {
  paragraph?: number;
  sentence?: number;
  refsCount?: number;
}

export function EditorBottomStrip({ paragraph, sentence, refsCount = 0 }: Props) {
  const { t, i18n } = useTranslation();
  const setShowCommandPalette = useAppStore((s) => s.setShowCommandPalette);
  const wordCount = useProjectStore((s) => s.wordCount);
  const editorView = useEditorStore((s) => s.editorView);
  const aiTarget = useEditorStore((s) => s.aiTarget);
  const terms = useTerms();
  const isZh = i18n.language === "zh-CN";

  // Marking is the durable alternative to dragging: the range lives in editor
  // state, survives clicking into the AI panel, and is mapped through edits.
  const marked = aiTarget && aiTarget.to !== null ? aiTarget.to - aiTarget.from : null;
  const pending = !!aiTarget && aiTarget.to === null;

  return (
    <div className={styles.strip}>
      <span className={styles.markGroup}>
        {editorView && (
          <>
            <button
              className={styles.markBtn}
              onClick={() => markTargetStart(editorView)}
              title={t("editorStrip.markStartHint", {
                defaultValue: "在光标处标记 AI 选区的开头（{{mod}}+Shift+[）",
                mod: MOD_KEY,
              })}
            >
              ⟦ {t("editorStrip.markStart", { defaultValue: "标记开头" })}
            </button>
            <button
              className={styles.markBtn}
              onClick={() => markTargetEnd(editorView)}
              title={t("editorStrip.markEndHint", {
                defaultValue: "在光标处标记 AI 选区的结尾（{{mod}}+Shift+]）",
                mod: MOD_KEY,
              })}
            >
              {t("editorStrip.markEnd", { defaultValue: "标记结尾" })} ⟧
            </button>
            {marked !== null && (
              <span className={styles.markState}>
                {t("editorStrip.markCount", { defaultValue: "AI 选区 · 已选 {{chars}} 字", chars: marked })}
              </span>
            )}
            {pending && (
              <span className={`${styles.markState} ${styles.markStatePending}`}>
                {t("editorStrip.markPending", { defaultValue: "待标记结尾" })}
              </span>
            )}
            {aiTarget && (
              <button
                className={styles.markClear}
                onClick={() => clearTarget(editorView)}
                title={t("editorStrip.markClearHint", {
                  defaultValue: "清除 AI 选区（{{mod}}+Shift+\\）",
                  mod: MOD_KEY,
                })}
                aria-label={t("editorStrip.markClear", { defaultValue: "清除" })}
              >
                ×
              </button>
            )}
          </>
        )}
        {paragraph !== undefined && sentence !== undefined
          ? t("editorStrip.paragraph", { p: paragraph, s: sentence })
          : ""}
      </span>
      <span className={styles.right}>
        <span>
          {isZh ? "累计 " : "Total "}
          <span className={styles.value}>{wordCount.toLocaleString()}</span>
          {isZh ? " 字" : " words"}
        </span>
        <span>
          {isZh ? "引用 " : ""}
          <span className={styles.value}>{refsCount}</span>
          {" "}{isZh ? terms.entry : terms.entries}
        </span>
        <span className={styles.summon} onClick={() => setShowCommandPalette(true)}>
          {t("editorStrip.summon", { mod: MOD_KEY })}
        </span>
      </span>
    </div>
  );
}
