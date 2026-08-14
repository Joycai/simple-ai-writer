import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../agent/events";
import type { TaskPreset } from "../agent/presets";
import { runAgent, type AgentRuntimeOptions } from "../agent/runtime";
import type { StreamMessage, StreamOptions } from "../ai/types";

vi.mock("../ai", () => ({ streamCompletion: vi.fn() }));
import { streamCompletion } from "../ai";
const mockStream = vi.mocked(streamCompletion);

const SCRATCHPAD_PRESET: TaskPreset = {
  id: "test-scratchpad",
  tools: ["write_note", "read_note"],
  maxRounds: 4,
  finishPolicy: "force-text",
  scratchpad: "required",
};

describe("agentRuntime scratchpad checkpoint notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects checkpoint notice when token usage reaches ceiling * 0.85, and retracts it immediately after the request", async () => {
    let sawCheckpointNoticeDuringCall = false;

    mockStream.mockImplementation(async (opts: StreamOptions) => {
      sawCheckpointNoticeDuringCall = opts.messages.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("即将触发裁剪"),
      );
      opts.onChunk({ text: "I have recorded my findings." });
      opts.onChunk({ done: true, inputTokens: 500, outputTokens: 100 });
    });

    const messages: StreamMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "x".repeat(3000) }, // heavy context
    ];

    const events: AgentEvent[] = [];
    const opts: AgentRuntimeOptions = {
      baseUrl: "http://localhost",
      apiKey: "k",
      standard: "openai",
      modelId: "m",
      preset: SCRATCHPAD_PRESET,
      messages,
      toolContext: { projectPath: "/p", loreIndex: {}, multimodal: false },
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      onOutputText: () => {},
      inputCeilingTokens: 600, // will easily exceed 600 * 0.85 = 510 tokens estimate
    };

    const res = await runAgent(opts);
    expect(res.rounds).toBe(1);

    // During the call, the checkpoint prompt was present
    expect(sawCheckpointNoticeDuringCall).toBe(true);

    // After the call finishes, checkpointNotice was retracted from persistent history!
    const noticeInHistoryAfter = messages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("即将触发裁剪"),
    );
    expect(noticeInHistoryAfter).toBe(false);
  });

  it("does not inject checkpoint notice when preset has scratchpad = 'off'", async () => {
    let sawCheckpointNotice = false;

    mockStream.mockImplementation(async (opts: StreamOptions) => {
      sawCheckpointNotice = opts.messages.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("即将触发裁剪"),
      );
      opts.onChunk({ text: "Done without scratchpad." });
      opts.onChunk({ done: true, inputTokens: 500, outputTokens: 100 });
    });

    const presetOff: TaskPreset = {
      ...SCRATCHPAD_PRESET,
      scratchpad: "off",
    };

    const messages: StreamMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "x".repeat(3000) },
    ];

    const opts: AgentRuntimeOptions = {
      baseUrl: "http://localhost",
      apiKey: "k",
      standard: "openai",
      modelId: "m",
      preset: presetOff,
      messages,
      toolContext: { projectPath: "/p", loreIndex: {}, multimodal: false },
      signal: new AbortController().signal,
      onEvent: () => {},
      onOutputText: () => {},
      inputCeilingTokens: 600,
    };

    await runAgent(opts);
    expect(sawCheckpointNotice).toBe(false);
  });
});
