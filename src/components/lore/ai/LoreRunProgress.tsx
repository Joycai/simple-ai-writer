/**
 * 知识库 AI 运行的统一进度词汇 (设计稿 03 · 屏 17「AI 执行进度 · 思维链」)。
 *
 * 三个可独立取用的积木，六个 lore AI 流共用：
 *   - RunStatusLine  — 状态行：旋转圈/绿点 + 「生成中/完成」 + `Ns · X tok` 等宽计数
 *   - LoreRunSteps   — 语义步骤列：✓ 圆标 / 脉冲圆 / 灰圆 + 连接线 + 右侧等宽注记
 *   - ThinkingPanel  — 思维链折叠面板：实时流式 · 不入库，运行中默认展开、结束后收起
 *
 * agent 工具流（改写 / 特征助手）仍由 AgentLog 承担步骤+思维链的细粒度展示，
 * 这里只补状态行；单发流（提取 / 拆分 / 主条目补全）用全套。
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentEvent } from "../../../lib/agent/events";
import { formatTokenCount } from "../../../lib/ai/usage";
import { estimateTextTokens } from "../../../lib/ai/tokenEstimate";
import styles from "./LoreRunProgress.module.css";

/** Seconds elapsed since `running` last flipped on; freezes on completion. */
export function useRunClock(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!running) { startRef.current = null; return; }
    startRef.current = Date.now();
    setSeconds(0);
    const tick = setInterval(() => {
      if (startRef.current !== null) {
        setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [running]);
  return seconds;
}

/**
 * Fold an AgentEvent stream into the two numbers and one string this
 * vocabulary displays: accumulated reasoning text and total tokens.
 * Reasoning is per-round; rounds are concatenated in arrival order.
 */
export function useRunTelemetry() {
  const [reasoningByRound, setReasoningByRound] = useState<Map<number, string>>(new Map());
  const [reasoningDone, setReasoningDone] = useState(true);
  const [usageTokens, setUsageTokens] = useState<number | null>(null);

  const reset = () => {
    setReasoningByRound(new Map());
    setReasoningDone(true);
    setUsageTokens(null);
  };

  const onEvent = (e: AgentEvent) => {
    if (e.kind === "reasoning") {
      setReasoningByRound((prev) => {
        const next = new Map(prev);
        next.set(e.round, e.text);
        return next;
      });
      setReasoningDone(e.done);
    } else if (e.kind === "run-done") {
      setUsageTokens(e.inputTokens + e.outputTokens);
      setReasoningDone(true);
    }
  };

  const reasoning = [...reasoningByRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text)
    .join("\n\n");

  return { reasoning, reasoningDone, usageTokens, onEvent, reset };
}

/** `14s · 2.1k tok` — omits whichever half is unknown. */
export function runMeta(elapsedSec: number | null, tokens: number | null): string {
  const parts: string[] = [];
  if (elapsedSec !== null && elapsedSec > 0) parts.push(`${elapsedSec}s`);
  if (tokens !== null && tokens > 0) parts.push(`${formatTokenCount(tokens)} tok`);
  return parts.join(" · ");
}

/** Rough display-only token estimate for flows without a run-done event. */
export function estimateRunTokens(...texts: string[]): number {
  return texts.reduce((sum, t) => sum + estimateTextTokens(t), 0);
}

// ── Status line ──────────────────────────────────────────────────────────────

export function RunStatusLine({ state, label, elapsedSec = null, tokens = null, model, onStop }: {
  state: "running" | "done";
  /** Overrides the default 生成中/完成 text. */
  label?: string;
  elapsedSec?: number | null;
  tokens?: number | null;
  /** 本次任务使用的模型名 — 渲染成小灰签 (设计稿 17 运行头)。 */
  model?: string;
  /** Renders a 停止 button on the right while running. */
  onStop?: () => void;
}) {
  const { t } = useTranslation();
  const meta = runMeta(elapsedSec, tokens);
  return (
    <span className={styles.statusLine}>
      {state === "running"
        ? <span className={styles.spinner} />
        : <span className={styles.doneDot} />}
      <span className={styles.statusText}>
        {label ?? (state === "running"
          ? t("lore.run.generating", { defaultValue: "生成中" })
          : t("lore.run.done", { defaultValue: "完成" }))}
        {meta && ` · ${meta}`}
      </span>
      {model && <span className={styles.modelChip}>{model}</span>}
      {state === "running" && onStop && (
        <button className={styles.stopBtn} onClick={onStop}>
          {t("lore.run.stop", { defaultValue: "停止" })}
        </button>
      )}
    </span>
  );
}

// ── Step list ────────────────────────────────────────────────────────────────

export interface RunStep {
  label: string;
  status: "done" | "active" | "pending";
  /** Right-aligned mono note, e.g. `3,124 字 · 1s`. */
  meta?: string;
}

export function LoreRunSteps({ steps }: { steps: RunStep[] }) {
  const { t } = useTranslation();
  return (
    <div className={styles.steps}>
      {steps.map((s, i) => (
        <div key={i} className={styles.stepBlock}>
          {i > 0 && <div className={styles.stepConnector} />}
          <div className={`${styles.stepRow} ${s.status === "pending" ? styles.stepPending : ""}`}>
            {s.status === "done" && <span className={styles.stepDone}>✓</span>}
            {s.status === "active" && <span className={styles.stepActive} />}
            {s.status === "pending" && <span className={styles.stepWait} />}
            <span className={`${styles.stepLabel} ${s.status === "active" ? styles.stepLabelActive : ""}`}>
              {s.label}
            </span>
            <span className={styles.stepSpacer} />
            <span className={`${styles.stepMeta} ${s.status === "active" ? styles.stepMetaActive : ""}`}>
              {s.status === "active" && !s.meta
                ? `${t("lore.run.inProgress", { defaultValue: "进行中" })}…`
                : s.meta ?? ""}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Thinking chain ───────────────────────────────────────────────────────────

export function ThinkingPanel({ text, running }: { text: string; running: boolean }) {
  const { t } = useTranslation();
  // Open while streaming; collapses when the run finishes unless the author
  // has toggled it by hand (their choice then sticks for this run).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? running;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Follow the stream: keep the newest thought in view.
    if (open && running && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, open, running]);

  if (!text) return null;

  return (
    <div className={styles.thinking}>
      <button className={styles.thinkingHead} onClick={() => setUserOpen(!open)}>
        <svg
          className={`${styles.thinkingChevron} ${open ? styles.thinkingChevronOpen : ""}`}
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5"
        >
          <path d="M9 6 L15 12 L9 18" />
        </svg>
        <span className={styles.thinkingTitle}>
          {t("lore.run.thinking", { defaultValue: "思维链" })}
        </span>
        <span className={styles.thinkingNote}>
          {t("lore.run.thinkingNote", { defaultValue: "实时流式 · 不入库" })}
        </span>
        <span className={styles.stepSpacer} />
        <span className={styles.thinkingToggle}>
          {open
            ? t("lore.run.collapse", { defaultValue: "收起" })
            : t("lore.run.expand", { defaultValue: "展开" })}
        </span>
      </button>
      {open && (
        <div className={styles.thinkingBodyWrap}>
          <div ref={bodyRef} className={styles.thinkingBody}>
            {text}
            {running && <span className={styles.thinkingCursor} />}
          </div>
          <div className={styles.thinkingFade} />
        </div>
      )}
    </div>
  );
}
