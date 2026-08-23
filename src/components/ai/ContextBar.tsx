/**
 * 输入框上方的记忆条：下一次请求的上下文由什么构成，离压缩折叠最早的对话还有
 * 多远。设计稿 02 屏 2c。
 *
 * 从 `AgentChat` 里抽出来给扮演面板共用，**样式仍然借 `AgentChat.module.css`**
 * ——把 `ctx*` 那十几条规则搬家只会给一个正在用的界面凭空加一次回归风险，而
 * 借用同一份 CSS module 在这个仓库里是有先例的（`LoreImproveModal.module.css`
 * 被四个模态借着用）。改 `ctx*` 类名前先看谁在 import 它。
 *
 * 图例默认收起，改用每段的 `title`：六个常驻图例芯片在窄栏里会折成三行，而它
 * 就压在输入框上方——常驻的装饰在这里是每一条消息都要付的代价。
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useTerms } from "../../stores/projectStore";
import {
  CONTEXT_SEGMENT_ORDER,
  type ContextBreakdown,
  type ContextSegmentKey,
} from "../../lib/agent/contextBreakdown";
import styles from "./AgentChat.module.css";

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
}

const SEGMENT_LABELS: Record<ContextSegmentKey, { key: string; fallback: string }> = {
  system:       { key: "ai.chat.ctxSystem",       fallback: "系统+工具" },
  summary:      { key: "ai.chat.ctxSummary",      fallback: "摘要" },
  seed:         { key: "ai.chat.ctxSeed",         fallback: "种子" },
  injected:     { key: "ai.chat.ctxInjected",     fallback: "注入{{entry}}" },
  conversation: { key: "ai.chat.ctxConversation", fallback: "对话" },
  free:         { key: "ai.chat.ctxFree",         fallback: "空余" },
};

/**
 * The composer's memory strip: what the next request's context is made of, and
 * how much room is left before compaction folds the oldest turns away.
 *
 * The legend is collapsed by default and the bar carries per-segment `title`
 * tooltips instead. Six always-on legend chips wrap to three lines in a narrow
 * rail, and this sits directly above the input — permanent chrome there costs
 * message space on every session, whether or not the author is watching memory.
 */
export function ContextBar({ context, onCompact, compacting }: {
  context: ContextBreakdown;
  /**
   * Author-requested compaction ("立即归纳"). Absent = no button — the chat
   * passes its handler only when something is actually foldable; the roleplay
   * panel, whose compaction is not on this store, passes nothing.
   */
  onCompact?: () => void;
  /** True while that request is in flight — the button waits, disabled. */
  compacting?: boolean;
}) {
  const { t } = useTranslation();
  const terms = useTerms();
  const [showLegend, setShowLegend] = useState(false);

  // No declared window means no real ceiling either — inputCeilingFor falls back
  // to an assumed one, and drawing a precise-looking bar against a guess would
  // be the wrong kind of confidence.
  if (context.contextSize <= 0) return null;

  const label = (key: ContextSegmentKey) =>
    t(SEGMENT_LABELS[key].key, { defaultValue: SEGMENT_LABELS[key].fallback, entry: terms.entry });

  return (
    <div className={styles.ctx}>
      <button
        // Warned once past the *mark* the bar itself draws (COMPACT_TRIGGER),
        // not once packed full — a bar standing beyond its own line while
        // looking calm was the state 2c exists to fix.
        className={`${styles.ctxBar} ${context.willCompact ? styles.ctxBarWarn : ""}`}
        onClick={() => setShowLegend((v) => !v)}
        aria-expanded={showLegend}
        title={t("ai.chat.ctxToggle", { defaultValue: "展开/收起上下文构成" })}
      >
        {context.segments.map((seg) =>
          seg.tokens > 0 ? (
            <span
              key={seg.key}
              className={`${styles.ctxSeg} ${styles[`ctxSeg_${seg.key}`]}`}
              style={{ flexGrow: seg.tokens }}
              title={`${label(seg.key)} ≈ ${formatTokens(seg.tokens)} tk`}
            />
          ) : null,
        )}
        {/* Where compaction starts folding the oldest turns — the one threshold
            on this bar the author can actually anticipate. */}
        <span
          className={styles.ctxMark}
          style={{ left: `${context.compactMarkerPct}%` }}
          title={t("ai.chat.ctxCompactAt", { defaultValue: "超过此处将折叠最早的对话" })}
        />
      </button>

      <div className={styles.ctxMeter}>
        <span>
          {t("ai.chat.contextMeter", { defaultValue: "上下文" })}{" "}
          <span className={context.willCompact ? styles.ctxCountWarn : undefined}>
            {formatTokens(context.usedTokens)}
          </span>{" "}
          / {formatTokens(context.ceilingTokens)} tk
        </span>
        <span className={styles.ctxWindow}>
          {t("ai.chat.ctxWindow", {
            defaultValue: "窗口 {{n}}",
            n: formatTokens(context.contextSize),
          })}
        </span>
        {(onCompact || compacting) && (
          <button
            className={styles.ctxCompactBtn}
            onClick={onCompact}
            disabled={compacting || !onCompact}
            title={t("ai.chat.ctxCompactNowTitle", {
              defaultValue: "现在就把较早的对话归纳成摘要，腾出上下文空间",
            })}
          >
            {compacting
              ? t("ai.chat.ctxCompacting", { defaultValue: "归纳中…" })
              : t("ai.chat.ctxCompactNow", { defaultValue: "立即归纳" })}
          </button>
        )}
      </div>

      {showLegend && (
        <div className={styles.ctxLegend}>
          {CONTEXT_SEGMENT_ORDER.map((key) => {
            const seg = context.segments.find((s) => s.key === key);
            if (!seg || seg.tokens <= 0) return null;
            return (
              <span key={key} className={styles.ctxLegendItem}>
                <span className={`${styles.ctxSwatch} ${styles[`ctxSeg_${key}`]}`} />
                {label(key)}
                <span className={styles.ctxLegendValue}>{formatTokens(seg.tokens)}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* What crossing the mark means, said once and only to someone looking:
          the legend is the bar's opened state, and permanent chrome above the
          input costs message space on every session (see the legend note). */}
      {showLegend && context.willCompact && (
        <div className={styles.ctxExplain}>
          {t("ai.chat.ctxCompactExplain", {
            defaultValue:
              "越过竖线后，下一轮把最早的对话归纳成摘要——执行日志里出现「已归纳前 N 轮对话」，摘要段随之变宽。",
          })}
        </div>
      )}
    </div>
  );
}
