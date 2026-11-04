import { beforeEach, expect, it, vi } from "vitest";
import { runConsistencyReview } from "../review";
import { runAgent } from "../../agent/runtime";
import { loadTaskDoc } from "../../agent/taskWorkspace";
import type { AgentEvent } from "../../agent/events";

vi.mock("../../agent/runtime", () => ({ runAgent: vi.fn() }));
vi.mock("../../ai/conn", () => ({ connOptions: () => ({}), plannedLimits: () => ({ contextSize: 100000 }) }));
vi.mock("../../ai/configDb", () => ({ canSeeImages: () => false }));
vi.mock("../../agent/taskWorkspace", async (original) => ({
  ...await original<typeof import("../../agent/taskWorkspace")>(),
  createTaskWorkspace: () => ({ taskId: "plan" }),
  loadTaskDoc: vi.fn(),
}));
vi.mock("../../agent/routing", () => ({ routeTools: (preset: { tools: string[] }) => ({ tools: preset.tools, serverTools: "off" }) }));
vi.mock("../../context/loreSelect", () => ({
  selectLore: async () => ({ text: "", report: { entities: [] } }),
  contributingEntities: () => [],
}));

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(loadTaskDoc).mockResolvedValue({ body: "## Steps\n- [x] Verify facts", meta: {} } as Awaited<ReturnType<typeof loadTaskDoc>>);
});

function args(events: AgentEvent[], count = 1): Parameters<typeof runConsistencyReview>[0] {
  return {
    conn: { model: { id: "test", modelId: "test" } },
    projectPath: "/fixture", documentText: "facts", documentTitle: "document", documentRelPath: null,
    loreIndex: {}, fence: null, scope: { kind: "all" }, focus: "", categoryIds: [], memory: null,
    plan: { loreBudgetChars: 1000, recapChars: 0 },
    windows: Array.from({ length: count }, (_, index) => ({ index, from: index, to: index + 1, text: "f" })),
    subAgents: {}, models: [], providers: [], contextUtilization: 0.8,
    signal: new AbortController().signal, runId: "review", onEvent: (e: AgentEvent) => events.push(e),
    onWindow: () => {}, onIssue: () => {}, onPass: () => {},
  } as unknown as Parameters<typeof runConsistencyReview>[0];
}

it.each([1, 2])("marks empty review incomplete and emits no successful parent completion (%s windows)", async (count) => {
  vi.mocked(runAgent).mockResolvedValue({ outcome: "completed", rounds: 2, inputTokens: 10, outputTokens: 2, cachedTokens: 0, reportedCost: null });
  const events: AgentEvent[] = [];
  const { results } = await runConsistencyReview(args(events, count));
  expect(results.every((r) => r.outcome.status === "incomplete" && r.outcome.empty)).toBe(true);
  expect(events.some((e) => e.kind === "run-error" && !e.parentStep)).toBe(true);
  expect(events.some((e) => e.kind === "run-done")).toBe(false);
});

it.each(["completed", "truncated"] as const)("preserves accepted results for a %s submission", async (outcome) => {
  vi.mocked(runAgent).mockImplementation(async (opts) => {
    opts.toolContext.reviewSink!.passed.push({ label: "verified", window: 0 });
    return { outcome, rounds: 14, inputTokens: 10, outputTokens: 2, cachedTokens: 0, reportedCost: null };
  });
  const { results } = await runConsistencyReview(args([]));
  expect(results[0].passed).toHaveLength(1);
  expect(results[0].outcome.status).toBe(outcome === "completed" ? "done" : "incomplete");
});


it("does not mark a review complete when the persisted plan still has unfinished steps", async () => {
  vi.mocked(loadTaskDoc).mockResolvedValue({ body: "## Steps\n- [ ] Verify facts", meta: {} } as Awaited<ReturnType<typeof loadTaskDoc>>);
  vi.mocked(runAgent).mockImplementation(async (opts) => {
    opts.toolContext.reviewSink!.passed.push({ label: "one fact", window: 0 });
    return { outcome: "completed", rounds: 2, inputTokens: 10, outputTokens: 2, cachedTokens: 0, reportedCost: null };
  });
  const { results } = await runConsistencyReview(args([]));
  expect(results[0].outcome.status).toBe("incomplete");
  expect(results[0].passed).toHaveLength(1);
});


it("forwards the correct window's budget decision and retains live usage on stop", async () => {
  const ask = vi.fn(async () => ({ action: "finish" as const }));
  vi.mocked(runAgent).mockImplementation(async (opts) => {
    opts.onEvent({ kind: "round-start", round: 11, maxRounds: 14, estInputTokens: 12, toolTokens: 3, at: 1 });
    opts.onEvent({ kind: "round-done", round: 11, actualInputTokens: 12,
      runUsage: { inputTokens: 120, outputTokens: 30 }, at: 2 });
    await opts.onRoundLimit!(11);
    throw new DOMException("Stopped", "AbortError");
  });
  const input = args([]);
  input.onRoundLimit = ask;
  const { results } = await runConsistencyReview(input);
  expect(ask).toHaveBeenCalledWith(input.windows[0], 11);
  expect(results[0].outcome).toMatchObject({ status: "aborted", rounds: 11, roundBudget: 14, inputTokens: 120, outputTokens: 30 });
});
