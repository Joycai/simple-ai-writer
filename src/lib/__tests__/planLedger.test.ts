/**
 * The plan ledger: an approved lore plan with each step's receipts
 * (设计稿 02h 1i).
 *
 * Pinned: a write lands on the step the gate says it satisfied — never on a
 * step the ledger guesses — a second plan in the same run keeps its own steps,
 * refusals are shown under the plan they happened after, and a receipt counts
 * the characters that changed rather than the size of the entry.
 */
import { describe, expect, it } from "vitest";
import { buildPlanLedgers, receiptOf } from "../agent/planLedger";
import type { AgentEvent, ChangeRecord, PlanRecord, ToolStep } from "../agent/events";

let clock = 1_700_000_000_000;
const at = () => (clock += 1000);

function stepEvent(step: Partial<ToolStep> & { toolCallId: string; name: string }): AgentEvent {
  return {
    kind: "tool-step",
    step: { round: 1, argumentSummary: "{}", status: "done", resultSummary: "ok", ...step },
    at: at(),
  };
}

const PLAN: PlanRecord = {
  id: "plan-1",
  summary: "按第 12 章统一发色，顺手清掉重复的地点。",
  offset: 0,
  steps: [
    { action: "create", entity: "凯尔", detail: "补一条新角色" },
    { action: "update", entity: "莉安", file: "外貌.md", detail: "金发改银发" },
    { action: "delete", entity: "旧码头", detail: "与港口重复" },
  ],
};

const update = (before: string, after: string): ChangeRecord => ({
  path: ".ai-writer/lore/characters/lian/外貌.md",
  entity: "莉安",
  action: "update",
  before,
  after,
  beforeChars: before.length,
  afterChars: after.length,
  backupPath: "/p/.ai-writer/backups/x",
});

describe("buildPlanLedgers", () => {
  it("puts each write under the step the gate matched", () => {
    const log: AgentEvent[] = [
      stepEvent({ toolCallId: "p", name: "propose_lore_plan", plan: PLAN }),
      stepEvent({
        toolCallId: "w1",
        name: "create_lore_entity",
        planStep: 0,
        change: {
          path: ".ai-writer/lore/characters/kael/index.md",
          entity: "凯尔",
          action: "create",
          after: "# 凯尔\n",
          beforeChars: 0,
          afterChars: 5,
        },
      }),
      stepEvent({
        toolCallId: "w2",
        name: "edit_lore_file",
        planStep: 1,
        change: update("金发及腰。", "银发及腰。"),
      }),
    ];

    const [ledger] = buildPlanLedgers(log);
    expect(ledger.toolCallId).toBe("p");
    expect(ledger.steps.map((s) => s.writes.map((w) => w.toolCallId))).toEqual([["w1"], ["w2"], []]);
    expect(ledger.written).toBe(2);
    expect(ledger.steps[1]).toMatchObject({ added: 1, removed: 1 });
    expect(ledger).toMatchObject({ added: 6, removed: 1 });
  });

  it("keeps a second plan's steps apart from the first's", () => {
    const second: PlanRecord = {
      id: "plan-2",
      offset: 3,
      steps: [{ action: "update", entity: "凯尔", detail: "补外貌" }],
    };
    const log: AgentEvent[] = [
      stepEvent({ toolCallId: "p1", name: "propose_lore_plan", plan: PLAN }),
      stepEvent({ toolCallId: "p2", name: "propose_lore_plan", plan: second }),
      stepEvent({ toolCallId: "w", name: "update_lore_file", planStep: 3, change: update("a", "ab") }),
    ];

    const [first, next] = buildPlanLedgers(log);
    expect(first.written).toBe(0);
    expect(next.steps[0].writes.map((w) => w.toolCallId)).toEqual(["w"]);
  });

  it("files a refusal under the plan it happened after", () => {
    const log: AgentEvent[] = [
      stepEvent({ toolCallId: "early", name: "update_lore_file", status: "error", planRefused: true }),
      stepEvent({ toolCallId: "p", name: "propose_lore_plan", plan: PLAN }),
      stepEvent({ toolCallId: "late", name: "delete_lore_entity", status: "error", planRefused: true }),
    ];

    const [ledger] = buildPlanLedgers(log);
    // The one before any plan has nowhere to go; the tool row already says it.
    expect(ledger.refused.map((r) => r.toolCallId)).toEqual(["late"]);
  });

  it("builds nothing for a plan that was not approved", () => {
    // A rejection returns no plan record, so there is nothing to keep an account of.
    const log: AgentEvent[] = [stepEvent({ toolCallId: "p", name: "propose_lore_plan" })];
    expect(buildPlanLedgers(log)).toEqual([]);
  });

  it("ignores writes inside a dispatched sub-run", () => {
    const nested: AgentEvent = {
      ...stepEvent({ toolCallId: "w", name: "update_lore_file", planStep: 1, change: update("a", "b") }),
      parentStep: "pack-1",
    };
    const [ledger] = buildPlanLedgers([
      stepEvent({ toolCallId: "p", name: "propose_lore_plan", plan: PLAN }),
      nested,
    ]);
    expect(ledger.written).toBe(0);
  });
});

describe("receiptOf", () => {
  it("counts the characters that changed, not the entry twice", () => {
    expect(receiptOf(update("金发及腰，常年一身洗旧的靛蓝长袍。", "银发及腰，常年一身洗旧的靛蓝长袍；左眉上有一道旧疤。")))
      // 「金」 out; 「银」 and 「；左眉上有一道旧疤」 in. The closing 「。」 is in both.
      .toEqual({ added: 10, removed: 1 });
  });

  it("counts a whole file for a create or a delete", () => {
    expect(receiptOf({ path: "x", action: "create", beforeChars: 0, afterChars: 40, after: "x".repeat(40) }))
      .toEqual({ added: 40, removed: 0 });
    expect(receiptOf({ path: "x", action: "delete", beforeChars: 380, afterChars: 0 }))
      .toEqual({ added: 0, removed: 380 });
  });

  it("falls back to the net size change when the texts were dropped", () => {
    expect(receiptOf({ path: "x", action: "update", beforeChars: 5000, afterChars: 5300 }))
      .toEqual({ added: 300, removed: 0 });
  });
});
