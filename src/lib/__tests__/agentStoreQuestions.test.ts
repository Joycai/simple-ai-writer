/**
 * agentStore's question queue (`ask_author`): resolve-by-id (several questions
 * can block one run — the read tier executes in parallel), surface routing,
 * and the rejectAll drain that keeps a stopped run from leaving a tool call
 * awaiting a card that no longer exists.
 */
import { describe, expect, it } from "vitest";
import { useAgentStore } from "../../stores/agentStore";
import { cardsForSurface } from "../agent/approvalRouting";

describe("agentStore question queue", () => {
  it("resolves an option answer by card id, leaving other cards open", async () => {
    const run = {};
    const a = useAgentStore.getState().requestQuestion(
      { question: "走哪条线？", options: ["A 线", "B 线"] }, run,
    );
    const b = useAgentStore.getState().requestQuestion(
      { question: "第二个问题", options: ["是", "否"] }, run,
    );
    const [cardA, cardB] = useAgentStore.getState().pendingQuestions;
    expect(cardA.options).toEqual(["A 线", "B 线"]);

    useAgentStore.getState().resolveQuestion(cardA.id, { kind: "option", index: 1, text: "B 线" });
    await expect(a).resolves.toEqual({ kind: "option", index: 1, text: "B 线" });
    // The sibling card is untouched — resolution is per card, not per run.
    expect(useAgentStore.getState().pendingQuestions).toHaveLength(1);

    useAgentStore.getState().resolveQuestion(cardB.id, { kind: "other", text: "都不要" });
    await expect(b).resolves.toEqual({ kind: "other", text: "都不要" });
    expect(useAgentStore.getState().pendingQuestions).toHaveLength(0);
  });

  it("is a no-op for an id that is not pending", () => {
    useAgentStore.getState().resolveQuestion("question-none", { kind: "other", text: "x" });
    expect(useAgentStore.getState().pendingQuestions).toHaveLength(0);
  });

  it("rejectAll dismisses only the calling run's questions", async () => {
    const runA = {};
    const runB = {};
    const a = useAgentStore.getState().requestQuestion(
      { question: "qa", options: ["1", "2"] }, runA,
    );
    useAgentStore.getState().requestQuestion({ question: "qb", options: ["1", "2"] }, runB);

    useAgentStore.getState().rejectAll("run A ended", runA);
    await expect(a).resolves.toEqual({ kind: "dismissed" });
    expect(useAgentStore.getState().pendingQuestions).toHaveLength(1);

    useAgentStore.getState().rejectAll("cleanup", runB);
    expect(useAgentStore.getState().pendingQuestions).toHaveLength(0);
  });

  it("routes by surface tag like every other card", () => {
    const run = {};
    useAgentStore.getState().requestQuestion({ question: "默认", options: ["1", "2"] }, run);
    useAgentStore.getState().requestQuestion(
      { question: "带标", options: ["1", "2"] }, run, "rp-a-0001",
    );
    const all = useAgentStore.getState().pendingQuestions;
    expect(cardsForSurface(all, null).map((q) => q.question)).toEqual(["默认"]);
    expect(cardsForSurface(all, "rp-a-0001").map((q) => q.question)).toEqual(["带标"]);
    useAgentStore.getState().rejectAll("cleanup", run);
  });
});
