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
}

export type AgentEvent =
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
      /** Estimated input tokens for this round's request. */
      estInputTokens: number;
      at: number;
    }
  | { kind: "tool-step"; step: ToolStep; at: number }
  | {
      /**
       * Context the assembler injected *before* the loop started — the RAG
       * layers the model never had to ask for.
       *
       * Emitted by the conversational assistant, where this happens once (the
       * first turn seeds the wire history; later turns inherit it and must use
       * tools for anything more). Without it the log looks as though the run
       * began knowing nothing, and a lore miss — the single most useful thing
       * to notice — is invisible. The task panel has its own richer
       * 「本次注入设定」 report and does not emit this.
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
       * author was asked whether to keep going. `granted` is the extra rounds
       * they allowed — 0 means they chose to let the run wrap up.
       */
      kind: "round-limit";
      roundsUsed: number;
      granted: number;
      at: number;
    }
  | { kind: "run-done"; inputTokens: number; outputTokens: number; at: number }
  | { kind: "run-error"; message: string; at: number };

/**
 * Append an event to a log immutably. A tool step is emitted twice
 * (running → done/error); the second emission replaces the first in place so
 * the log shows one line per call rather than duplicates. Shared by
 * aiTaskStore and the modal-local logs.
 */
export function appendAgentEventTo(log: AgentEvent[], event: AgentEvent): AgentEvent[] {
  if (event.kind === "tool-step") {
    const idx = log.findIndex(
      (e) =>
        e.kind === "tool-step" &&
        e.step.toolCallId === event.step.toolCallId &&
        e.step.name === event.step.name,
    );
    if (idx >= 0) {
      const updated = [...log];
      updated[idx] = event;
      return updated;
    }
  }
  return [...log, event];
}
