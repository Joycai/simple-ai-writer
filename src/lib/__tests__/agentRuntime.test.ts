/**
 * Agent runtime tests — the tool loop with a mocked streaming client.
 * Verifies event emission (execution log), the tool-call/result message
 * protocol, per-preset round caps, and the force-text final round.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamOptions } from "../ai/types";
import type { AgentEvent } from "../agent/events";
import type { TaskPreset } from "../agent/presets";
import { runAgent, type AgentRuntimeOptions } from "../agent/runtime";
import type { LoreIndex } from "../lore";

vi.mock("../ai", () => ({ streamCompletion: vi.fn() }));
import { streamCompletion } from "../ai";
const mockStream = vi.mocked(streamCompletion);

const LORE_INDEX = {
  characters: [
    { name: "Ava", summary: "the protagonist", dirPath: "/p/.ai-writer/lore/characters/ava", images: [] },
  ],
  world: [],
} as unknown as LoreIndex;

const PRESET: TaskPreset = {
  id: "test",
  tools: ["list_lore_entities", "read_lore_entity", "list_files", "read_file"],
  maxRounds: 8,
  finishPolicy: "force-text",
};

function makeOptions(overrides: Partial<AgentRuntimeOptions> = {}): AgentRuntimeOptions & {
  events: AgentEvent[];
  output: string[];
} {
  const events: AgentEvent[] = [];
  const output: string[] = [];
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
    onOutputChunk: (t: string) => void output.push(t),
    events,
    output,
    ...overrides,
  };
}

/** Queue one streamCompletion round: emits the given chunks, resolves. */
function queueRound(chunks: Array<Record<string, unknown>>): void {
  mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
    for (const c of chunks) opts.onChunk(c as never);
  });
}

beforeEach(() => {
  mockStream.mockReset();
});

describe("runAgent", () => {
  it("finishes on a text-only round and reports usage", async () => {
    queueRound([{ text: "hello " }, { text: "world" }, { done: true, inputTokens: 10, outputTokens: 5 }]);
    const opts = makeOptions();

    const result = await runAgent(opts);

    expect(result).toEqual({ rounds: 1, inputTokens: 10, outputTokens: 5 });
    expect(opts.output.join("")).toBe("hello world");
    // Exactly one round-start, no tool steps
    expect(opts.events.map((e) => e.kind)).toEqual(["round-start"]);
    const round = opts.events[0] as Extract<AgentEvent, { kind: "round-start" }>;
    expect(round.round).toBe(1);
    expect(round.maxRounds).toBe(8);
    expect(round.estInputTokens).toBeGreaterThan(0);
  });

  it("executes a tool round, appends protocol messages, then finishes", async () => {
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      { done: true, inputTokens: 8, outputTokens: 2 },
    ]);
    queueRound([{ text: "done" }, { done: true, inputTokens: 20, outputTokens: 7 }]);
    const opts = makeOptions();

    const result = await runAgent(opts);

    expect(result).toEqual({ rounds: 2, inputTokens: 28, outputTokens: 9 });

    // Event order: round 1, tool running, tool done, round 2
    expect(opts.events.map((e) => e.kind)).toEqual([
      "round-start", "tool-step", "tool-step", "round-start",
    ]);
    const doneStep = opts.events[2] as Extract<AgentEvent, { kind: "tool-step" }>;
    expect(doneStep.step.status).toBe("done");
    expect(doneStep.step.resultSummary).toContain("Ava");

    // History protocol: assistant tool_calls + matching tool result appended
    const history = opts.messages;
    expect(history).toHaveLength(4);
    const assistant = history[2] as { role: string; tool_calls: Array<{ id: string }> };
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls[0].id).toBe("c1");
    const toolMsg = history[3] as { role: string; tool_call_id: string; content: string };
    expect(toolMsg).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(toolMsg.content).toContain("Ava");

    // Round 2's request carried the grown history and still offered tools
    const secondCall = mockStream.mock.calls[1][0];
    expect(secondCall.messages).toBe(history);
    expect(secondCall.tools).toHaveLength(4);
  });

  it("reports a tool-step error for unknown tools and lets the model retry", async () => {
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "no_such_tool", arguments: "{}" }] },
      { done: true, inputTokens: 1, outputTokens: 1 },
    ]);
    queueRound([{ text: "ok" }, { done: true, inputTokens: 1, outputTokens: 1 }]);
    const opts = makeOptions();

    await runAgent(opts);

    const errStep = opts.events.find(
      (e): e is Extract<AgentEvent, { kind: "tool-step" }> =>
        e.kind === "tool-step" && e.step.status === "error",
    );
    expect(errStep?.step.resultSummary).toContain("Unknown tool");
    // The error still went back as a protocol-valid tool message
    const toolMsg = opts.messages[3] as { role: string; content: string };
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toContain("Unknown tool");
  });

  it("withholds tools and forces text on the final round of a force-text preset", async () => {
    queueRound([{ text: "forced" }, { done: true, inputTokens: 3, outputTokens: 3 }]);
    const opts = makeOptions({ preset: { ...PRESET, maxRounds: 1 } });

    await runAgent(opts);

    const call = mockStream.mock.calls[0][0];
    expect(call.tools).toBeUndefined();
    const last = opts.messages[opts.messages.length - 1] as { role: string; content: string };
    // The "write now" instruction was injected before the request
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("without calling any more tools");
  });

  it("sends no tool definitions for an empty (single-shot) toolset", async () => {
    queueRound([{ text: "plain" }, { done: true, inputTokens: 2, outputTokens: 2 }]);
    const opts = makeOptions({
      preset: { id: "single", tools: [], maxRounds: 1, finishPolicy: "force-text" },
    });

    await runAgent(opts);

    const call = mockStream.mock.calls[0][0];
    expect(call.tools).toBeUndefined();
    // No forced-write injection for a toolless task — the seeded turns are untouched
    expect(opts.messages).toHaveLength(2);
  });

  it("throws AbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const opts = makeOptions({ signal: controller.signal });

    await expect(runAgent(opts)).rejects.toMatchObject({ name: "AbortError" });
    expect(mockStream).not.toHaveBeenCalled();
  });
});
