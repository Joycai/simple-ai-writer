/**
 * Regression tests for the two PR-B defects: pause availability was read off
 * chat state by a card that the task panel also renders, and the panel then
 * ignored the answer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useAgentStore } from "../../stores/agentStore";
import type { RoundLimitDecision } from "../agent/events";

describe("round-limit pause availability", () => {
  beforeEach(() => {
    useAgentStore.setState({ pendingRoundLimits: [], chatTaskWorkspace: null });
  });

  it("carries canPause on the queued item, not from chat state", async () => {
    const runA = {};
    const runB = {};
    // A run WITH something saved, and one without — queued at the same time,
    // exactly the situation that made the panel show a button chat owned.
    void useAgentStore.getState().requestRoundExtension(3, 5, runA, true);
    void useAgentStore.getState().requestRoundExtension(3, 5, runB, false);

    const items = useAgentStore.getState().pendingRoundLimits;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.runId === runA)!.canPause).toBe(true);
    expect(items.find((i) => i.runId === runB)!.canPause).toBe(false);

    // And it does not track chatTaskWorkspace, which is what the card used to read.
    useAgentStore.setState({ chatTaskWorkspace: { taskId: "t1", ensure: async () => ({ taskId: "t1", dir: "/d" }) } });
    expect(useAgentStore.getState().pendingRoundLimits.find((i) => i.runId === runB)!.canPause).toBe(false);
  });

  it("resolves only the addressed run and drains the rest as finish", async () => {
    const runA = {};
    const runB = {};
    let decidedA: RoundLimitDecision | null = null;
    let decidedB: RoundLimitDecision | null = null;
    void useAgentStore.getState().requestRoundExtension(3, 5, runA, true).then((d) => { decidedA = d; });
    void useAgentStore.getState().requestRoundExtension(3, 5, runB, true).then((d) => { decidedB = d; });

    useAgentStore.getState().resolveRoundLimit(runA, { action: "pause" });
    await Promise.resolve();
    expect(decidedA).toEqual({ action: "pause" });
    expect(decidedB).toBeNull();

    // Abort drains the other one as finish — never as pause, which would
    // silently discard a run the author only meant to stop.
    useAgentStore.getState().rejectAll("aborted", runB);
    await Promise.resolve();
    expect(decidedB).toEqual({ action: "finish" });
  });
});
