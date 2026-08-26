/**
 * Structured events emitted while an AI task runs — the data source for the
 * execution log panel (AiPanel's AgentLogSection).
 *
 * Ownership: the agent runtime (runtime.ts) emits the events only it can see —
 * round starts, tool steps, context trims. The caller that launched the run
 * (stores/aiTaskStore) brackets those with run-start / run-done / run-error,
 * because only it knows the task kind, the display model name, and the final
 * cost. Non-agentic tasks (plain single-shot streaming) emit just the bracket
 * events, so every task shows up in the log, not only tool-using ones.
 *
 * Timestamps are epoch millis; the UI formats them per locale.
 */

import { summarizeSearchResults, type ServerToolEvent } from "../ai/serverTools";
import type { HandoffBrief } from "./handoff";

/**
 * What the author chose when a run hit its round cap.
 *
 * Declared here rather than in runtime.ts, which is where it is acted on: the
 * `round-limit` event carries it, and runtime already imports this module — so
 * the other direction would be a cycle, previously dodged with an inline
 * `import("./runtime")` type. runtime re-exports it for its callers.
 */
export type RoundLimitDecision =
  | { action: "extend"; rounds: number }
  | { action: "finish" }
  | { action: "pause" };

/**
 * What to do after the output cap has cut the model off several times running.
 *
 * The runtime recovers from the first few silently (see runtime's
 * TRUNCATION_RECOVERY_LIMIT) — one truncation is a normal cost of a long
 * answer, and asking about it would be noise. Repeated truncation is different:
 * either the model keeps trying to emit something too big for one reply, or the
 * output cap is set too low, and continuing to retry spends the author's money
 * on rounds that keep getting cut off. So the loop stops and asks.
 */
export type TruncationDecision = { action: "continue" } | { action: "stop" };

export type ToolStepStatus = "running" | "done" | "error";

/** One tool invocation's lifecycle. Emitted twice per call: running, then done/error. */
export interface ToolStep {
  round: number;
  toolCallId: string;
  name: string;
  /** Truncated argument JSON for display */
  argumentSummary: string;
  status: ToolStepStatus;
  /** Head of the result content (TOOL_RESULT_DETAIL_CHARS), set on done/error */
  resultSummary?: string;
  /**
   * Whether `argumentSummary` / `resultSummary` were actually cut, recorded at
   * the slice site — the one place that knows. The UI's 已截断 badge used to
   * guess from `length >= cap`, which mis-fired both ways: pretty-printed args
   * outgrow the cap without losing a character, and an exactly-at-cap result
   * looks cut when it isn't. `undefined` means the event predates the flags
   * (persisted sessions) and the length heuristic is the honest fallback.
   */
  argsTruncated?: boolean;
  resultTruncated?: boolean;
}

/** Scope fields attached to an event. Set only when forwarded from a nested subagent. */
export interface AgentEventScope {
  /** The parent delegate step's toolCallId, if this event occurred inside a subagent run. */
  parentStep?: string;
}

