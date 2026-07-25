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
  /** First 80 chars of result content, set on done/error */
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
      /** Older tool results were elided to stay inside the input ceiling. */
      kind: "context-trimmed";
      count: number;
      at: number;
    }
  | { kind: "run-done"; inputTokens: number; outputTokens: number; at: number }
  | { kind: "run-error"; message: string; at: number };
