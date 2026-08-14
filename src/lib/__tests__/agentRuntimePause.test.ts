import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../agent/events";
import type { TaskPreset } from "../agent/presets";
import { runAgent, type AgentRuntimeOptions } from "../agent/runtime";
import type { StreamChunk, StreamOptions } from "../ai/types";

vi.mock("../ai", () => ({ streamCompletion: vi.fn() }));
import { streamCompletion } from "../ai";
const mockStream = vi.mocked(streamCompletion);

const PRESET: TaskPreset = {
  id: "test-pause",
  tools: ["list_lore_entities", "read_lore_entity"],
  maxRounds: 2,
  finishPolicy: "force-text",
};

describe("agentRuntime pause on round-limit", () => {
  let roundQueue: StreamChunk[][] = [];

  function queueRound(chunks: StreamChunk[]) {
    roundQueue.push(chunks);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    roundQueue = [];
    mockStream.mockImplementation(async (opts: StreamOptions) => {
      const chunks = roundQueue.shift();
      if (!chunks) throw new Error("mockStream: no more queued rounds");
      for (const c of chunks) opts.onChunk(c);
    });
  });

  it("exits cleanly with outcome 'paused' when author chooses pause at round limit", async () => {
    // Round 1 calls a tool
    queueRound([
      { toolCalls: [{ index: 0, id: "c1", name: "list_lore_entities", arguments: "{}" }] },
      { done: true, inputTokens: 50, outputTokens: 20, cachedTokens: 10 },
    ]);

    const events: AgentEvent[] = [];
    const output: string[] = [];
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "start long task" },
    ];

    const opts: AgentRuntimeOptions = {
      baseUrl: "http://localhost",
      apiKey: "k",
      standard: "openai",
      modelId: "m",
      preset: PRESET,
      messages,
      toolContext: { projectPath: "/p", loreIndex: {}, multimodal: false },
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      onOutputText: (t) => output.push(t),
      onRoundLimit: async (roundsUsed) => {
        expect(roundsUsed).toBe(1);
        return { action: "pause" };
      },
    };

    const res = await runAgent(opts);

    expect(res.outcome).toBe("paused");
    expect(res.rounds).toBe(1);
    expect(res.inputTokens).toBe(50);
    expect(res.outputTokens).toBe(20);
    expect(res.cachedTokens).toBe(10);

    // round-limit event is recorded with decision: { action: 'pause' }
    const limitEvent = events.find((e) => e.kind === "round-limit");
    expect(limitEvent).toBeDefined();
    if (limitEvent && limitEvent.kind === "round-limit") {
      expect(limitEvent.decision).toEqual({ action: "pause" });
    }

    // Message pairing remains valid: assistant's tool call followed by tool result
    expect(messages.length).toBe(4);
    expect(messages[2].role).toBe("assistant");
    expect(messages[3].role).toBe("tool");
  });
});
