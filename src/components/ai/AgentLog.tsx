/**
 * Execution log — the shared live view of an agent run. Used by AiPanel for
 * editor tasks, by AgentChat per assistant turn, and by the lore AI modals.
 *
 * **Three bands, not one list.** The event stream is flat and chronological,
 * which is right for the wire and wrong for reading: a twelve-round run with a
 * delegation in it arrives as sixty peer rows, and "what is it doing now", "what
 * did round 3 do" and "how did the search subagent get on" are three different
 * questions competing for the same undifferentiated column. So:
 *
 *   ① header — one line: the run's state, its live activity, its progress.
 *      Opens onto the tail of the log, which is the answer to "and now?".
 *   ② rounds — the finished iterations, newest first, as an accordion: one open
 *      at a time, because two expanded rounds are already taller than the panel.
 *   ③ subagents — one card per delegation, carrying the nested log it brought
 *      back. Absent entirely when nothing was delegated. Finished ones stay,
 *      marked done: what the search found is usually why the answer says what
 *      it says.
 *
 * The shape is computed by `lib/agent/logModel` (pure, tested); everything here
 * is presentation. The task plan is a fourth band, owned by the session rather
 * than by one turn, and lives outside this component — it is on disk, not in
 * this stream (docs/subagent-lld.md §3.3).
 *
 * Three presentations, same bands:
 *   boxed (default)   — bordered card. Used where the log appears without
 *                       surrounding context (the lore modals).
 *   compact (`compact`) — the same card without timestamps, for the chat rail.
 *   flat (`flat`)     — no border, for surfaces that already frame the section.
 *
 * Rows that stand for a call the author may want to audit — a tool step, a run
 * error — open in place onto the detail the runtime kept (full arguments, the
 * head of the result). The one-line form stays the default: the log is read
 * while a run is live, and a wall of JSON there answers no question.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { findTask, taskLabel, taskPackLabel } from "../../lib/profile";
import { useTerms } from "../../stores/projectStore";
import { ChevronDown, ChevronRight, Bot, Eye, FileText, Globe, ScrollText } from "lucide-react";
import type { AgentEvent, ToolStep } from "../../lib/agent/events";
import {
  buildLogModel,
  roundRows,
  type AgentLogModel,
  type RoundGroup,
  type SubAgentRun,
} from "../../lib/agent/logModel";
import { estimateTextTokens } from "../../lib/ai/tokenEstimate";
import {
  TOOL_ARGS_DETAIL_CHARS,
  TOOL_RESULT_DETAIL_CHARS,
  formatTokenCount,
  formatToolArgs,
  formatToolArgsDetail,
  formatToolResult,
} from "../../lib/agent/logFormat";
import styles from "./AgentLog.module.css";

/** Rounds shown before the rest fold away — the same window the chat transcript uses. */
const ROUND_WINDOW = 5;

