import { useTranslation } from "react-i18next";
import type { ContextBreakdown, ContextSegmentKey } from "../../lib/agent/contextBreakdown";
import styles from "./AgentChat.module.css";

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
}

export const SEGMENT_LABELS: Record<ContextSegmentKey, { key: string; fallback: string }> = {
  system:       { key: "ai.chat.ctxSystem",       fallback: "系统+工具" },
  summary:      { key: "ai.chat.ctxSummary",      fallback: "摘要" },
  seed:         { key: "ai.chat.ctxSeed",         fallback: "种子" },
  injected:     { key: "ai.chat.ctxInjected",     fallback: "注入{{entry}}" },
  conversation: { key: "ai.chat.ctxConversation", fallback: "对话" },
  free:         { key: "ai.chat.ctxFree",         fallback: "空余" },
};

/** Shared budget explanations for the legacy bar and the chat ring. */
export function ContextExplanation({ context }: { context: ContextBreakdown }) {
  const { t } = useTranslation();
  const explained = context.willCompact || context.over || context.stateMode || context.foldDeferred;
  return <>
      {context.raisedFromTokens !== null && (
        <div className={styles.ctxExplain}>
          {t("ai.chat.ctxRaisedExplain", {
            defaultValue:
              "「窗口占用」设的是 {{set}}%，但工具说明占掉了其中大半——为了给对话留出工作空间，本次按 {{now}}% 计。",
            set: Math.round((context.raisedFromTokens * 100) / context.contextSize),
            now: Math.round((context.ceilingTokens * 100) / context.contextSize),
          })}
        </div>
      )}

      {explained && (
        <div className={styles.ctxExplain}>
          {/* Three sentences, not two: past the line with 自动归纳 off is its own
              news — the fold the line used to promise is now the author's to
              press for. */}
          {context.stateMode && !context.over
            ? t("ai.chat.ctxStateExplain", {
                defaultValue:
                  "状态记忆已开启：每次发送前，上一轮之前的对话都折进一份结构化的执行状态（目标 / 决定 / 事实 / 进展 / 文件 / 待决），只有上一轮保留原文——执行日志里能看到每轮的状态。",
              })
            : context.willCompact && !context.autoCompact
            ? t("ai.chat.ctxCompactOffExplain", {
                defaultValue:
                  "自动归纳已关：越过刻线不会再折叠对话，太长时只先裁掉旧的工具结果和图片——要归纳请点「立即归纳」，或到 设置 → 上下文与记忆 打开。",
              })
            : context.willCompact
            ? t("ai.chat.ctxCompactExplain", {
                defaultValue:
                  "达到归纳线后，下一轮把最早的对话归纳成摘要——执行日志里出现「已归纳前 N 轮对话」，摘要段随之变宽。",
              })
            : context.foldDeferred
            ? t("ai.chat.ctxFoldDeferredExplain", {
                defaultValue:
                  "对话已经长到该归纳的程度，但现在归纳帮不上忙——折完仍会高于归纳线，每次发送都归纳只会多花一次请求。先不归纳，等对话接近上限时再折叠。",
              })
            : t("ai.chat.ctxOverExplain", {
                defaultValue:
                  "已经超出这次请求的上限，而归纳帮不上忙——最近两轮对话不会被折叠，工具说明也撤不掉。可以调高「窗口占用」，或开一个新会话。",
              })}
        </div>
      )}
  </>;
}
