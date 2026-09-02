import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/appStore";
import { IMAGE_LONG_EDGE_MAX, IMAGE_LONG_EDGE_MIN } from "../../../lib/image/downscalePlan";
import { Pane, PaneHeader, Section, Row } from "./bits";
import common from "../settingsCommon.module.css";
import styles from "./ContextMemory.module.css";

const EDGE_STEP = 256;

/**
 * 设置 → AI 配置 → 上下文与记忆: what a conversation puts in front of the
 * model, and how much of it.
 *
 * Today that is one section — the picture ceiling. It is named for what it
 * is meant to hold: the other "how much goes into the context" knobs still
 * live where they were first needed (知识库预算 / 利用率 in the AI panel's
 * toolbar, 默认最大输出 at the top of 供应商与模型, the recap model in the
 * library view); the note at the foot of the pane says so. Moving any of
 * them here is a separate decision — see
 * docs/feature/settings-ai-tabs-ui-brief.md §2.3 (设计稿 18 B1 / B2).
 */
export function ContextMemoryPane() {
  const { t } = useTranslation();
  const imageMaxLongEdge = useAppStore((s) => s.imageMaxLongEdge);
  const setImageMaxLongEdge = useAppStore((s) => s.setImageMaxLongEdge);
  const [edgeDraft, setEdgeDraft] = useState(imageMaxLongEdge ? String(imageMaxLongEdge) : "");
  const commitEdge = () => {
    const n = parseInt(edgeDraft, 10);
    const next = Number.isFinite(n) && n > 0
      ? Math.min(Math.max(n, IMAGE_LONG_EDGE_MIN), IMAGE_LONG_EDGE_MAX)
      : 0;
    setImageMaxLongEdge(next);
    setEdgeDraft(next ? String(next) : "");
  };

  return (
    <Pane>
      <PaneHeader
        title={t("systemSettings.tabs.contextMemory")}
        sub={t("systemSettings.contextMemory.paneSub")}
      />

      {/* Downscaling is not a feature to switch on, it is what the app does
          with every picture — this field only moves where the line is. */}
      <Section label={t("systemSettings.contextMemory.imageSection")}>
        <Row
          top
          title={t("systemSettings.contextMemory.imageLongEdgeLabel")}
          desc={t("systemSettings.contextMemory.imageLongEdgeHint")}
          last
        >
          <div className={styles.field}>
            <div className={styles.fieldRow}>
              <input
                className={`${common.input} ${common.rowNumber} ${styles.mono}`}
                type="number"
                min={IMAGE_LONG_EDGE_MIN}
                max={IMAGE_LONG_EDGE_MAX}
                step={EDGE_STEP}
                placeholder={t("systemSettings.contextMemory.imageLongEdgeOff")}
                value={edgeDraft}
                onChange={(e) => setEdgeDraft(e.target.value)}
                // Committed on blur, not per keystroke: clamping as the author
                // types means the first digit of "4096" becomes 256 and the
                // rest has nowhere to go.
                onBlur={commitEdge}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              />
              <span className={styles.unit}>{t("systemSettings.contextMemory.imageUnit")}</span>
            </div>
            <div className={styles.range}>
              {t("systemSettings.contextMemory.imageRange", {
                min: IMAGE_LONG_EDGE_MIN, max: IMAGE_LONG_EDGE_MAX, step: EDGE_STEP,
              })}
            </div>
          </div>
        </Row>
      </Section>

      <div className={styles.elsewhere}>{t("systemSettings.contextMemory.elsewhereNote")}</div>
    </Pane>
  );
}
