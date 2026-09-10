/**
 * Pure scheduling decisions for roleplay's per-agent exclusive work — the
 * roleplay spelling of lib/agent/scheduler, which both this store and the chat
 * assistant's open sessions share (one definition of "who may start next").
 */

import {
  hasQueuedJob as hasQueuedJobBy,
  nextRunnableJobIndex as nextRunnableJobIndexBy,
} from "../agent/scheduler";

export interface AgentJobLike {
  agentId: string;
}

const byAgent = (job: AgentJobLike) => job.agentId;

export function hasQueuedJob(queue: readonly AgentJobLike[], agentId: string): boolean {
  return hasQueuedJobBy(queue, agentId, byAgent);
}

/**
 * Pick the first queued job whose agent owns neither a generation slot nor a
 * manual-compaction slot. Both operations replace or extend the same wire
 * history, so they must never run together for one agent.
 */
export function nextRunnableJobIndex(
  queue: readonly AgentJobLike[],
  running: readonly string[],
  compacting: readonly string[],
): number {
  return nextRunnableJobIndexBy(queue, running, compacting, byAgent);
}
