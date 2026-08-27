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

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTerms } from "../../stores/projectStore";
import {
  CONTEXT_SEGMENT_ORDER,
  PREFLIGHT_SEGMENT_ORDER,
  floorMarkPct,
  type ContextBreakdown,
  type ContextSegmentKey,
  type PreflightBreakdown,
  type PreflightSegmentKey,
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

const PREFLIGHT_LABELS: Record<PreflightSegmentKey, { key: string; fallback: string }> = {
  system:  { key: "ai.chat.ctxSystem",   fallback: "系统+工具" },
  bound:   { key: "ai.chat.preBound",    fallback: "绑定块" },
  memory:  { key: "ai.chat.preMemory",   fallback: "记忆块" },
  unknown: { key: "ai.chat.preUnknown",  fallback: "检索 —— 发送后才知道" },
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
/**
 * 预估态：一场对话开始之前。
 *
 * 同一个组件、同样的高度（6px 条 + 一行 11px 读数），只换三样东西——读数的**动词**
 * （Context → 预估 ≥）、右侧轨道的**纹样**（空余 → 未定纹）、以及**撤掉折叠竖线**。
 * 变的只有这三处，而这三处恰好就是「估」和「量」的全部差别，所以作者不需要学第二
 * 套东西。
 *
 * 未定纹用既有 token 里的两档底色斜纹——**未知不该有自己的颜色，它该是纹理**。
 */
function PreflightBar({ pre, resident, unexpanded, stale }: {
  pre: PreflightBreakdown;
  /** 图例里点名「哪些常驻在场」用。 */
  resident: string[];
  unexpanded: number;
  stale: number;
}) {
  const { t } = useTranslation();
  const [showLegend, setShowLegend] = useState(false);
  if (pre.contextSize <= 0) return null;

  const label = (key: PreflightSegmentKey) =>
    t(PREFLIGHT_LABELS[key].key, { defaultValue: PREFLIGHT_LABELS[key].fallback });

  return (
    <div className={styles.ctx}>
      <button
        className={styles.ctxBar}
        onClick={() => setShowLegend((v) => !v)}
        aria-expanded={showLegend}
        title={t("ai.chat.ctxToggle", { defaultValue: "展开/收起上下文构成" })}
      >
        {pre.segments.map((seg) =>
          seg.tokens > 0 ? (
            <span
              key={seg.key}
              className={`${styles.ctxSeg} ${styles[`pre_${seg.key}`]}`}
              style={{ flexGrow: seg.tokens }}
              title={`${label(seg.key)} ≈ ${formatTokens(seg.tokens)} tk`}
            />
          ) : null,
        )}
        {/* 同一道 1px 线，相反的含义：它说「至少到这里」，不说「到这里就要归纳」。 */}
        <span
          className={styles.ctxFloor}
          style={{ left: `${pre.lowerBoundPct}%` }}
          title={t("ai.chat.preFloorTitle", { defaultValue: "下界：至少到这里" })}
        />
      </button>

      <div className={styles.ctxMeter}>
        <span>
          {t("ai.chat.preMeter", { defaultValue: "预估" })}{" "}
          <span className={pre.over ? styles.ctxCountWarn : styles.ctxCountFloor}>
            {`≥ ${formatTokens(pre.lowerBoundTokens)}`}
          </span>{" "}
          / {formatTokens(pre.ceilingTokens)} tk
        </span>
        <span className={styles.ctxWindow}>
          {/* 有失效绑定时右侧让位给它——它比「检索未发生」急。 */}
          {stale > 0
            ? t("ai.chat.preStale", { n: stale, defaultValue: `${stale} 条失效` })
            : t("ai.chat.preNotYet", { defaultValue: "检索未发生" })}
        </span>
      </div>

      {/* 图例是唯一能长高的地方（它本来就要展开），所以「哪些常驻在场」「有没有
          只进了标题的」都放这里，不挤进那一行读数。 */}
      {showLegend && (
        <div className={styles.ctxLegend}>
          {PREFLIGHT_SEGMENT_ORDER.map((key) => {
            const seg = pre.segments.find((s) => s.key === key);
            if (!seg || seg.tokens <= 0) return null;
            return (
              <span key={key} className={styles.ctxLegendItem}>
                <span className={`${styles.ctxSwatch} ${styles[`pre_${key}`]}`} />
                {label(key)}
                {key === "unknown" ? null : (
                  <span className={styles.ctxLegendValue}>{formatTokens(seg.tokens)}</span>
                )}
                {key === "system" && resident.length > 0 && (
                  <span className={styles.ctxLegendNote}>
                    {t("ai.chat.preResident", {
                      name: resident[0],
                      defaultValue: `含 ${resident[0]} 人设`,
                    })}
                  </span>
                )}
                {key === "bound" && unexpanded > 0 && (
                  <span className={styles.ctxLegendWarn}>
                    {t("ai.chat.preUnexpanded", {
                      n: unexpanded, defaultValue: `${unexpanded} 条只进了标题`,
                    })}
                  </span>
                )}
              </span>
            );
          })}
          <span className={styles.ctxLegendItem}>
            <span className={`${styles.ctxSwatch} ${styles.pre_track}`} />
            {t("ai.chat.ctxWindow", {
              defaultValue: "窗口 {{n}}", n: formatTokens(pre.contextSize),
            })}
          </span>
        </div>
      )}
    </div>
  );
}

/** 残影停留多久之后淡出。设计稿 2h ④。 */
const HANDOFF_GHOST_MS = 400;

/**
 * 「预估 → 实测」那一跳的来处。
 *
 * 第一条回复落地的那一刻，这条会**一次跳过去**：读数从一个下界换成一个实测值，
 * 竖线从「至少到这里」换成「到这里就要归纳」，位置还差着一截。不解释的话，那一
 * 跳看起来就像个 bug。
 *
 * 所以把旧的下界留成一道灰残影、右侧读数写一句「刚才预估 ≥ N」，停 400ms 再一起
 * 淡出——**跳变有了来处，就不像 bug 了**。
 *
 * 状态住在组件里而不是调用方：这是一次纯粹的显示层过渡，调用方只是照常把
 * `preflight` 从有变成无，不该为了一道残影多记一样东西。
 */
function useHandoffGhost(pre: PreflightBreakdown | null): number | null {
  const [ghost, setGhost] = useState<number | null>(null);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (pre) {
      last.current = pre.lowerBoundTokens;
      // 还在预估态：如果上一次的残影还挂着（作者退回了新会话），撤掉它。
      setGhost(null);
      return;
    }
    const was = last.current;
    last.current = null;
    if (was === null) return;   // 本来就是实测态，没有可交接的东西
    setGhost(was);
    const id = window.setTimeout(() => setGhost(null), HANDOFF_GHOST_MS);
    return () => window.clearTimeout(id);
  }, [pre]);
  return ghost;
}

