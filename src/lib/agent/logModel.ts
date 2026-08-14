/**
 * The execution log's shape — the event stream folded into the four things a
 * reader actually asks of it.
 *
 * The stream is flat and chronological, which is what it must be on the wire and
 * exactly wrong to read: a twelve-round run with a delegation in it arrives as
 * sixty peer rows, where "what is it doing now", "what did round 3 do" and "how
 * did the search subagent get on" are all the same undifferentiated list. This
 * module answers those separately:
 *
 *   summary + current  — one line: the run's state and its live activity
 *   rounds             — the loop's iterations, each with the events it produced
 *   subagents          — delegations, with the nested log each one carried back
 *
 * Pure and synchronous so it can be tested without a renderer; every display
 * decision (how many rounds to show, what is collapsed) stays in the component.
 * The task plan is deliberately NOT here — it lives on disk, not in the stream
 * (see docs/subagent-lld.md §3.3).
 */

import type { AgentEvent, ToolStep, ToolStepStatus } from "./events";

/** The tool whose steps become subagent cards rather than round rows. */
const DELEGATE_TOOL = "delegate";

export interface RoundGroup {
  round: number;
  maxRounds: number;
  /** The round-start estimate for this round's request. */
  estInputTokens: number;
  at: number;
  /**
   * Everything this round produced, in order — delegate steps included. A
   * delegation happened *in* a round and the group should say so; the renderer
   * skips those rows because they get a section of their own.
   */
  events: AgentEvent[];
}

export interface SubAgentRun {
  /** The delegate call's id — also the `parentStep` its nested events carry. */
  toolCallId: string;
  /** search / vision / longread, or null when truncated arguments hid it. */
  kind: string | null;
  /** The delegated instruction, best effort — empty when it didn't survive. */
  task: string;
  status: ToolStepStatus;
  /** Which round of the parent loop delegated this. */
  round: number;
  at: number;
  step: ToolStep;
  /** The subagent's own execution log, forwarded with `parentStep` set. */
  events: AgentEvent[];
}

export interface LogSummary {
  state: "running" | "done" | "error" | "idle";
  /** Rounds started (not the cap) — 0 for a non-agentic single-shot run. */
  rounds: number;
  maxRounds: number;
  /** Top-level tool calls, delegations included. */
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
  /** Set when the run ended in `run-error`. */
  errorMessage?: string;
}

export interface AgentLogModel {
  /**
   * Events that arrived before the first round — the context the assembler
   * seeded. `run-start` is not among them: the header line says the same thing.
   */
  preamble: AgentEvent[];
  rounds: RoundGroup[];
  subagents: SubAgentRun[];
  summary: LogSummary;
  /**
   * What the run is doing right now, or the last thing it did. Null while a
   * round is in flight with nothing to show for it yet — the header renders
   * that as 思考中, which is the truth.
   */
  current: AgentEvent | null;
  /** The round `current` belongs to, for the header's progress chip. */
  currentRound: { round: number; maxRounds: number } | null;
  /** The run's opening event, when the log has one. */
  start: Extract<AgentEvent, { kind: "run-start" }> | null;
}

/**
 * The subagent kind out of a delegate call's arguments.
 *
 * Read with a regex rather than `JSON.parse` on purpose: the runtime keeps only
 * the first TOOL_ARGS_DETAIL_CHARS of a call's arguments, and `delegate` is the
 * one tool whose `task` argument is a paragraph by design — so its JSON is
 * routinely cut mid-string and does not parse at all. `kind` is a short enum
 * near the front and survives the cut.
 */
export function delegateKind(argumentSummary: string): string | null {
  const m = /"kind"\s*:\s*"([A-Za-z_-]+)"/.exec(argumentSummary);
  return m ? m[1] : null;
}

