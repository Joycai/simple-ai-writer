/** Pure scheduling decisions for roleplay's per-agent exclusive work. */

export interface AgentJobLike {
  agentId: string;
}

export function hasQueuedJob(queue: readonly AgentJobLike[], agentId: string): boolean {
  return queue.some((job) => job.agentId === agentId);
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
  return queue.findIndex(
    (job) => !running.includes(job.agentId) && !compacting.includes(job.agentId),
  );
}