export function ContextBar({ context, preflight, onCompact, compacting }: {
  context: ContextBreakdown;
  /**
   * 还没发过第一条时的预估（`lib/roleplay/trace`）。传了就画预估态。
   *
   * 只有扮演面板传它：对话助手没有「发送前就知道会带什么」这份数据。
   */
  preflight?: {
    pre: PreflightBreakdown;
    resident: string[];
    unexpanded: number;
    stale: number;
  } | null;
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
  const ghost = useHandoffGhost(preflight?.pre ?? null);

  // No declared window means no real ceiling either — inputCeilingFor falls back
  // to an assumed one, and drawing a precise-looking bar against a guess would
  // be the wrong kind of confidence.
  if (context.contextSize <= 0) return null;

  if (preflight) {
    return (
      <PreflightBar
        pre={preflight.pre}
        resident={preflight.resident}
        unexpanded={preflight.unexpanded}
        stale={preflight.stale}
      />
    );
  }

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
        {/* 刚才那个下界的残影。它按**这条**的刻度重新定位——两条画在不同的尺上
            （预估铺满上限，实测超出后改按 used 缩放），照搬旧百分比会指向一个
            从来不存在的数。 */}
        {ghost !== null && (
          <span
            className={styles.ctxFloorGhost}
            style={{ left: `${floorMarkPct(context, ghost)}%` }}
            aria-hidden
          />
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
        <span className={ghost !== null ? styles.ctxWasEstimate : styles.ctxWindow}>
          {ghost !== null
            ? t("ai.chat.preWas", {
                n: formatTokens(ghost), defaultValue: `刚才预估 ≥ ${formatTokens(ghost)}`,
              })
            : t("ai.chat.ctxWindow", {
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
