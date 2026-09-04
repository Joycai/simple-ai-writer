/**
 * The one definition of "who may start next", shared by roleplay's roster and
 * the chat assistant's open conversations (docs/feature/agent/chat-sessions-plan.md §4.3).
 */
import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_RUNS, hasQueuedJob, nextRunnableJobIndex, ownerBusy,
} from "../scheduler";
import {
  hasQueuedJob as rpHasQueuedJob, nextRunnableJobIndex as rpNextRunnableJobIndex,
} from "../../roleplay/scheduler";

const byKey = (j: { key: string }) => j.key;

describe("scheduler", () => {
  it("is a semaphore of three", () => {
    expect(MAX_CONCURRENT_RUNS).toBe(3);
  });

  it("skips a queued job whose owner is busy instead of blocking the queue", () => {
    const queue = [{ key: "a" }, { key: "b" }, { key: "c" }];
    // a is generating, b is folding: c is the first that may start.
    expect(nextRunnableJobIndex(queue, ["a"], ["b"], byKey)).toBe(2);
    // Nothing runnable is -1, not 0.
    expect(nextRunnableJobIndex(queue, ["a", "c"], ["b"], byKey)).toBe(-1);
    expect(nextRunnableJobIndex([], [], [], byKey)).toBe(-1);
  });

  it("keeps one owner's jobs serial: the second waits for the first", () => {
    const queue = [{ key: "a" }, { key: "a" }];
    expect(nextRunnableJobIndex(queue, [], [], byKey)).toBe(0);
    expect(nextRunnableJobIndex(queue, ["a"], [], byKey)).toBe(-1);
  });

  it("names an owner busy while generating, folding or queued", () => {
    expect(ownerBusy("a", ["a"], [], [])).toBe(true);
    expect(ownerBusy("a", [], ["a"], [])).toBe(true);
    expect(ownerBusy("a", [], [], [{ key: "a" }])).toBe(true);
    expect(ownerBusy("a", ["b"], ["c"], [{ key: "d" }])).toBe(false);
    expect(hasQueuedJob([{ key: "a" }], "a", byKey)).toBe(true);
    expect(hasQueuedJob([{ key: "a" }], "b", byKey)).toBe(false);
  });

  it("is what roleplay's spelling delegates to", () => {
    const queue = [{ agentId: "lin" }, { agentId: "wu" }];
    expect(rpNextRunnableJobIndex(queue, ["lin"], [])).toBe(1);
    expect(rpHasQueuedJob(queue, "wu")).toBe(true);
  });
});
