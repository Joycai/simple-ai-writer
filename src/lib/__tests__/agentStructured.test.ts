/**
 * Structured-output helper tests: forced tool path, JSON fallback for models
 * that reject tool_choice, and error passthrough for real failures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamOptions, ToolDefinition } from "../ai/types";
import { runStructuredTask, type StructuredTaskArgs } from "../agent/structured";

vi.mock("../ai", () => ({ streamCompletion: vi.fn() }));
import { streamCompletion } from "../ai";
const mockStream = vi.mocked(streamCompletion);

const OUTPUT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "emit_result",
    description: "Emit the structured result.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
};

function makeArgs(overrides: Partial<StructuredTaskArgs> = {}): StructuredTaskArgs {
  return {
    baseUrl: "http://localhost",
    apiKey: "k",
    standard: "openai",
    modelId: "m",
    systemPrompt: "base prompt",
    toolInstruction: "Call emit_result once.",
    jsonInstruction: "Respond with only JSON.",
    outputTool: OUTPUT_TOOL,
    userContent: "go",
    ...overrides,
  };
}

beforeEach(() => {
  mockStream.mockReset();
});

describe("runStructuredTask", () => {
  it("returns the forced tool call's arguments", async () => {
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      opts.onChunk({ toolCalls: [{ index: 0, id: "c1", name: "emit_result", arguments: '{"name":"Ava"}' }] });
      opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
    });

    const result = await runStructuredTask(makeArgs());

    expect(result).toBe('{"name":"Ava"}');
    const call = mockStream.mock.calls[0][0];
    expect(call.toolChoice).toEqual({ type: "function", function: { name: "emit_result" } });
    expect((call.messages[0] as { content: string }).content).toContain("Call emit_result once.");
  });

  it("falls back to plain JSON when the model rejects tool_choice", async () => {
    mockStream.mockImplementationOnce(async () => {
      throw new Error("This model does not support tool_choice in thinking mode");
    });
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      opts.onChunk({ text: 'Sure: {"name":"Ava"} there you go' });
      opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
    });

    const result = await runStructuredTask(makeArgs());

    expect(JSON.parse(result)).toEqual({ name: "Ava" });
    // Fallback request: no tools, JSON instruction in the system prompt
    const second = mockStream.mock.calls[1][0];
    expect(second.tools).toBeUndefined();
    expect((second.messages[0] as { content: string }).content).toContain("Respond with only JSON.");
  });

  it("falls back when the model returns no tool call at all", async () => {
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      opts.onChunk({ text: "I refuse to call tools" });
      opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
    });
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      opts.onChunk({ text: '{"name":"Kael"}' });
      opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
    });

    expect(JSON.parse(await runStructuredTask(makeArgs()))).toEqual({ name: "Kael" });
  });

  it("surfaces real errors without falling back", async () => {
    mockStream.mockImplementationOnce(async () => {
      throw new Error("401 invalid api key");
    });

    await expect(runStructuredTask(makeArgs())).rejects.toThrow("401");
    expect(mockStream).toHaveBeenCalledTimes(1);
  });
});