/** How much of the log's tail the header opens onto. */
const TAIL_ROWS = 6;

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
function toRows(log: AgentEvent[], filterTopLevel = true): Row[] {
  const targetLog = filterTopLevel ? log.filter((e) => !e.parentStep) : log;
  const rows: Row[] = [];
  let pending: Row["round"];
  for (const event of targetLog) {
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

/**
 * A round's thinking.
 *
 * Not an `ExpandableRow` because the collapsed state still has to say something:
 * "思考过程 · 2.1s" alone tells the author a thing happened but nothing about
 * what — and the whole reason to surface reasoning is that its *first line* is
 * usually the tell (did it understand the selection? did it find the entry?).
 * So the head of the text rides along, clipped to one line.
 *
 * While it streams the row is open and follows the tail; once the answer starts
 * it collapses back to that one line. Reading thinking is an audit the author
 * does occasionally, not the thing they are waiting for.
 */
function ReasoningRow({ event }: { event: Extract<AgentEvent, { kind: "reasoning" }> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const live = !event.done;
  const body = useRef<HTMLDivElement>(null);

  // Follow the tail while it streams, the same way the transcript does.
  useEffect(() => {
    if (live && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [live, event.text]);

  return (
    <li className={styles.rowGroup}>
      <button
        type="button"
        className={`${styles.row} ${styles.rowExpandable}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={live || open}
        title={t("ai.agent.log.detailToggle", { defaultValue: "展开详情" })}
      >
        <Marker state={live ? "running" : "done"} />
        <span className={styles.rowName}>
          {live
            ? t("ai.agent.log.reasoningLive", { defaultValue: "正在思考" })
            : t("ai.agent.log.reasoning", { defaultValue: "思考过程" })}
        </span>
        <span className={styles.rowMetaRight}>
          {event.elapsedMs !== undefined && `${(event.elapsedMs / 1000).toFixed(1)}s · `}
          {formatTokenCount(estimateTextTokens(event.text))} tk
        </span>
        <span className={styles.rowChevron}>
          {live || open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </button>
      {live || open ? (
        <div ref={body} className={styles.reasoningBody}>{event.text}</div>
      ) : (
        <div className={styles.reasoningPeek}>{event.text}</div>
      )}
    </li>
  );
}

/**
 * A tool call's arguments and result.
 *
 * Nothing nested here: `delegate` is the only tool that carries a log of its
 * own, and it is rendered as a subagent card (band ③) rather than two
 * disclosures deep inside a row — which is where the most expensive part of a
 * run used to hide.
 */
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

function AgentLogRow({ row, showTime, runStatus }: {
  row: Row;
  showTime: boolean;
  /** The enclosing run's terminal status — only a subagent card's nested log
      sees its run-start row, so only SubAgentCard passes this. */
  runStatus?: ToolStep["status"];
}) {
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
          {/* Error stays "done" here: this row states that the run started,
              and the failure is stated once, by the run-error row. */}
          <Marker state={runStatus === undefined || runStatus === "running" ? "pending" : "done"} />
          <span className={styles.rowName}>
            {t("ai.agent.log.start", {
              // The active profile's wording for the task; falls back to the
              // raw id, which is what a log line from another profile has.
              task: (() => {
                const def = findTask(event.task);
                if (!def) return event.task;
                // A secondary pack's task carries its pack, like the menu.
                const pack = taskPackLabel(def, isZh);
                return pack ? `${taskLabel(def, isZh, t)} · ${pack}` : taskLabel(def, isZh, t);
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
    case "round-limit": {
      // Belt to the deserializer's braces (lib/agent/chatSession migrates the
      // pre-1.13 `granted` shape): a log row also arrives straight from a live
      // run, and no single line of history is worth taking the whole drawer
      // down for through the error boundary.
      const decision = event.decision ?? { action: "finish" as const };
      return (
        <li className={`${styles.row} ${styles.rowMeta}`}>
          <span className={styles.rowIndent} />
          <span className={styles.rowMetaText}>
            {decision.action === "extend"
              ? t("ai.agent.log.roundLimitGranted", {
                  defaultValue: "已达 {{n}} 轮上限 — 批准继续 {{extra}} 轮",
                  n: event.roundsUsed,
                  extra: decision.rounds,
                })
              : decision.action === "pause"
                ? t("ai.agent.log.roundLimitPaused", {
                    defaultValue: "已达 {{n}} 轮上限 — 存盘并暂停",
                    n: event.roundsUsed,
                  })
                : t("ai.agent.log.roundLimitStopped", {
                    defaultValue: "已达 {{n}} 轮上限 — 就此收尾",
                    n: event.roundsUsed,
                  })}
          </span>
          {time}
        </li>
      );
    }
    case "turn-resumed":
      // Why one round is taking several requests' worth of time and money.
      return (
        <li className={`${styles.row} ${styles.rowMeta}`}>
          <span className={styles.rowIndent} />
          <span className={styles.rowMetaText}>
            {t(event.final ? "ai.agent.log.turnResumedFinal" : "ai.agent.log.turnResumed", {
              leg: event.leg,
            })}
          </span>
        </li>
      );
    case "output-truncated":
      // Warning-shaped, not error-shaped: the text that did arrive is real and
      // usable, it just isn't all of it.
      return (
        <li className={`${styles.row} ${styles.rowMeta}`}>
          <span className={styles.rowIndent} />
          <span className={styles.rowMetaText}>
            {t("ai.agent.log.outputTruncated", {
              defaultValue: "输出被上限截断，回答未写完",
            })}
            {event.stopReason && ` · ${event.stopReason}`}
          </span>
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
    case "reasoning":
      return <ReasoningRow event={event} />;
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

// ─── ① Header ─────────────────────────────────────────────────────────────────

/**
 * One line for the whole run: state on the left, activity in the middle,
 * progress or cost on the right.
 *
 * The activity is described from the *event* rather than from a status string,
 * so "正在执行" is never all it says — a run blocked on a 40-second file read and
 * one blocked on a web search look identical otherwise, and which one it is
 * decides whether the author waits or intervenes.
 */
function useHeadline(model: AgentLogModel): string {
  const { t, i18n } = useTranslation();
  const terms = useTerms();
  const isZh = i18n.language.startsWith("zh");
  const { current, summary, start } = model;

  if (summary.state === "error") {
    return summary.errorMessage ?? t("ai.agent.log.headError", { defaultValue: "运行出错" });
  }
  if (summary.state === "idle") {
    return start
      ? t("ai.agent.log.start", {
          task: (() => {
            const def = findTask(start.task);
            if (!def) return start.task;
            const pack = taskPackLabel(def, isZh);
            return pack ? `${taskLabel(def, isZh, t)} · ${pack}` : taskLabel(def, isZh, t);
          })(),
          model: start.modelName,
        })
      : t("ai.agent.log.title");
  }
  if (summary.state === "done") {
    // A single-shot task has no loop to report on — "0 轮 · 0 次工具" is an
    // accounting of things that were never going to happen.
    return summary.rounds === 0
      ? t("ai.agent.log.headDoneSimple", { defaultValue: "完成" })
      : t("ai.agent.log.headDone", {
          defaultValue: "完成 · {{rounds}} 轮 · {{tools}} 次工具",
          rounds: summary.rounds,
          tools: summary.toolCount,
        });
  }

  // Running — say what it is doing, not that it is doing something.
  if (!current) return t("ai.agent.log.thinking", { defaultValue: "思考中…" });
  switch (current.kind) {
    case "tool-step": {
      const name = t(`ai.agent.tool.${current.step.name}`, {
        defaultValue: current.step.name,
        doc: terms.doc,
        entry: terms.entry,
      });
      const args = formatToolArgs(current.step.argumentSummary);
      return args ? `${name} · ${args}` : name;
    }
    case "reasoning":
      return current.done
        ? t("ai.agent.log.reasoning", { defaultValue: "思考过程" })
        : t("ai.agent.log.reasoningLive", { defaultValue: "正在思考" });
    case "context-seeded":
      return t("ai.agent.log.seededContext", { defaultValue: "读取上下文" });
    case "context-trimmed":
      return t("ai.agent.log.trimmed", { count: current.count });
    case "context-compacted":
      return t("ai.agent.log.compacted", { defaultValue: "已归纳前 {{n}} 轮对话", n: current.foldedTurns });
    case "turn-resumed":
      return t(current.final ? "ai.agent.log.turnResumedFinal" : "ai.agent.log.turnResumed", {
        leg: current.leg,
      });
    case "output-truncated":
      return t("ai.agent.log.outputTruncated", { defaultValue: "输出被上限截断，回答未写完" });
    default:
      return t("ai.agent.log.thinking", { defaultValue: "思考中…" });
  }
}

// ─── ② Rounds ─────────────────────────────────────────────────────────────────

/**
 * One finished round, collapsed to a line that still carries its content.
 *
 * "第 3 轮" alone is a table of contents entry for a document nobody can see —
 * the author scanning for where a file got read has to open every round to find
 * it. So the collapsed line names the tools the round actually called.
 */
function RoundBlock({
  group, rows, open, onToggle, showTime,
}: {
  group: RoundGroup;
  rows: AgentEvent[];
  open: boolean;
  onToggle: () => void;
  showTime: boolean;
}) {
  const { t } = useTranslation();
  const terms = useTerms();

  const tools = rows
    .filter((e): e is Extract<AgentEvent, { kind: "tool-step" }> => e.kind === "tool-step")
    .map((e) =>
      t(`ai.agent.tool.${e.step.name}`, {
        defaultValue: e.step.name,
        doc: terms.doc,
        entry: terms.entry,
      }),
    );
  const failed = rows.some((e) => e.kind === "tool-step" && e.step.status === "error");
  const gist = tools.length > 0
    ? [...new Set(tools)].join("、")
    : t("ai.agent.log.roundNoTools", { defaultValue: "仅思考" });

  return (
    <li className={styles.rowGroup}>
      <button
        type="button"
        className={`${styles.row} ${styles.rowExpandable} ${styles.roundHead}`}
        onClick={onToggle}
        aria-expanded={open}
      >
        <Marker state={failed ? "error" : "done"} />
        <span className={styles.roundNum}>
          {t("ai.agent.log.roundShort", {
            defaultValue: "{{round}}/{{max}} 轮",
            round: group.round,
            max: group.maxRounds,
          })}
        </span>
        <span className={styles.rowName}>{gist}</span>
        <span className={styles.rowMetaRight}>
          {formatTokenCount(group.estInputTokens)} tk
        </span>
        <span className={styles.rowChevron}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </button>
      {open && (
        <ul className={`${styles.list} ${styles.roundBody}`}>
          {toRows(rows, false).map((row, i) => (
            <AgentLogRow
              key={`${i}-${row.event.kind}`}
              row={row}
              showTime={showTime}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── ③ Subagents ──────────────────────────────────────────────────────────────

const SUB_ICONS: Record<string, typeof Bot> = {
  search: Globe,
  vision: Eye,
  longread: ScrollText,
  pdf: FileText,
};

/**
 * One delegation, with the specialist's own execution log inside it.
 *
 * Until now this lived two disclosures deep — inside the `delegate` row's
 * expanded detail — which is where the most expensive part of a run went to
 * hide. A delegation is the one step whose *internals* the author has a reason
 * to read: it ran on a different model, spent its own budget, and returned a
 * summary that everything after it depends on.
 */
function SubAgentCard({
  run, open, onToggle, showTime,
}: {
  run: SubAgentRun;
  open: boolean;
  onToggle: () => void;
  showTime: boolean;
}) {
  const { t } = useTranslation();
  const Icon = (run.kind && SUB_ICONS[run.kind]) || Bot;
  const kindLabel = run.kind
    ? t(`systemSettings.subagents.${run.kind}`, { defaultValue: run.kind })
    : t("ai.agent.log.subAgent", { defaultValue: "子代理" });

  return (
    <li className={styles.rowGroup}>
      <button
        type="button"
        className={`${styles.row} ${styles.rowExpandable} ${styles.subHead}`}
        onClick={onToggle}
        aria-expanded={open}
      >
        <Marker state={run.status === "running" ? "running" : run.status === "done" ? "done" : "error"} />
        <span className={styles.subIcon}><Icon size={11} /></span>
        <span className={styles.rowName}>
          {kindLabel}
          {run.task && <span className={styles.rowArgs} title={run.task}> · {run.task}</span>}
        </span>
        <span className={styles.rowMetaRight}>
          {run.status === "running"
            ? t("ai.agent.log.subRunning", { defaultValue: "进行中" })
            : run.status === "error"
              ? t("ai.agent.log.subFailed", { defaultValue: "失败" })
              : t("ai.agent.log.subDone", { defaultValue: "已完成" })}
        </span>
        <span className={styles.rowChevron}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </button>
      {open && (
        <div className={styles.subBody}>
          <ul className={styles.list}>
            {toRows(run.events, false).map((row, i) => (
              <AgentLogRow
                key={`${i}-${row.event.kind}`}
                row={row}
                showTime={showTime}
                runStatus={run.status}
              />
            ))}
          </ul>
          {run.status !== "running" && (
            <div className={styles.subResult}>
              <DetailBlock
                label={
                  run.status === "error"
                    ? t("ai.agent.log.detailError", { defaultValue: "错误" })
                    : t("ai.agent.log.detailResult", { defaultValue: "返回结果" })
                }
                body={run.step.resultSummary || t("ai.agent.log.detailNoResult", { defaultValue: "（无返回内容）" })}
                cap={run.step.resultSummary ? TOOL_RESULT_DETAIL_CHARS : undefined}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ─── The card ─────────────────────────────────────────────────────────────────

export function AgentLog({
  log, isRunning, flat = false, compact = false,
}: { log: AgentEvent[]; isRunning: boolean; flat?: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const model = useMemo(() => buildLogModel(log, isRunning), [log, isRunning]);
  const headline = useHeadline(model);
  const showTime = !compact;

  // The header's disclosure follows the run: open while it is live (that is the
  // one time the tail answers a question), shut when it ends. A manual toggle in
  // between sticks until the next transition.
  const [tailOpen, setTailOpen] = useState(isRunning);
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    if (wasRunning.current !== isRunning) {
      wasRunning.current = isRunning;
      setTailOpen(isRunning);
    }
  }, [isRunning]);

  // Accordions: one round and one subagent at a time. Two open rounds already
  // overflow the rail, and the panel scrolling itself away mid-run is worse than
  // having to click twice.
  const [openRound, setOpenRound] = useState<number | null>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [showAllRounds, setShowAllRounds] = useState(false);

  const tailRef = useRef<HTMLUListElement>(null);

  // Rounds are grouped; the seeded-context rows that arrived before round 1 ride
  // with it, because that is the context round 1 opened with.
  const groups = useMemo(
    () =>
      model.rounds.map((group, i) => ({
        group,
        rows: i === 0 ? [...model.preamble, ...roundRows(group)] : roundRows(group),
      })),
    [model],
  );

  // The live round belongs to the header, not to the history below it: "现在"
  // and "刚才" are different questions, and listing the in-flight round in both
  // places is how the old log came to say everything twice.
  const finished = model.currentRound ? groups.slice(0, -1) : groups;
  const hiddenRounds = showAllRounds ? 0 : Math.max(0, finished.length - ROUND_WINDOW);
  const visible = finished.slice(hiddenRounds);

  // While a round is in flight the tail is *that round's* rows and nothing else:
  // spilling into earlier rounds would print them twice, once here and once in
  // band ② below, which is the duplication this layout exists to end. A round
  // that has only just started has nothing of its own yet, so it falls back to
  // the log's last rows rather than making the disclosure blink out of
  // existence between rounds.
  const tailRows = useMemo(() => {
    const live = model.currentRound ? groups[groups.length - 1]?.rows : undefined;
    const all = groups.length > 0 ? groups.flatMap((g) => g.rows) : model.preamble;
    const source = live && live.length > 0 ? live : all;
    return toRows(source.slice(-TAIL_ROWS), false);
  }, [groups, model.preamble, model.currentRound]);

  // Follow the newest entry while the run is live; leave scroll alone afterwards
  // so the user can inspect the log without it jumping.
  useEffect(() => {
    if (isRunning && tailOpen && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
  }, [log, isRunning, tailOpen]);

  // A header with nothing behind it is a control that does nothing when clicked.
  // The lore modals mount the log before their run starts, so this is a state
  // the component reaches on every open, not an edge case.
  const hasTail = tailRows.length > 0;

  const head = (
    <>
      <Marker
          state={
            model.summary.state === "running"
              ? "running"
              : model.summary.state === "error"
                ? "error"
                : model.summary.state === "idle"
                  ? "pending"
                  : "done"
          }
        />
        <span className={styles.headName}>{headline}</span>
        <span className={styles.headMeta}>
          {model.currentRound
            ? t("ai.agent.log.roundShort", {
                defaultValue: "{{round}}/{{max}} 轮",
                round: model.currentRound.round,
                max: model.currentRound.maxRounds,
              })
            : model.summary.outputTokens > 0
              ? `${formatTokenCount(model.summary.inputTokens)} / ${formatTokenCount(model.summary.outputTokens)} tk`
              : null}
        </span>
      {hasTail && (
        <span className={styles.rowChevron}>
          {tailOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      )}
    </>
  );

  const body = (
    <>
      {hasTail ? (
        <button
          type="button"
          className={`${styles.head} ${model.summary.state === "error" ? styles.headError : ""}`}
          onClick={() => setTailOpen((v) => !v)}
          aria-expanded={tailOpen}
          title={t("ai.agent.log.title")}
        >
          {head}
        </button>
      ) : (
        <div className={`${styles.head} ${styles.headStatic} ${model.summary.state === "error" ? styles.headError : ""}`}>
          {head}
        </div>
      )}

      {hasTail && tailOpen && (
        <ul ref={tailRef} className={`${styles.list} ${styles.tail}`}>
          {tailRows.map((row, i) => (
            <AgentLogRow
              key={`${i}-${row.event.kind}`}
              row={row}
              showTime={showTime}
            />
          ))}
        </ul>
      )}

      {visible.length > 0 && (
        <ul className={styles.list}>
          {hiddenRounds > 0 && (
            <li>
              <button className={styles.foldBar} onClick={() => setShowAllRounds(true)}>
                <ChevronRight size={11} />
                {t("ai.agent.log.showEarlierRounds", {
                  defaultValue: "更早的 {{n}} 轮",
                  n: hiddenRounds,
                })}
              </button>
            </li>
          )}
          {visible.map(({ group, rows }) => (
            <RoundBlock
              key={group.round}
              group={group}
              rows={rows}
              open={openRound === group.round}
              onToggle={() => setOpenRound((v) => (v === group.round ? null : group.round))}
              showTime={showTime}
            />
          ))}
        </ul>
      )}

      {/* ③ Only when something was delegated — an empty section here would be a
          permanent reminder of a feature the author may not use. */}
      {model.subagents.length > 0 && (
        <>
          <div className={styles.sectionLabel}>
            {t("ai.agent.log.subAgents", { defaultValue: "子代理" })}
          </div>
          <ul className={styles.list}>
            {model.subagents.map((run) => (
              <SubAgentCard
                key={run.toolCallId}
                run={run}
                open={openSub === run.toolCallId}
                onToggle={() =>
                  setOpenSub((v) => (v === run.toolCallId ? null : run.toolCallId))
                }
                showTime={showTime}
              />
            ))}
          </ul>
        </>
      )}
    </>
  );

  return <div className={flat ? styles.bare : styles.box}>{body}</div>;
}
