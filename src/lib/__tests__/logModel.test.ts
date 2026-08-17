import { describe, expect, it } from "vitest";
import {
  buildLogModel,
  delegateKind,
  delegateTask,
  roundRows,
  sumTokens,
  taskDocRevision,
} from "../agent/logModel";
import type { AgentEvent, ToolStepStatus } from "../agent/events";

let clock = 1_700_000_000_000;
const at = () => (clock += 1000);

function runStart(): AgentEvent {
  return { kind: "run-start", task: "continue", modelName: "M", agentic: true, at: at() };
}
function roundStart(round: number, est = 1000, maxRounds = 12): AgentEvent {
  return { kind: "round-start", round, maxRounds, estInputTokens: est, at: at() };
}
function tool(
  name: string,
  id: string,
  round = 1,
  status: ToolStepStatus = "done",
  args = "{}",
): AgentEvent {
  return {
    kind: "tool-step",
    step: { round, toolCallId: id, name, argumentSummary: args, status, resultSummary: "ok" },
    at: at(),
  };
}

describe("buildLogModel — banding", () => {
  it("splits the stream into preamble, rounds and an outcome", () => {
    const log: AgentEvent[] = [
      runStart(),
      { kind: "context-seeded", documentName: "第一章", recentChars: 900, memoryChars: 0, loreEntities: 2, loreChars: 300, at: at() },
      roundStart(1),
      tool("read_file", "a", 1),
      roundStart(2, 4000),
      tool("search_text", "b", 2),
      { kind: "run-done", inputTokens: 12_000, outputTokens: 900, at: at() },
    ];

    const model = buildLogModel(log, false);

    // run-start is the header's business, not a row.
    expect(model.start?.kind).toBe("run-start");
    expect(model.preamble.map((e) => e.kind)).toEqual(["context-seeded"]);
    expect(model.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(model.rounds[1].estInputTokens).toBe(4000);
    expect(model.summary).toMatchObject({
      state: "done",
      rounds: 2,
      maxRounds: 12,
      toolCount: 2,
      inputTokens: 12_000,
      outputTokens: 900,
    });
    // Finished: no round is live, so band ② owns all of them.
    expect(model.currentRound).toBeNull();
  });

  it("keeps a non-agentic run readable — no rounds, just a header", () => {
    const log: AgentEvent[] = [
      runStart(),
      { kind: "run-done", inputTokens: 300, outputTokens: 120, at: at() },
    ];
    const model = buildLogModel(log, false);
    expect(model.rounds).toEqual([]);
    expect(model.summary.state).toBe("done");
    expect(model.current?.kind).toBe("run-done");
  });

  it("reports an error run as an error, terminal event or not", () => {
    const model = buildLogModel(
      [runStart(), roundStart(1), { kind: "run-error", message: "boom", at: at() }],
      false,
    );
    expect(model.summary.state).toBe("error");
    expect(model.summary.errorMessage).toBe("boom");
  });

  it("trusts the caller's liveness, not the absence of a terminal event", () => {
    // A run killed with the window shut leaves no run-done. Reading that as
    // "still going" would spin a dead turn forever.
    const log = [runStart(), roundStart(1), tool("read_file", "a")];
    expect(buildLogModel(log, false).summary.state).toBe("done");
    expect(buildLogModel(log, false).currentRound).toBeNull();
    expect(buildLogModel(log, true).currentRound).toEqual({ round: 1, maxRounds: 12 });
  });
});

describe("buildLogModel — current activity", () => {
  it("prefers the tool the loop is blocked on", () => {
    const model = buildLogModel(
      [
        runStart(),
        roundStart(1),
        { kind: "reasoning", round: 1, text: "hmm", done: true, at: at() },
        tool("web_fetch", "a", 1, "running"),
      ],
      true,
    );
    expect(model.current?.kind).toBe("tool-step");
  });

  it("falls back to live reasoning, then to nothing at all", () => {
    const thinking = buildLogModel(
      [runStart(), roundStart(1), { kind: "reasoning", round: 1, text: "…", done: false, at: at() }],
      true,
    );
    expect(thinking.current?.kind).toBe("reasoning");

    // A round in flight with nothing to show for it yet: null, so the header
    // says 思考中 rather than replaying the previous round's last act.
    const fresh = buildLogModel([runStart(), roundStart(1), tool("read_file", "a", 1)], true);
    expect(fresh.current?.kind).toBe("tool-step");
    const empty = buildLogModel(
      [runStart(), roundStart(1), tool("read_file", "a", 1), roundStart(2)],
      true,
    );
    expect(empty.current).toBeNull();
  });
});

describe("buildLogModel — subagents", () => {
  const args = JSON.stringify({ kind: "search", task: "查一下 2026 年的行业报告" });

  const log = (): AgentEvent[] => [
    runStart(),
    roundStart(1),
    tool("delegate", "d1", 1, "done", args),
    { kind: "round-start", round: 1, maxRounds: 2, estInputTokens: 200, at: at(), parentStep: "d1" },
    { ...tool("web_search", "s1", 1), parentStep: "d1" },
    roundStart(2),
    tool("write_note", "n1", 2),
  ];

  it("lifts delegations into their own band, with the nested log attached", () => {
    const model = buildLogModel(log(), false);
    expect(model.subagents).toHaveLength(1);
    const [sub] = model.subagents;
    expect(sub.kind).toBe("search");
    expect(sub.task).toBe("查一下 2026 年的行业报告");
    expect(sub.status).toBe("done");
    expect(sub.round).toBe(1);
    // Only the events that ran inside it — the parent's own rows stay out.
    expect(sub.events.map((e) => e.kind)).toEqual(["round-start", "tool-step"]);
  });

  it("still counts the delegation as a round's work, but not as a round row", () => {
    const model = buildLogModel(log(), false);
    // The round remembers it happened…
    expect(model.rounds[0].events.map((e) => e.kind)).toEqual(["tool-step"]);
    // …but the renderer must not draw it twice.
    expect(roundRows(model.rounds[0])).toEqual([]);
    expect(model.summary.toolCount).toBe(2);
  });

  it("collapses the running and settled emissions of one call into one card", () => {
    const events: AgentEvent[] = [
      runStart(),
      roundStart(1),
      tool("delegate", "d1", 1, "running", args),
      tool("delegate", "d1", 1, "done", args),
    ];
    const model = buildLogModel(events, false);
    expect(model.subagents).toHaveLength(1);
    expect(model.subagents[0].status).toBe("done");
  });

  it("has no subagent band at all when nothing was delegated", () => {
    expect(buildLogModel([runStart(), roundStart(1), tool("read_file", "a")], false).subagents)
      .toEqual([]);
  });
});

describe("buildLogModel — round limits", () => {
  it("hoists the cap decision out of the round it was emitted after", () => {
    // The runtime emits round-limit between rounds — after round 1's work,
    // before round 2's start — so left to the stream's grouping it would land
    // inside round 1's body and read as one of that round's own acts.
    const log: AgentEvent[] = [
      runStart(),
      roundStart(1),
      tool("read_file", "a", 1),
      { kind: "round-limit", roundsUsed: 1, decision: { action: "extend", rounds: 4 }, at: at() },
      roundStart(2),
      tool("write_note", "b", 2),
      { kind: "run-done", inputTokens: 100, outputTokens: 50, at: at() },
    ];
    const model = buildLogModel(log, false);
    expect(model.roundLimits).toHaveLength(1);
    expect(model.roundLimits[0].decision).toEqual({ action: "extend", rounds: 4 });
    for (const round of model.rounds) {
      expect(round.events.some((e) => e.kind === "round-limit")).toBe(false);
    }
    expect(model.preamble.some((e) => e.kind === "round-limit")).toBe(false);
  });

  it("keeps repeated extensions in order", () => {
    const log: AgentEvent[] = [
      runStart(),
      roundStart(1),
      { kind: "round-limit", roundsUsed: 1, decision: { action: "extend", rounds: 2 }, at: at() },
      roundStart(2),
      { kind: "round-limit", roundsUsed: 2, decision: { action: "finish" }, at: at() },
    ];
    const model = buildLogModel(log, false);
    expect(model.roundLimits.map((e) => e.roundsUsed)).toEqual([1, 2]);
  });

  it("catches a limit that arrives before any round — nothing is dropped", () => {
    const log: AgentEvent[] = [
      { kind: "round-limit", roundsUsed: 8, decision: { action: "pause" }, at: at() },
    ];
    expect(buildLogModel(log, false).roundLimits).toHaveLength(1);
  });
});

describe("delegate argument parsing", () => {
  it("reads kind and task out of well-formed arguments", () => {
    const raw = JSON.stringify({ kind: "vision", task: "描述这张图" });
    expect(delegateKind(raw)).toBe("vision");
    expect(delegateTask(raw)).toBe("描述这张图");
  });

  it("survives the 400-char truncation the runtime applies", () => {
    // `delegate` is the one tool whose task argument is a paragraph by design,
    // so its JSON routinely arrives cut mid-string and JSON.parse fails outright.
    const full = JSON.stringify({ kind: "longread", task: "把这份报告读完并总结要点".repeat(60) });
    const cut = full.slice(0, 400);
    expect(() => JSON.parse(cut)).toThrow();
    expect(delegateKind(cut)).toBe("longread");
    expect(delegateTask(cut).startsWith("把这份报告读完并总结要点")).toBe(true);
  });

  it("gives up quietly when the cut landed before the kind", () => {
    const raw = '{"task":"' + "x".repeat(500);
    expect(delegateKind(raw)).toBeNull();
    expect(delegateTask(raw)).toBe("x".repeat(500));
  });

  it("unescapes rather than leaking JSON escapes into the label", () => {
    const raw = JSON.stringify({ kind: "search", task: 'find "the report"\nfast' });
    expect(delegateTask(raw)).toBe('find "the report"\nfast');
  });
});

describe("sumTokens", () => {
  it("keeps the subagents' bill separate from the main model's", () => {
    // Two different prices on two different models — folding them into one
    // figure would hide the point of delegating: a big cheap read moved off
    // the expensive model.
    const logs: AgentEvent[][] = [
      [
        { kind: "run-done", inputTokens: 10_000, outputTokens: 500, at: at() },
      ],
      [
        { kind: "run-done", inputTokens: 40_000, outputTokens: 900, at: at(), parentStep: "d1" },
        { kind: "run-done", inputTokens: 20_000, outputTokens: 1_200, at: at() },
      ],
    ];
    expect(sumTokens(logs)).toEqual({
      input: 30_000, output: 1_700, subInput: 40_000, subOutput: 900,
    });
  });

  it("is zero for a session that has run nothing", () => {
    expect(sumTokens([])).toEqual({ input: 0, output: 0, subInput: 0, subOutput: 0 });
    expect(sumTokens([[runStart()]])).toEqual({ input: 0, output: 0, subInput: 0, subOutput: 0 });
  });
});

describe("taskDocRevision", () => {
  it("moves when a write to task.md lands, not when it is requested", () => {
    const requested: AgentEvent[] = [tool("task_plan", "p1", 1, "running")];
    const landed: AgentEvent[] = [tool("task_plan", "p1", 1, "done")];
    expect(taskDocRevision([requested])).toBe(0);
    expect(taskDocRevision([landed])).toBe(1);
  });

  it("ignores tools that don't touch the document", () => {
    expect(taskDocRevision([[tool("read_file", "a"), tool("write_note", "b")]])).toBe(0);
  });

  it("accumulates across a whole session's turns", () => {
    expect(
      taskDocRevision([
        [tool("task_plan", "p1", 1, "done")],
        [tool("task_progress", "g1", 1, "done"), tool("task_progress", "g2", 2, "done")],
      ]),
    ).toBe(3);
  });
});
