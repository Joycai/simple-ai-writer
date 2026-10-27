/** Per-network-attempt accounting. Snapshots replace fields; they are never deltas. */
import type { Model } from "./configDb";
import type { ProtocolFamily } from "./types";
import { recordUsage } from "./usageRow";

export interface StreamAccounting {
  projectPath: string | null;
  model: Pick<Model, "id" | "fee">;
  task: string;
}
export interface ReportedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reportedCost?: number;
}
const count = (n: unknown): number | undefined => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const sum = (...values: unknown[]) => {
  const known = values.map(count).filter((n): n is number => n !== undefined);
  return known.length ? count(known.reduce((a, b) => a + b, 0)) : undefined;
};
/** Only fields actually reported by the wire enter the evidence snapshot. */
export function usageSnapshot(family: ProtocolFamily, raw: unknown, cost?: number): ReportedUsage {
  const u = object(raw);
  const details = object(u.prompt_tokens_details ?? u.input_tokens_details);
  const values: ReportedUsage = family === "anthropic"
    ? { inputTokens: sum(u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens), outputTokens: count(u.output_tokens), cachedTokens: count(u.cache_read_input_tokens) }
    : family === "gemini"
      ? { inputTokens: sum(u.promptTokenCount, u.toolUsePromptTokenCount), outputTokens: sum(u.candidatesTokenCount, u.thoughtsTokenCount), cachedTokens: count(u.cachedContentTokenCount) }
      : { inputTokens: count(family === "openai" ? u.prompt_tokens : u.input_tokens), outputTokens: count(family === "openai" ? u.completion_tokens : u.output_tokens), cachedTokens: count(details.cached_tokens) };
  values.reportedCost = count(cost);
  return Object.fromEntries(Object.entries(values).filter(([, n]) => n !== undefined));
}

export function createStreamUsage(accounting: StreamAccounting | undefined) {
  // Snapshot the fee before an asynchronous request can outlive model edits.
  const context = accounting && { ...accounting, model: structuredClone(accounting.model) };
  let current: { id: string; usage: ReportedUsage; complete: boolean } | undefined;
  let closed = false;
  const writes: Promise<void>[] = [];
  function settle(outcome: "complete" | "failed" | "cancelled") {
    if (!current) return;
    const attempt = current;
    current = undefined;
    if (!context) return;
    const evidence = Object.keys(attempt.usage).length > 0;
    // Even without usage, retain an unknown attempt rather than imply it was free.
    writes.push(recordUsage(context.projectPath, {
      model: context.model, task: context.task,
      promptTokens: attempt.usage.inputTokens, completionTokens: attempt.usage.outputTokens,
      cachedTokens: attempt.usage.cachedTokens, reportedCost: attempt.usage.reportedCost ?? null,
      requests: outcome === "complete" ? 1 : 0,
      requestId: attempt.id,
      usageEvidence: { outcome, source: evidence ? "reported" : "unreported", fields: attempt.usage },
    }));
  }
  return {
    start() {
      if (closed) return;
      if (current) settle(current.complete ? "complete" : "failed");
      current = { id: crypto.randomUUID(), usage: {}, complete: false };
    },
    snapshot(usage: ReportedUsage) {
      if (!closed && current) Object.assign(current.usage, usage);
    },
    complete() { if (!closed && current) current.complete = true; },
    async finish(outcome: "complete" | "failed" | "cancelled") {
      if (closed) return;
      closed = true;
      if (current) settle(current.complete ? "complete" : outcome);
      await Promise.all(writes);
    },
  };
}