/** The delegated instruction, by the same tolerance — "" when it was cut away. */
export function delegateTask(argumentSummary: string): string {
  const m = /"task"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(argumentSummary);
  if (!m) return "";
  try {
    // The capture can never end on a lone backslash (the alternation won't
    // match one), so closing the quote always yields parseable JSON.
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

function findLast<T>(items: readonly T[], pred: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (pred(items[i])) return items[i];
  }
  return undefined;
}

/**
 * Fold an event stream into the sections above.
 *
 * `isRunning` is the caller's own liveness (the store's flag), not something the
 * stream can be asked: a run killed by a closed window leaves a log with no
 * terminal event, and reading "no run-done yet" as "still going" would spin a
 * dead turn forever.
 */
export function buildLogModel(log: readonly AgentEvent[], isRunning: boolean): AgentLogModel {
  const top = log.filter((e) => !e.parentStep);
  const preamble: AgentEvent[] = [];
  const rounds: RoundGroup[] = [];
  const subagents: SubAgentRun[] = [];
  const subIndex = new Map<string, SubAgentRun>();

  let start: Extract<AgentEvent, { kind: "run-start" }> | null = null;
  let done: Extract<AgentEvent, { kind: "run-done" }> | null = null;
  let error: Extract<AgentEvent, { kind: "run-error" }> | null = null;
  let toolCount = 0;

  for (const event of top) {
    if (event.kind === "run-start") {
      start = event;
      continue;
    }
    if (event.kind === "run-done") {
      done = event;
      continue;
    }
    if (event.kind === "run-error") {
      error = event;
      continue;
    }
    if (event.kind === "round-start") {
      rounds.push({
        round: event.round,
        maxRounds: event.maxRounds,
        estInputTokens: event.estInputTokens,
        at: event.at,
        events: [],
      });
      continue;
    }

    if (event.kind === "tool-step") {
      toolCount++;
      if (event.step.name === DELEGATE_TOOL) {
        // One card per call: the step is emitted twice (running, then settled)
        // and `appendAgentEventTo` replaces in place, so a well-formed log holds
        // one — but a log stitched from a resumed session need not, and a
        // duplicated card would read as two delegations.
        const existing = subIndex.get(event.step.toolCallId);
        const run: SubAgentRun = {
          toolCallId: event.step.toolCallId,
          kind: delegateKind(event.step.argumentSummary),
          task: delegateTask(event.step.argumentSummary),
          status: event.step.status,
          round: event.step.round,
          at: event.at,
          step: event.step,
          events: log.filter((e) => e.parentStep === event.step.toolCallId),
        };
        if (existing) {
          Object.assign(existing, run);
        } else {
          subIndex.set(run.toolCallId, run);
          subagents.push(run);
        }
      }
    }

    (rounds.length > 0 ? rounds[rounds.length - 1].events : preamble).push(event);
  }

  const last = rounds[rounds.length - 1];
  const state: LogSummary["state"] = error
    ? "error"
    : isRunning
      ? "running"
      : done || rounds.length > 0
        ? "done"
        : "idle";

  return {
    preamble,
    rounds,
    subagents,
    summary: {
      state,
      rounds: rounds.length,
      maxRounds: last?.maxRounds ?? 0,
      toolCount,
      inputTokens: done?.inputTokens ?? 0,
      outputTokens: done?.outputTokens ?? 0,
      errorMessage: error?.message,
    },
    current: pickCurrent({ isRunning, top, preamble, rounds, done, error }),
    currentRound:
      last && isRunning && !done && !error
        ? { round: last.round, maxRounds: last.maxRounds }
        : null,
    start,
  };
}

function pickCurrent({
  isRunning, top, preamble, rounds, done, error,
}: {
  isRunning: boolean;
  top: readonly AgentEvent[];
  preamble: readonly AgentEvent[];
  rounds: readonly RoundGroup[];
  done: AgentEvent | null;
  error: AgentEvent | null;
}): AgentEvent | null {
  // Finished: the outcome is the headline, and a run that ended without one
  // (aborted, window closed) falls back to whatever it last managed to say.
  if (!isRunning) return error ?? done ?? top[top.length - 1] ?? null;

  const events = rounds.length > 0 ? rounds[rounds.length - 1].events : preamble;

  // A tool the loop is blocked on beats anything else in the round: it is
  // literally what the run is doing, and it is what the wait is for.
  const runningTool = findLast(
    events,
    (e) => e.kind === "tool-step" && e.step.status === "running",
  );
  if (runningTool) return runningTool;

  const liveReasoning = findLast(events, (e) => e.kind === "reasoning" && !e.done);
  if (liveReasoning) return liveReasoning;

  // Null rather than a stale row when the round has produced nothing yet — the
  // header says 思考中, which beats showing the previous round's last act as if
  // it were still happening.
  return events[events.length - 1] ?? null;
}

/**
 * The rows a round contributes to the log body.
 *
 * Delegations are dropped: they are rendered as subagent cards, and a row in
 * both places reads as two separate things having happened.
 */
export function roundRows(group: RoundGroup): AgentEvent[] {
  return group.events.filter(
    (e) => !(e.kind === "tool-step" && e.step.name === DELEGATE_TOOL),
  );
}
