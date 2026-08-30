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
import { toolTokensOf } from "../agent/toolCost";
import { estimateMessagesTokens } from "../ai/tokenEstimate";
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
    "manage_collection",
    "file_lore_entries",
  ],
  maxRounds: 6,
  finishPolicy: "force-text",
};

const LORE_WRITE = ["create_lore_entity", "update_lore_meta", "delete_lore_entity"];
const LORE_ORGANIZE = ["manage_collection", "file_lore_entries"];

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
    // 只装载 lore_write：批准的是一条**条目**步骤，集合工具不该顺路进来。
    expect(offered[1]).toEqual(["list_lore_entities", "propose_lore_plan", ...LORE_WRITE]);
    // The resident half keeps its positions: on the Anthropic family that array
    // is the cached prefix, and a reshuffle would throw the cache away.
    expect(offered[1]!.slice(0, 2)).toEqual(offered[0]);
  });

  /**
   * 装载是**按方案形状**分的，不是全有全无。这一对测试是那条设计的守卫：批准一份
   * 「改写条目正文」的方案不该顺手把集合工具塞进来，反过来也一样——否则「渐进式
   * 披露」就退化成「批准任何东西都把整箱工具倒出来」。
   */
  it("a collection step loads only the organize group", async () => {
    const gate = createPlanGate();
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      done,
    ], () => {
      gate.steps.push({ target: "collection", action: "create", entity: "《雪原书》", detail: "新集合" });
    });
    queueRound([{ text: "done" }, done]);
    await runAgent(makeOptions(gate));

    expect(offered[1]).toEqual(["list_lore_entities", "propose_lore_plan", ...LORE_ORGANIZE]);
  });

  it("a plan with both shapes loads both groups", async () => {
    const gate = createPlanGate();
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      done,
    ], () => {
      gate.steps.push({ action: "create", entity: "Ava", detail: "新建" });
      gate.steps.push({ target: "collection", action: "update", entity: "小说A", members: ["Ava"], detail: "归入" });
    });
    queueRound([{ text: "done" }, done]);
    await runAgent(makeOptions(gate));

    expect(offered[1]).toEqual([
      "list_lore_entities",
      "propose_lore_plan",
      ...LORE_WRITE,
      ...LORE_ORGANIZE,
    ]);
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

  /**
   * The other half of the resident-only planning contract (toolCost): the
   * caller budgets `inputCeilingTokens` against the resident schemas, so when
   * a group loads mid-run the runtime must shrink its own ceiling by that
   * group's measured cost. Without this, a run that earns `lore_write` on a
   * small window keeps trimming to a ceiling ~5k too generous — the silent
   * overflow the ceiling exists to prevent, back again for exactly the runs
   * that write lore.
   */
  it("shrinks its message ceiling by the loaded group's cost", async () => {
    const gate = createPlanGate();
    // A paired old tool exchange with a fat payload — trimHistory's one
    // eligible victim. Everything else in history is text it never touches.
    const fat = "设定资料。".repeat(1_600);
    const seed: AgentRuntimeOptions["messages"] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [
        { id: "old1", type: "function", function: { name: "list_lore_entities", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "old1", content: fat },
    ];
    const seedTokens = estimateMessagesTokens(seed);
    const groupCost = toolTokensOf(partitionByGroup(PRESET.tools).deferred.lore_write);
    expect(groupCost).toBeGreaterThan(300); // the premise: the load is not free

    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      done,
    ], () => {
      gate.steps.push({ action: "create", entity: "Ava", detail: "新建" });
    });
    queueRound([{ text: "done" }, done]);
    const opts = { ...makeOptions(gate), messages: seed };
    // Above the seed (round 1 must not trim), below seed + groupCost (round 2,
    // with the group loaded and the ceiling shrunk, must).
    opts.inputCeilingTokens = seedTokens + Math.floor(groupCost / 2);

    await runAgent(opts);

    const trims = opts.events.filter(
      (e): e is Extract<AgentEvent, { kind: "context-trimmed" }> => e.kind === "context-trimmed",
    );
    expect(trims).toHaveLength(1);
    // And what it trimmed is the fat old result — the ceiling moved, the
    // mechanism stayed trimHistory's own.
    expect(seed.find((m) => m.role === "tool" && m.tool_call_id === "old1")!.content)
      .not.toContain("设定资料");
  });

  /**
   * The shrink must never land on 0: trimHistory reads a falsy ceiling as "no
   * ceiling — don't trim", so a clamp to 0 would switch trimming OFF at the
   * exact moment the schemas outgrew the window — unbounded history growth on
   * precisely the smallest-window models. Floored at 1, those runs keep
   * trimming maximally instead of not at all.
   */
  it("keeps trimming when the loaded group swallows the whole ceiling (floor at 1, not 0)", async () => {
    const gate = createPlanGate();
    const fat = "设定资料。".repeat(40);
    const seed: AgentRuntimeOptions["messages"] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [
        { id: "old1", type: "function", function: { name: "list_lore_entities", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "old1", content: fat },
    ];
    const seedTokens = estimateMessagesTokens(seed);
    const groupCost = toolTokensOf(partitionByGroup(PRESET.tools).deferred.lore_write);
    // The premise: the ceiling fits round 1 whole, and the group's cost then
    // swallows it entirely — the spot where Math.max(0, …) landed on exactly 0.
    expect(seedTokens + 60).toBeLessThan(groupCost);

    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      done,
    ], () => {
      gate.steps.push({ action: "create", entity: "Ava", detail: "新建" });
    });
    queueRound([{ text: "done" }, done]);
    const opts = { ...makeOptions(gate), messages: seed };
    opts.inputCeilingTokens = seedTokens + 60;

    await runAgent(opts);

    const trims = opts.events.filter(
      (e): e is Extract<AgentEvent, { kind: "context-trimmed" }> => e.kind === "context-trimmed",
    );
    expect(trims.length).toBeGreaterThan(0);
    expect(seed.find((m) => m.role === "tool" && m.tool_call_id === "old1")!.content)
      .not.toContain("设定资料");
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
