/**
 * Parallel tool execution — one round's read-tier calls overlap, write calls
 * are barriers, and results land in history in the model's call order however
 * the lanes settled. Design: docs/feature/agent/parallel-tools-plan.md.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamOptions } from "../ai/types";
import type { AgentEvent } from "../agent/events";
import type { TaskPreset } from "../agent/presets";
import { runAgent, type AgentRuntimeOptions } from "../agent/runtime";
import type { ToolResult } from "../agent/tools";
import type { LoreIndex } from "../lore";

vi.mock("../ai", () => ({ streamCompletion: vi.fn() }));
import { streamCompletion } from "../ai";
const mockStream = vi.mocked(streamCompletion);

// The registry stays real — segmentation consults the real access tiers — but
// the executor is swapped for gated promises so a test can hold a tool call
// open and observe what the runtime dispatches while it is still in flight.
vi.mock("../agent/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/registry")>();
  return { ...actual, executeRegisteredTool: vi.fn() };
});
import { executeRegisteredTool, isParallelSafeTool } from "../agent/registry";
const mockExec = vi.mocked(executeRegisteredTool);

const LORE_INDEX = { characters: [], world: [] } as unknown as LoreIndex;

const PRESET: TaskPreset = {
  id: "test",
  tools: ["read_file", "list_files", "search_text", "task_plan"],
  maxRounds: 8,
  finishPolicy: "force-text",
};

function makeOptions(overrides: Partial<AgentRuntimeOptions> = {}): AgentRuntimeOptions & {
  events: AgentEvent[];
} {
  const events: AgentEvent[] = [];
  return {
    baseUrl: "http://localhost",
    apiKey: "k",
    standard: "openai" as const,
    modelId: "m",
    preset: PRESET,
    messages: [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "go" },
    ],
    toolContext: { projectPath: "/p", loreIndex: LORE_INDEX, multimodal: false },
    signal: new AbortController().signal,
    onEvent: (e: AgentEvent) => void events.push(e),
    onOutputText: () => {},
    events,
    ...overrides,
  };
}

/** Queue one streamCompletion round: emits the given chunks, resolves. */
function queueRound(chunks: Array<Record<string, unknown>>): void {
  mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
    for (const c of chunks) opts.onChunk(c as never);
  });
}

const call = (id: string, name: string) => ({ index: 0, id, name, arguments: "{}" });

/** Ids the gated executor has dispatched, in dispatch order. */
let started: string[] = [];
/** One manually-resolved gate per dispatched call, keyed by id. */
let gates: Map<string, (r: ToolResult) => void>;

/** Every dispatched call blocks until its gate is released with a result. */
function gateExecutor(): void {
  mockExec.mockImplementation((tc) => {
    started.push(tc.id);
    return new Promise<ToolResult>((resolve) => gates.set(tc.id, resolve));
  });
}

const release = (id: string, content: string) => {
  gates.get(id)!({ toolCallId: id, content });
};

/** Give in-flight lanes a beat, then check a condition that should now hold. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(cond()).toBe(true);
}

/** Flush timers/microtasks so anything that WOULD dispatch has had the chance. */
const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  mockStream.mockReset();
  mockExec.mockReset();
  started = [];
  gates = new Map();
});

describe("parallel tool execution", () => {
  it("overlaps a round's read calls and keeps history in call order", async () => {
    queueRound([
      { toolCalls: [call("c1", "read_file"), call("c2", "read_file")] },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    queueRound([{ text: "done" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    gateExecutor();
    const opts = makeOptions();

    const run = runAgent(opts);
    // Both dispatched while NEITHER has resolved — that is the overlap.
    await until(() => started.length === 2);
    expect(started).toEqual(["c1", "c2"]);

    // Settle out of order; the transcript must not care.
    release("c2", "r2");
    release("c1", "r1");
    await run;

    const toolMsgs = opts.messages
      .filter((m) => m.role === "tool")
      .map((m) => [m.tool_call_id, m.content]);
    expect(toolMsgs).toEqual([
      ["c1", "r1"],
      ["c2", "r2"],
    ]);
  });

  it("runs a write call as a barrier: alone, between the reads around it", async () => {
    queueRound([
      { toolCalls: [call("c1", "read_file"), call("c2", "task_plan"), call("c3", "read_file")] },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    queueRound([{ text: "done" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    gateExecutor();
    const opts = makeOptions();

    const run = runAgent(opts);
    await until(() => started.includes("c1"));
    await settle();
    // The write waits for the read before it, and the read after waits for the write.
    expect(started).toEqual(["c1"]);

    release("c1", "r1");
    await until(() => started.includes("c2"));
    await settle();
    expect(started).toEqual(["c1", "c2"]);

    release("c2", "planned");
    await until(() => started.includes("c3"));
    release("c3", "r3");
    await run;

    const toolMsgs = opts.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(toolMsgs).toEqual(["c1", "c2", "c3"]);
  });

  it("stubs the calls an abort caught still queued behind the lane cap", async () => {
    // Six reads against four lanes: c1–c4 dispatch, c5/c6 queue. Aborting then
    // must answer all six — the four in flight with whatever they return, the
    // two queued with the aborted stub — or the transcript wedges permanently.
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
    queueRound([
      { toolCalls: ids.map((id) => call(id, "read_file")) },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    gateExecutor();
    const ctrl = new AbortController();
    const opts = makeOptions({ signal: ctrl.signal });

    const run = runAgent(opts);
    await until(() => started.length === 4);
    expect(started).toEqual(["c1", "c2", "c3", "c4"]);

    ctrl.abort();
    for (const id of ["c1", "c2", "c3", "c4"]) release(id, `r-${id}`);

    await expect(run).rejects.toMatchObject({ name: "AbortError" });

    const replies = new Map(
      opts.messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content]),
    );
    expect([...replies.keys()].sort()).toEqual(ids);
    expect(replies.get("c4")).toBe("r-c4");
    expect(replies.get("c5")).toContain("not run");
    expect(replies.get("c6")).toContain("not run");
    // The stubbed pair never reached the executor.
    expect(started).toEqual(["c1", "c2", "c3", "c4"]);
  });
});

describe("isParallelSafeTool", () => {
  it("derives the boundary from the access tier", () => {
    // Read tier — including delegate, the expensive one this exists for.
    expect(isParallelSafeTool("read_file")).toBe(true);
    expect(isParallelSafeTool("read_lore_entity")).toBe(true);
    expect(isParallelSafeTool("delegate")).toBe(true);
    // Both write tiers are barriers.
    expect(isParallelSafeTool("task_plan")).toBe(false);
    expect(isParallelSafeTool("create_lore_entity")).toBe(false);
    expect(isParallelSafeTool("propose_edit")).toBe(false);
    expect(isParallelSafeTool("generate_image")).toBe(false);
    // Unknown names never execute anything, so they are safe to answer in parallel.
    expect(isParallelSafeTool("no_such_tool")).toBe(true);
  });
});