export type AgentEvent = AgentEventScope & (
  | {
      kind: "run-start";
      /** Task kind (continue / polish / …) — translated by the UI when known. */
      task: string;
      /** Display name of the model handling the run. */
      modelName: string;
      /** True when the run goes through the tool loop (vs single-shot streaming). */
      agentic: boolean;
      at: number;
    }
  | {
      kind: "round-start";
      round: number;
      maxRounds: number;
      /** Estimated input tokens for this round's request — messages only. */
      estInputTokens: number;
      /**
       * Tokens this round's tool schemas add on top of `estInputTokens`.
       *
       * Reported separately rather than folded in because it is the one part of
       * the request that no amount of trimming or compaction can shrink — the
       * author reading a log needs to see which half of a large round was the
       * conversation and which half was the fixed cost of having tools at all.
       * 0 on the force-text final round, where the tools are withheld.
       *
       * Optional because chat logs persist across releases (stores/agentStore →
       * sessionDb): every event emitted from 1.22 on carries it, and the ones
       * already on disk never will. Read it as `?? 0`.
       */
      toolTokens?: number;
      at: number;
    }
  | { kind: "tool-step"; step: ToolStep; at: number }
  | {
      /**
       * A deferred tool group entered the toolset mid-run (registry.ToolGroup).
       *
       * Worth a log row rather than happening silently: from this round on the
       * request carries tools the earlier ones did not, and an author reading
       * the log would otherwise see the agent suddenly using a tool that was
       * not on offer a moment ago.
       */
      kind: "tools-loaded";
      group: string;
      names: string[];
      round: number;
      at: number;
    }
  | {
      /**
       * Context the assembler injected *before* the loop started — the RAG
       * layers the model never had to ask for.
       *
       * Emitted by the conversational assistant: once for the first turn's
       * seed, and again on any later turn whose per-turn retrieval found
       * something net-new (lib/context/rag assembleTurnInjection — new lore
       * mentions, or a document switch). Without it the log looks as though
       * the run began knowing nothing, and a lore miss — the single most
       * useful thing to notice — is invisible. The task panel has its own
       * richer 「本次注入设定」 report and does not emit this.
       */
      kind: "context-seeded";
      /** Document the verbatim window was taken from, if one is open. */
      documentName: string | null;
      /** Verbatim manuscript chars injected. */
      recentChars: number;
      /** Story-memory recap chars; 0 when the document has no memory. */
      memoryChars: number;
      /** Lore entities activated, and the chars they occupied. */
      loreEntities: number;
      loreChars: number;
      at: number;
    }
  | {
      /** Older tool results were elided to stay inside the input ceiling. */
      kind: "context-trimmed";
      count: number;
      at: number;
    }
  | {
      /**
       * The oldest turns were folded into the rolling summary between turns
       * (lib/agent/compactRun). Distinct from context-trimmed: trimming blanks
       * individual tool results mid-run as a backstop; compaction replaces
       * whole turns with prose the model can still use.
       */
      kind: "context-compacted";
      foldedTurns: number;
      /** Estimated history tokens before / after the fold. */
      fromTokens: number;
      toTokens: number;
      /** The new rolling summary — shown by the log row's expanded detail. */
      summary: string;
      at: number;
    }
  | {
      /**
       * The round cap was reached with the model still calling tools, and the
       * author was asked whether to keep going. `decision` describes the choice:
       * extend (extra rounds), finish (wrap up now), or pause (save and stop).
       */
      kind: "round-limit";
      roundsUsed: number;
      decision: RoundLimitDecision;
      at: number;
    }
  | {
      /**
       * What the model thought before answering this round.
       *
       * One event per round, re-emitted as the text grows (see
       * `appendAgentEventTo`) — thinking streams, and a log line per fragment
       * would be unreadable. `done` flips when the round's answer starts, which
       * is what lets the UI stop showing it as in-progress.
       *
       * Only endpoints that expose reasoning produce these at all; for every
       * other model the log looks exactly as it did before.
       */
      kind: "reasoning";
      round: number;
      text: string;
      /** False while fragments are still arriving for this round. */
      done: boolean;
      /** Wall-clock ms from the round's first fragment to `done`. */
      elapsedMs?: number;
      at: number;
    }
  | {
      /**
       * The endpoint stopped mid-turn and the adapter handed the turn back so
       * the model could keep going (`lib/ai/anthropic.ts`).
       *
       * One round of the loop, several requests to the endpoint — which is
       * otherwise invisible, and shows up only as a round that takes a minute
       * and costs several times what its round-start estimate said. `final`
       * marks the last leg the turn is allowed, which is when a run that keeps
       * announcing instead of answering gets cut off.
       */
      kind: "turn-resumed";
      round: number;
      leg: number;
      final: boolean;
      at: number;
    }
  | {
      /**
       * The endpoint cut this round's output short instead of letting the model
       * finish — `max_tokens` reached.
       *
       * Streamed tasks have shown this on the draft since drafts existed; the
       * tool loop dropped it on the floor, so an agent or chat answer that got
       * truncated looked exactly like one the model chose to end. That is the
       * single most misleading thing this log can omit: the visible symptom is
       * an answer that stops mid-thought with nothing to say why.
       */
      kind: "output-truncated";
      round: number;
      /** The endpoint's own stop reason, when it named one. */
      stopReason?: string;
      /**
       * What the runtime did about it, when it did something.
       *
       * `text` — the answer was cut mid-sentence and the loop asked the model
       * to continue from where it stopped. `tool-args` — a tool call's
       * arguments were cut, so the call was **dropped unexecuted** (half a JSON
       * object cannot be run, and replaying it would corrupt the history) and
       * the model was told to write in smaller pieces.
       *
       * `attempt` counts recoveries in this run, so the log shows a pattern
       * rather than three identical lines. Absent on older events, and on the
       * surfaces that only report truncation without recovering from it.
       */
      recovery?: { kind: "text" | "tool-args"; attempt: number };
      at: number;
    }
  | {
      /**
       * The author was asked whether to keep going after repeated truncation.
       * Distinct from `output-truncated` because the question is the event:
       * the run stopped and waited for a person.
       */
      kind: "truncation-limit";
      recoveries: number;
      decision: TruncationDecision;
      at: number;
    }
  | {
      /**
       * The run handed its ending to the writer subagent (finishPolicy:
       * "handoff"). Its own nested events arrive under `parentStep: step`, so
       * this row is what they hang from — and it is the only place the author
       * can see that the text they are reading was not written by the model
       * named at the top of the log.
       */
      kind: "handoff";
      /** Log-tree id the writer's nested events carry as `parentStep`. */
      step: string;
      /**
       * The whole work order, not a summary of it.
       *
       * The card the author opens renders every section from here, so the brief
       * has to survive a reload — and the summary line above it is derived from
       * the same object rather than stored beside it, because two copies of
       * "how many materials" is how a card comes to disagree with its own
       * heading. It is the one event that carries verbatim prose (the style
       * anchors), which is the point: those are what the author checks when the
       * voice comes back wrong.
       */
      brief: HandoffBrief;
      /**
       * True when the forced tool call did not arrive and the brief was
       * reconstructed from the model's prose (handoff.fallbackBrief).
       *
       * Surfaced rather than swallowed because the cause is invisible from the
       * outside: some endpoints silently downgrade a forced tool_choice to
       * "auto" (lib/ai/openai.ts toolChoiceFor). The handoff still happens —
       * but the author should know the work order was inferred.
       */
      degraded?: true;
      /**
       * Display name of the model that is writing. Absent only when the binding
       * could not be resolved at all — the turn then renders as an app notice
       * rather than as prose, so there is no signature to put a name on.
       */
      model?: string;
      at: number;
    }
  | {
      /** The handoff finished — the writer's own run-done arrives separately. */
      kind: "handoff-done";
      step: string;
      chars: number;
      /** Wall time the writer took, for the signature's hover line. */
      elapsedMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      cost?: number;
      /** Present when `deliverTo` was attempted: did the author approve it? */
      delivered?: { path: string; approved: boolean };
      /** Set when the writer could not run at all; the main model's text stands. */
      error?: string;
      at: number;
    }
  | { kind: "run-done"; inputTokens: number; outputTokens: number; at: number }
  | { kind: "run-error"; message: string; at: number });

