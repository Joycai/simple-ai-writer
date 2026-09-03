import { describe, expect, it } from "vitest";
import { hasQueuedJob, nextRunnableJobIndex } from "../roleplay/scheduler";

const queue = (agentIds: string[]) => agentIds.map((agentId) => ({ agentId }));

describe("roleplay scheduler", () => {
  it("does not start queued work for an agent that is being compacted", () => {
    expect(nextRunnableJobIndex(queue(["lin", "wu"]), [], ["lin"])).toBe(1);
    expect(nextRunnableJobIndex(queue(["lin"]), [], ["lin"])).toBe(-1);
    expect(nextRunnableJobIndex(queue(["lin"]), [], [])).toBe(0);
  });

  it("excludes running and compacting agents through the same decision", () => {
    expect(nextRunnableJobIndex(queue(["lin", "wu", "bei"]), ["lin"], ["wu"])).toBe(2);
    expect(nextRunnableJobIndex(queue(["lin", "wu"]), ["lin"], ["wu"])).toBe(-1);
  });

  it("detects an existing queued job before manual compaction reserves the agent", () => {
    expect(hasQueuedJob(queue(["lin"]), "lin")).toBe(true);
    expect(hasQueuedJob(queue(["lin"]), "wu")).toBe(false);
  });
});
