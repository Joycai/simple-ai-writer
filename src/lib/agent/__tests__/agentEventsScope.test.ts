import { describe, expect, it } from "vitest";
import { appendAgentEventTo, type AgentEvent } from "../events";

describe("AgentEvent with parentStep scope", () => {
  it("does not deduplicate events with different parentStep", () => {
    const e1: AgentEvent = {
      kind: "reasoning",
      round: 1,
      text: "Main thinking",
      done: true,
      at: 100,
    };
    const e2: AgentEvent = {
      kind: "reasoning",
      round: 1,
      text: "Subagent thinking",
      done: true,
      parentStep: "call_delegate_123",
      at: 105,
    };

    let log: AgentEvent[] = [];
    log = appendAgentEventTo(log, e1);
    log = appendAgentEventTo(log, e2);

    expect(log).toHaveLength(2);
    expect((log[0] as { text: string }).text).toBe("Main thinking");
    expect((log[1] as { text: string }).text).toBe("Subagent thinking");
  });

  it("updates reasoning in-place within the same parentStep", () => {
    const e1: AgentEvent = {
      kind: "reasoning",
      round: 1,
      text: "Subagent chunk 1",
      done: false,
      parentStep: "call_delegate_123",
      at: 100,
    };
    const e2: AgentEvent = {
      kind: "reasoning",
      round: 1,
      text: "Subagent chunk 1 and 2",
      done: true,
      parentStep: "call_delegate_123",
      at: 100,
    };

    let log = appendAgentEventTo([], e1);
    expect(log).toHaveLength(1);
    expect((log[0] as { text: string }).text).toBe("Subagent chunk 1");

    log = appendAgentEventTo(log, e2);
    expect(log).toHaveLength(1);
    expect((log[0] as { text: string }).text).toBe("Subagent chunk 1 and 2");
  });

  it("updates tool-step in-place within the same parentStep", () => {
    const s1: AgentEvent = {
      kind: "tool-step",
      parentStep: "call_delegate_123",
      step: {
        round: 1,
        toolCallId: "call_sub_1",
        name: "search_text",
        argumentSummary: "{}",
        status: "running",
      },
      at: 100,
    };
    const s2: AgentEvent = {
      kind: "tool-step",
      parentStep: "call_delegate_123",
      step: {
        round: 1,
        toolCallId: "call_sub_1",
        name: "search_text",
        argumentSummary: "{}",
        status: "done",
        resultSummary: "found 1 hit",
      },
      at: 100,
    };

    let log = appendAgentEventTo([], s1);
    expect(log).toHaveLength(1);
    expect((log[0] as { step: { status: string } }).step.status).toBe("running");

    log = appendAgentEventTo(log, s2);
    expect(log).toHaveLength(1);
    expect((log[0] as { step: { status: string } }).step.status).toBe("done");
  });
});