/**
 * Turns a stream's server-tool reports into log rows — one row per search,
 * updated in place from running to done.
 *
 * Stateful because the two halves arrive apart: the query comes with the call
 * and the hits come later, while `appendAgentEventTo` replaces a row wholesale
 * by `toolCallId`. Without remembering the query, the finished row would show
 * results with nothing to say what was asked. One factory call per stream keeps
 * that memory scoped to the run that owns it.
 *
 * Everything about these rows is display: nothing here can be executed,
 * retried, or answered — see `lib/ai/serverTools.ts`.
 */
export function createServerToolLog(round: number): (event: ServerToolEvent) => AgentEvent {
  const queries = new Map<string, string>();
  return (event) => {
    if (event.phase === "call") {
      const args = JSON.stringify(event.input ?? {});
      queries.set(event.id, args);
      return {
        kind: "tool-step",
        step: {
          round,
          toolCallId: event.id,
          name: event.name,
          argumentSummary: args,
          status: "running",
          // Server-tool rows carry a summary composed here, never a slice.
          argsTruncated: false,
        },
        at: Date.now(),
      };
    }
    return {
      kind: "tool-step",
      step: {
        round,
        toolCallId: event.id,
        name: event.name,
        argumentSummary: queries.get(event.id) ?? "{}",
        status: event.error ? "error" : "done",
        resultSummary: event.error ?? summarizeSearchResults(event.results),
        argsTruncated: false,
        resultTruncated: false,
      },
      at: Date.now(),
    };
  };
}

/**
 * Append an event to a log immutably.
 *
 * Two kinds are emitted repeatedly for the same thing and replace their earlier
 * emission in place, so the log shows one line rather than duplicates: a tool
 * step (running → done/error), and a round's reasoning (re-emitted on every
 * fragment as it streams). Shared by aiTaskStore and the modal-local logs.
 */
export function appendAgentEventTo(log: AgentEvent[], event: AgentEvent): AgentEvent[] {
  const idx = replaceableIndex(log, event);
  if (idx >= 0) {
    const updated = [...log];
    updated[idx] = event;
    return updated;
  }
  return [...log, event];
}

/** Where `event` supersedes an existing entry, or -1 to append. */
function replaceableIndex(log: AgentEvent[], event: AgentEvent): number {
  if (event.kind === "tool-step") {
    return log.findIndex(
      (e) =>
        e.kind === "tool-step" &&
        e.parentStep === event.parentStep &&
        e.step.toolCallId === event.step.toolCallId &&
        e.step.name === event.step.name,
    );
  }
  if (event.kind === "reasoning") {
    return log.findIndex(
      (e) =>
        e.kind === "reasoning" &&
        e.parentStep === event.parentStep &&
        e.round === event.round,
    );
  }
  return -1;
}
