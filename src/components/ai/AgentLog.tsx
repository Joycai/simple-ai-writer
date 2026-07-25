/**
 * Execution log — the shared live view of an agent run: lifecycle markers,
 * per-round token estimates, tool calls with status, and the final outcome.
 * Fed by the AgentEvent stream (lib/agent/events). Used by AiPanel for editor
 * tasks and by the lore AI modals for their tool-using runs.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight, Play, X } from "lucide-react";
import type { AgentEvent, ToolStep } from "../../lib/agent/events";
import styles from "./AgentLog.module.css";

function formatLogTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function ToolStepRow({ step }: { step: ToolStep }) {
  const { t } = useTranslation();
  return (
    <>
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
    </>
  );
}

/** One execution-log entry. Tool steps keep the icon treatment; lifecycle and
 *  round markers render as quieter meta lines so the tool activity stays the
 *  visual focus. */
function AgentLogRow({ event }: { event: AgentEvent }) {
  const { t } = useTranslation();

  switch (event.kind) {
    case "run-start":
      return (
        <li className={styles.agentStepItem}>
          <span className={styles.agentStepIcon}><Play size={11} /></span>
          <span className={styles.agentStepName}>
            {t("ai.agent.log.start", {
              task: t(`ai.tasks.${event.task}`, { defaultValue: event.task }),
              model: event.modelName,
            })}
          </span>
          <span className={styles.agentLogTime}>{formatLogTime(event.at)}</span>
        </li>
      );
    case "round-start":
      return (
        <li className={`${styles.agentStepItem} ${styles.agentLogMeta}`}>
          <span className={styles.agentLogMetaText}>
            {t("ai.agent.log.round", {
              round: event.round,
              max: event.maxRounds,
              tokens: event.estInputTokens.toLocaleString(),
            })}
          </span>
          <span className={styles.agentLogTime}>{formatLogTime(event.at)}</span>
        </li>
      );
    case "tool-step":
      return (
        <li className={styles.agentStepItem}>
          <ToolStepRow step={event.step} />
        </li>
      );
    case "context-trimmed":
      return (
        <li className={`${styles.agentStepItem} ${styles.agentLogMeta}`}>
          <span className={styles.agentLogMetaText}>
            {t("ai.agent.log.trimmed", { count: event.count })}
          </span>
        </li>
      );
    case "run-done":
      return (
        <li className={styles.agentStepItem}>
          <span className={styles.agentStepIcon}><Check size={11} /></span>
          <span className={styles.agentStepName}>
            {t("ai.agent.log.done", {
              input: event.inputTokens.toLocaleString(),
              output: event.outputTokens.toLocaleString(),
            })}
          </span>
          <span className={styles.agentLogTime}>{formatLogTime(event.at)}</span>
        </li>
      );
    case "run-error":
      return (
        <li className={styles.agentStepItem}>
          <span className={`${styles.agentStepIcon} ${styles.agentStepIconError}`}><X size={11} /></span>
          <span className={styles.agentLogError}>
            {event.message.length > 160 ? event.message.slice(0, 160) + "…" : event.message}
          </span>
          <span className={styles.agentLogTime}>{formatLogTime(event.at)}</span>
        </li>
      );
  }
}

export function AgentLog({ log, isRunning }: { log: AgentEvent[]; isRunning: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const listRef = useRef<HTMLUListElement>(null);

  // Follow the newest entry while the run is live; leave scroll alone afterwards
  // so the user can inspect the log without it jumping.
  useEffect(() => {
    if (isRunning && open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [log, isRunning, open]);

  const toolCount = log.filter((e) => e.kind === "tool-step").length;

  return (
    <div className={styles.agentSteps}>
      <button className={styles.agentStepsHeader} onClick={() => setOpen((v) => !v)}>
        <span className={styles.agentStepsChevron}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <span className={styles.agentStepsTitle}>{t("ai.agent.log.title")}</span>
        <span className={styles.agentStepsCount}>
          ({toolCount > 0 ? t("ai.agent.log.countTools", { count: toolCount }) : log.length})
        </span>
        {isRunning && <span className={styles.agentSpinner} />}
      </button>
      {open && (
        <ul ref={listRef} className={styles.agentStepsList}>
          {log.map((event, i) => (
            <AgentLogRow key={`${i}-${event.kind}`} event={event} />
          ))}
        </ul>
      )}
    </div>
  );
}
