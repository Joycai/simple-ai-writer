import { beforeEach, expect, it, vi } from "vitest";
import { runConsistencyReview } from "../review";
import { runAgent } from "../../agent/runtime";
import type { AgentEvent } from "../../agent/events";

vi.mock("../../agent/runtime", () => ({ runAgent: vi.fn() }));
vi.mock("../../ai/conn", () => ({ connOptions: () => ({}), plannedLimits: () => ({ contextSize: 100000 }) }));
vi.mock("../../ai/configDb", () => ({ canSeeImages: () => false }));
vi.mock("../../agent/taskWorkspace", () => ({ createTaskWorkspace: () => ({}) }));
vi.mock("../../agent/routing", () => ({ routeTools: (preset: { tools: string[] }) => ({ tools: preset.tools, serverTools: "off" }) }));
vi.mock("../../context/loreSelect", () => ({
  selectLore: async () => ({ text: "", report: { entities: [] } }),
  contributingEntities: () => [],
}));

beforeEach(() => { vi.mocked(runAgent).mockReset(); });

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
