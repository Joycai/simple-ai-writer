/**
 * Deferred tool groups: the lore write tools are not sent until the author has
 * approved a plan.
 *
 * The saving is the visible part (nine schemas the run stops paying for on
 * every round before it can legally use them), but the part that has to be
 * pinned is the boundary: withholding a *definition* must also withhold the
 * *execution*. Leave the runtime dispatching against the preset's full toolset
 * and a deferred tool stays callable while its schema is merely hidden — the
 * gate doing nothing at all, dressed up as a saving.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamOptions, ToolDefinition } from "../ai/types";
import type { AgentEvent } from "../agent/events";
import type { TaskPreset } from "../agent/presets";
import { runAgent, type AgentRuntimeOptions } from "../agent/runtime";
import { createPlanGate, type PlanGate } from "../agent/plan";
import { partitionByGroup } from "../agent/registry";
import type { LoreIndex } from "../lore";

vi.mock("../ai", () => ({ streamCompletion: vi.fn() }));
import { streamCompletion } from "../ai";
const mockStream = vi.mocked(streamCompletion);

const LORE_INDEX = { characters: [], world: [] } as unknown as LoreIndex;

/** A slice of the assistant preset: one reader, the plan gate, the write tools. */
const PRESET: TaskPreset = {
  id: "test-groups",
  tools: [
    "list_lore_entities",
    "propose_lore_plan",
    "create_lore_entity",
    "update_lore_meta",
    "delete_lore_entity",
  ],
  maxRounds: 6,
  finishPolicy: "force-text",
};

const LORE_WRITE = ["create_lore_entity", "update_lore_meta", "delete_lore_entity"];

/** Tool names offered on each round, in wire order. */
const offered: (string[] | undefined)[] = [];

function queueRound(chunks: Array<Record<string, unknown>>, before?: () => void): void {
  mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
    before?.();
    offered.push(opts.tools?.map((t: ToolDefinition) => t.function.name));
    for (const c of chunks) opts.onChunk(c as never);
  });
}

function makeOptions(gate: PlanGate | undefined): AgentRuntimeOptions & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    baseUrl: "http://localhost",
    apiKey: "k",
    standard: "openai" as const,
    modelId: "m",
    preset: PRESET,
    messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "go" }],
    toolContext: {
      projectPath: "/p",
      loreIndex: LORE_INDEX,
      multimodal: false,
      lorePlan: gate,
    },
    signal: new AbortController().signal,
    onEvent: (e: AgentEvent) => void events.push(e),
    onOutputText: () => {},
    events,
  };
}

const done = { done: true, inputTokens: 1, outputTokens: 1 };

beforeEach(() => {
  mockStream.mockReset();
  offered.length = 0;
});

describe("partitionByGroup", () => {
  it("splits the write tools out and leaves the rest in place", () => {
    const { resident, deferred } = partitionByGroup(PRESET.tools);
    expect(resident).toEqual(["list_lore_entities", "propose_lore_plan"]);
    expect(deferred.lore_write).toEqual(LORE_WRITE);
  });
});

describe("lore_write is withheld until a plan is approved", () => {
  it("offers the plan tool but none of the write tools on the first round", async () => {
    queueRound([{ text: "ok" }, done]);
    await runAgent(makeOptions(createPlanGate()));

    expect(offered[0]).toEqual(["list_lore_entities", "propose_lore_plan"]);
  });

  it("refuses a deferred tool called before its group loads", async () => {
    // The boundary. Not "the model is told to plan first" (that is plan.ts's
    // error text) — the tool is not on offer at all, so the dispatcher has
    // nothing to run.
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "create_lore_entity", arguments: "{}" }] },
      done,
    ]);
    queueRound([{ text: "fine" }, done]);
    const opts = makeOptions(createPlanGate());

    await runAgent(opts);

    // Emitted twice per call — running, then settled. The verdict is the last.
    const steps = opts.events.filter((e) => e.kind === "tool-step");
    const step = steps[steps.length - 1];
    expect(step).toMatchObject({ step: { name: "create_lore_entity", status: "error" } });
    expect((step as { step: { resultSummary: string } }).step.resultSummary)
      .toContain("Unknown tool");
  });

  it("appends the group once the gate has approved steps, keeping the prefix stable", async () => {
    const gate = createPlanGate();
    // The author approves during round 1 — which is when propose_lore_plan
    // would really resolve — and the runtime notices at the top of round 2.
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      done,
    ], () => {
      gate.steps.push({ action: "create", entity: "Ava", detail: "新建" });
    });
    queueRound([{ text: "done" }, done]);
    await runAgent(makeOptions(gate));

    expect(offered[0]).toEqual(["list_lore_entities", "propose_lore_plan"]);
    expect(offered[1]).toEqual(["list_lore_entities", "propose_lore_plan", ...LORE_WRITE]);
    // The resident half keeps its positions: on the Anthropic family that array
    // is the cached prefix, and a reshuffle would throw the cache away.
    expect(offered[1]!.slice(0, 2)).toEqual(offered[0]);
  });

  it("announces the load once, not on every round after it", async () => {
    const gate = createPlanGate();
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      done,
    ], () => {
      gate.steps.push({ action: "create", entity: "Ava", detail: "新建" });
    });
    queueRound([
      { toolCalls: [{ index: 0, id: "c2", name: "list_lore_entities", arguments: "{}" }] },
      done,
    ]);
    queueRound([{ text: "done" }, done]);
    const opts = makeOptions(gate);

    await runAgent(opts);

    const loaded = opts.events.filter((e) => e.kind === "tools-loaded");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ group: "lore_write", round: 2, names: LORE_WRITE });
  });

  it("never loads on a surface that cannot review plans at all", async () => {
    // No gate: the write tools would refuse anyway (plan.ts), so today they were
    // still being sent and paid for on every round of such a run.
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      done,
    ]);
    queueRound([{ text: "done" }, done]);
    const opts = makeOptions(undefined);

    await runAgent(opts);

    expect(offered[0]).toEqual(["list_lore_entities", "propose_lore_plan"]);
    expect(offered[1]).toEqual(["list_lore_entities", "propose_lore_plan"]);
    expect(opts.events.some((e) => e.kind === "tools-loaded")).toBe(false);
  });

  it("reports the round's real tool cost, which grows with the load", async () => {
    const gate = createPlanGate();
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      done,
    ], () => {
      gate.steps.push({ action: "create", entity: "Ava", detail: "新建" });
    });
    queueRound([{ text: "done" }, done]);
    const opts = makeOptions(gate);

    await runAgent(opts);

    const starts = opts.events.filter(
      (e): e is Extract<AgentEvent, { kind: "round-start" }> => e.kind === "round-start",
    );
    expect(starts[1].toolTokens!).toBeGreaterThan(starts[0].toolTokens!);
  });
});
