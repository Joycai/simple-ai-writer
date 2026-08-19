/**
 * agentStore's approval queue: scoped rejectAll (see Phase 3 fix — a panel
 * task and a chat turn can run at once, each with its own pending approvals,
 * so one run finishing must not auto-reject the other's still-open card).
 */
import { describe, expect, it } from "vitest";
import { useAgentStore } from "../../stores/agentStore";
import type { EditProposal } from "../agent/registry";
import type { LorePlan } from "../agent/plan";

function proposal(id: string): EditProposal {
  return { kind: "edit", id, path: "/p/writing/a.md", find: "x", replace: "y", occurrences: 1 };
}

function plan(id: string): LorePlan {
  return { id, steps: [] };
}

describe("agentStore rejectAll — scoped to the calling run", () => {
  it("leaves another run's pending approval untouched", async () => {
    const runA = {};
    const runB = {};
    const declineA = useAgentStore.getState().requestApproval(proposal("a"), runA);
    const declineB = useAgentStore.getState().requestApproval(proposal("b"), runB);
    expect(useAgentStore.getState().pending).toHaveLength(2);

    useAgentStore.getState().rejectAll("run A ended", runA);

    // Run A's own approval resolved as rejected...
    await expect(declineA).resolves.toEqual({ approved: false, reason: "run A ended" });
    // ...but run B's card is still open, waiting on its own resolution.
    expect(useAgentStore.getState().pending).toHaveLength(1);
    expect(useAgentStore.getState().pending[0].proposal.id).toBe("b");

    useAgentStore.getState().rejectAll("run B ended", runB);
    await expect(declineB).resolves.toEqual({ approved: false, reason: "run B ended" });
    expect(useAgentStore.getState().pending).toHaveLength(0);
  });

  it("is a no-op for a runId with nothing pending", () => {
    useAgentStore.getState().rejectAll("nothing to do", {});
    expect(useAgentStore.getState().pending).toHaveLength(0);
  });

  it("scopes pendingPlans the same way", async () => {
    const runA = {};
    const runB = {};
    const declineA = useAgentStore.getState().requestPlanApproval(plan("pa"), runA);
    useAgentStore.getState().requestPlanApproval(plan("pb"), runB);

    useAgentStore.getState().rejectAll("run A ended", runA);

    await expect(declineA).resolves.toEqual({ approved: false, reason: "run A ended" });
    expect(useAgentStore.getState().pendingPlans).toHaveLength(1);
    expect(useAgentStore.getState().pendingPlans[0].plan.id).toBe("pb");

    // Clean up so this test doesn't leak state into another file's run.
    useAgentStore.getState().rejectAll("cleanup", runB);
  });
});
