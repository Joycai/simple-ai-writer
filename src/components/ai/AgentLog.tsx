/**
 * Execution log — the shared live view of an agent run: lifecycle markers,
 * per-round token estimates, tool calls with status, and the final outcome.
 * Fed by the AgentEvent stream (lib/agent/events). Used by AiPanel for editor
 * tasks, by AgentChat per assistant turn, and by the lore AI modals.
 *
 * Round markers do not get rows of their own — a run alternating
 * round / tool / round / tool reads as twice the activity it is. The round
 * rides on the right of the row it produced, where it answers "how far along"
 * without competing with "what happened".
 *
 * Three presentations, same rows:
 *   boxed (default)  — card with its own collapsible header. Used where the log
 *                      appears without surrounding context (the lore modals).
 *   compact (`compact`) — card with no header; the toggle rides the first row.
 *   flat (`flat`)    — bare rows, for surfaces that already label the section.
 *
 * Rows that stand for a call the author may want to audit — a tool step, a run
 * error — open in place onto the detail the runtime kept (full arguments, the
 * head of the result). The one-line form stays the default: the log is read
 * while a run is live, and a wall of JSON there answers no question.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { findTask, taskLabel } from "../../lib/profile";
import { useTerms } from "../../stores/projectStore";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AgentEvent, ToolStep } from "../../lib/agent/events";
import {
  TOOL_ARGS_DETAIL_CHARS,
  TOOL_RESULT_DETAIL_CHARS,
  formatTokenCount,
  formatToolArgs,
  formatToolArgsDetail,
  formatToolResult,
} from "../../lib/agent/logFormat";
import styles from "./AgentLog.module.css";

function formatLogTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Status marker: a small square whose fill carries the state. */
function Marker({ state }: { state: "pending" | "running" | "done" | "error" }) {
  if (state === "running") return <span className={styles.markerSpinner} />;
  return <span className={`${styles.marker} ${styles[`marker_${state}`]}`} />;
}

/** A log row plus the round it belongs to (folded in from the round marker). */
interface Row {
  event: AgentEvent;
  round?: { round: number; maxRounds: number; estInputTokens: number; at: number };
}

/**
 * Collapse the raw event stream into display rows: round markers are absorbed
 * into the next row rather than occupying one of their own.
 */
function toRows(log: AgentEvent[]): Row[] {
  const rows: Row[] = [];
  let pending: Row["round"];
  for (const event of log) {
    if (event.kind === "round-start") {
      pending = {
        round: event.round,
        maxRounds: event.maxRounds,
        estInputTokens: event.estInputTokens,
        at: event.at,
      };
      continue;
    }
    rows.push({ event, round: pending });
    pending = undefined;
  }
  // A round that hasn't produced a row yet (request in flight) still deserves a
  // line, so the log doesn't look stalled between rounds.
  if (pending) {
    rows.push({ event: { kind: "round-start", ...pending }, round: pending });
  }
  return rows;
}

/**
 * One labelled block of the expanded detail. `cap` is the number of chars the
 * runtime keeps for this field: a body sitting exactly on it was cut, and the
 * block says so rather than passing the slice off as the whole thing.
 */
function DetailBlock({ label, body, cap }: { label: string; body: string; cap?: number }) {
  const { t } = useTranslation();
  return (
    <div className={styles.detailBlock}>
      <div className={styles.detailLabel}>
        {label}
        {cap !== undefined && body.length >= cap && (
          <span className={styles.detailClipped}>
            {t("ai.agent.log.detailClipped", { defaultValue: "已截断" })}
          </span>
        )}
      </div>
      <pre className={styles.detailBody}>{body}</pre>
    </div>
  );
}

/**
 * A row that hides a detail block. The header is a button so the whole line is
 * the hit target and the keyboard reaches it — one row, one disclosure.
 */
