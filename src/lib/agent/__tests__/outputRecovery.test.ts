import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutputCheckpoint, parseOutputRecovery, type OutputRecovery } from "../outputRecovery";

const snapshot = (text: string): OutputRecovery => ({
  v: 1, id: "run-a", source: "task", modelId: "model", request: "Write", text,
  status: "streaming", updatedAt: 1,
});
afterEach(() => vi.useRealTimers());

describe("durable output checkpoints", () => {
  it("saves during a continuously active stream rather than waiting for silence", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (_s: OutputRecovery) => {});
    const journal = createOutputCheckpoint(write, vi.fn());
    for (let i = 0; i < 30; i++) {
      journal.update(snapshot(String(i)));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0][0].text).toBe("14");
    expect(write.mock.calls[1][0].text).toBe("29");
    await journal.close();
  });
  it("waits for an earlier write before committing a newer final snapshot", async () => {
    let release!: () => void;
    const writes: string[] = [];
    const journal = createOutputCheckpoint(async (s) => {
      if (s.text === "old") await new Promise<void>((resolve) => { release = resolve; });
      writes.push(s.text);
    }, vi.fn());
    journal.update(snapshot("old"));
    const first = journal.flush();
    journal.update(snapshot("final"));
    const closed = journal.close();
    expect(writes).toEqual([]);
    release();
    await first;
    await expect(closed).resolves.toBe(true);
    expect(writes).toEqual(["old", "final"]);
  });
  it("retains a failed snapshot and retries, exposing failure instead of claiming success", async () => {
    const error = vi.fn();
    const write = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const journal = createOutputCheckpoint(write, error);
    journal.update(snapshot("valuable text"));
    await expect(journal.flush()).resolves.toBe(false);
    expect(error).toHaveBeenCalledOnce();
    await expect(journal.close()).resolves.toBe(true);
    expect(write.mock.calls[1][0].text).toBe("valuable text");
  });
  it("restores a crash as interrupted and rejects malformed section cursors", () => {
    expect(parseOutputRecovery(JSON.stringify(snapshot("partial")))?.status).toBe("interrupted");
    expect(parseOutputRecovery(JSON.stringify({ ...snapshot(""), sections: ["a"], nextSection: 2 }))).toBeNull();
    expect(parseOutputRecovery("broken")).toBeNull();
  });
});