function ExpandableRow({ className = "", header, detail }: {
  className?: string;
  header: ReactNode;
  detail: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <li className={styles.rowGroup}>
      <button
        type="button"
        className={`${styles.row} ${styles.rowExpandable} ${className}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={t("ai.agent.log.detailToggle", { defaultValue: "展开详情" })}
      >
        {header}
        <span className={styles.rowChevron}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </button>
      {open && <div className={styles.detail}>{detail}</div>}
    </li>
  );
}

function ToolStepDetail({ step }: { step: ToolStep }) {
  const { t } = useTranslation();
  const args = formatToolArgsDetail(step.argumentSummary);
  return (
    <>
      <DetailBlock
        label={t("ai.agent.log.detailArgs", { defaultValue: "调用参数" })}
        body={args || t("ai.agent.log.detailNoArgs", { defaultValue: "（无参数）" })}
        cap={args ? TOOL_ARGS_DETAIL_CHARS : undefined}
      />
      {step.status !== "running" && (
        <DetailBlock
          label={
            step.status === "error"
              ? t("ai.agent.log.detailError", { defaultValue: "错误" })
              : t("ai.agent.log.detailResult", { defaultValue: "返回结果" })
          }
          body={step.resultSummary || t("ai.agent.log.detailNoResult", { defaultValue: "（无返回内容）" })}
          cap={step.resultSummary ? TOOL_RESULT_DETAIL_CHARS : undefined}
        />
      )}
    </>
  );
}

function ToolStepRow({ step }: { step: ToolStep }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const args = formatToolArgs(step.argumentSummary);
  const result = step.status === "running" ? "" : formatToolResult(step.resultSummary);
  return (
    <>
      <Marker state={step.status === "running" ? "running" : step.status === "done" ? "done" : "error"} />
      <span className={styles.rowName}>
        {t(`ai.agent.tool.${step.name}`, { defaultValue: step.name, doc: terms.doc, entry: terms.entry })}
        {args && <span className={styles.rowArgs} title={step.argumentSummary}> · {args}</span>}
      </span>
      {result && (
        <span className={styles.rowMetaRight} title={step.resultSummary}>{result}</span>
      )}
    </>
  );
}

function AgentLogRow({ row, showTime }: { row: Row; showTime: boolean }) {
  const { t, i18n } = useTranslation();
  const terms = useTerms();
  const isZh = i18n.language.startsWith("zh");
  const { event, round } = row;

  const roundChip = round ? (
    <span
      className={styles.rowRound}
      title={t("ai.agent.log.round", {
        round: round.round,
        max: round.maxRounds,
        tokens: round.estInputTokens.toLocaleString(),
      })}
    >
      {t("ai.agent.log.roundShort", {
        defaultValue: "{{round}}/{{max}} 轮",
        round: round.round,
        max: round.maxRounds,
      })}
    </span>
  ) : null;

  const time = showTime && "at" in event
    ? <span className={styles.rowTime}>{formatLogTime(event.at)}</span>
    : null;

  switch (event.kind) {
    case "run-start":
      return (
        <li className={styles.row}>
          <Marker state="pending" />
          <span className={styles.rowName}>
            {t("ai.agent.log.start", {
              // The active profile's wording for the task; falls back to the
              // raw id, which is what a log line from another profile has.
              task: (() => {
                const def = findTask(event.task);
                return def ? taskLabel(def, isZh, t) : event.task;
              })(),
              model: event.modelName,
            })}
          </span>
          {roundChip}
          {time}
        </li>
      );
    case "round-start":
      // Only reachable for an in-flight round with no row of its own yet.
      return (
        <li className={`${styles.row} ${styles.rowMeta}`}>
          <span className={styles.markerSpinner} />
          <span className={styles.rowMetaText}>{t("ai.agent.log.thinking", { defaultValue: "思考中…" })}</span>
          {roundChip}
        </li>
      );
    case "tool-step":
      return (
        <ExpandableRow
          header={
            <>
              <ToolStepRow step={event.step} />
              {roundChip}
              {time}
            </>
          }
          detail={<ToolStepDetail step={event.step} />}
        />
      );
    case "context-seeded":
      // Two facts, two rows — the manuscript that came along, and what the lore
      // index matched. A miss (0 entities) is reported just as loudly as a hit.
      return (
        <>
          {event.recentChars > 0 && (
            <li className={styles.row}>
              <Marker state="done" />
              <span className={styles.rowName}>
                {t("ai.agent.log.seededContext", { defaultValue: "读取上下文" })}
                {event.documentName && <span className={styles.rowArgs}> · {event.documentName}</span>}
                <span className={styles.rowArgs}>
                  {" · "}
                  {t("ai.agent.log.seededChars", {
                    defaultValue: "{{chars}} 字",
                    chars: event.recentChars.toLocaleString(),
                  })}
                </span>
              </span>
              {event.memoryChars > 0 && (
                <span className={styles.rowMetaRight}>
                  {t("ai.agent.log.seededMemory", {
                    defaultValue: "前情 {{chars}} 字",
                    chars: event.memoryChars.toLocaleString(),
                  })}
                </span>
              )}
              {time}
            </li>
          )}
          <li className={`${styles.row} ${event.loreEntities === 0 ? styles.rowMuted : ""}`}>
            <Marker state="done" />
            <span className={styles.rowName}>
              {t("ai.agent.log.seededLore", { defaultValue: "检索{{entry}}", entry: terms.entry })}
              <span className={styles.rowArgs}>
                {" · "}
                {event.loreEntities > 0
                  ? t("ai.agent.log.seededLoreHits", {
                      defaultValue: "命中 {{n}} 条",
                      n: event.loreEntities,
                    })
                  : t("ai.agent.log.seededLoreNone", { defaultValue: "未命中" })}
              </span>
            </span>
            {event.loreChars > 0 && (
              <span className={styles.rowMetaRight}>
                {t("ai.agent.log.seededChars", {
                  defaultValue: "{{chars}} 字",
                  chars: event.loreChars.toLocaleString(),
                })}
              </span>
            )}
            {roundChip}
          </li>
        </>
      );
    case "round-limit":
      return (
        <li className={`${styles.row} ${styles.rowMeta}`}>
          <span className={styles.rowIndent} />
          <span className={styles.rowMetaText}>
            {event.granted > 0
              ? t("ai.agent.log.roundLimitGranted", {
                  defaultValue: "已达 {{n}} 轮上限 — 批准继续 {{extra}} 轮",
                  n: event.roundsUsed,
                  extra: event.granted,
                })
              : t("ai.agent.log.roundLimitStopped", {
                  defaultValue: "已达 {{n}} 轮上限 — 就此收尾",
                  n: event.roundsUsed,
                })}
          </span>
          {time}
        </li>
      );
    case "context-trimmed":
      return (
        <li className={`${styles.row} ${styles.rowMeta}`}>
          <span className={styles.rowIndent} />
          <span className={styles.rowMetaText}>
            {t("ai.agent.log.trimmed", { count: event.count })}
          </span>
        </li>
      );
    case "context-compacted":
      return (
        <ExpandableRow
          header={
            <>
              <Marker state="done" />
              <span className={styles.rowName}>
                {t("ai.agent.log.compacted", {
                  defaultValue: "已归纳前 {{n}} 轮对话",
                  n: event.foldedTurns,
                })}
              </span>
              <span className={styles.rowMetaRight}>
                {formatTokenCount(event.fromTokens)} → {formatTokenCount(event.toTokens)} tk
              </span>
              {time}
            </>
          }
          detail={
            <DetailBlock
              label={t("ai.agent.log.detailSummary", { defaultValue: "历史摘要" })}
              body={event.summary}
            />
          }
        />
      );
    case "run-done":
      return (
        <li className={styles.row}>
          <Marker state="done" />
          <span className={styles.rowName}>
            {t("ai.agent.log.done", {
              input: event.inputTokens.toLocaleString(),
              output: event.outputTokens.toLocaleString(),
            })}
          </span>
          {time}
        </li>
      );
    case "run-error":
      return (
        <ExpandableRow
          className={styles.rowError}
          header={
            <>
              <Marker state="error" />
              <span className={styles.rowName}>
                {event.message.length > 160 ? event.message.slice(0, 160) + "…" : event.message}
              </span>
              {time}
            </>
          }
          detail={
            <DetailBlock
              label={t("ai.agent.log.detailError", { defaultValue: "错误" })}
              body={event.message}
            />
          }
        />
      );
  }
}

export function AgentLog({
  log, isRunning, flat = false, compact = false,
}: { log: AgentEvent[]; isRunning: boolean; flat?: boolean; compact?: boolean }) {
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

  const rows = toRows(log);
  const toolCount = log.filter((e) => e.kind === "tool-step").length;

  const list = (
    <ul ref={listRef} className={`${styles.list} ${flat ? styles.listFlat : ""}`}>
      {(open ? rows : rows.slice(0, 1)).map((row, i) => (
        <AgentLogRow key={`${i}-${row.event.kind}`} row={row} showTime={!compact} />
      ))}
    </ul>
  );

  if (flat) return list;

  // Compact: no header strip — the collapse toggle sits at the card's top-right,
  // reading as part of the first row rather than as a bar above it.
  if (compact) {
    return (
      <div className={`${styles.box} ${styles.boxCompact}`}>
        <button
          className={styles.compactToggle}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={t("ai.agent.log.title")}
        >
          {isRunning && <span className={styles.boxSpinner} />}
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {list}
      </div>
    );
  }

  return (
    <div className={styles.box}>
      <button className={styles.boxHeader} onClick={() => setOpen((v) => !v)}>
        <span className={styles.boxChevron}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <span className={styles.boxTitle}>{t("ai.agent.log.title")}</span>
        <span className={styles.boxCount}>
          {toolCount > 0 ? t("ai.agent.log.countTools", { count: toolCount }) : log.length}
        </span>
        {isRunning && <span className={styles.boxSpinner} />}
      </button>
      {open && list}
    </div>
  );
}
