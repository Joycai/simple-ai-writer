/**
 * Structured-output helper tests: forced tool path, JSON fallback for models
 * that reject tool_choice, and error passthrough for real failures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamOptions, ToolDefinition } from "../../ai/types";
import { runStructuredTask, type StructuredTaskArgs } from "../structured";
import { __resetLearned, noteLearned } from "../../ai/capability/learned";

vi.mock("../../ai", () => ({ streamCompletion: vi.fn() }));
import { streamCompletion } from "../../ai";
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
  __resetLearned();
});

describe("runStructuredTask", () => {
  it("returns the forced tool call's arguments", async () => {
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      opts.onChunk({ toolCalls: [{ index: 0, id: "c1", name: "emit_result", arguments: '{"name":"Ava"}' }] });
      opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
      return {};
    });

    const result = await runStructuredTask(makeArgs());

    expect(result).toBe('{"name":"Ava"}');
    const call = mockStream.mock.calls[0][0];
    // "required", not the named form: only one tool is offered, so the two say
    // the same thing — and ollama silently ignores the named form, answering
    // with prose and no tool call at all (see structured.ts).
    expect(call.toolChoice).toBe("required");
    expect(call.tools).toHaveLength(1);
    expect((call.messages[0] as { content: string }).content).toContain("Call emit_result once.");
  });

  it("falls back to plain JSON when the model rejects tool_choice", async () => {
    mockStream.mockImplementationOnce(async () => {
      throw new Error("This model does not support tool_choice in thinking mode");
    });
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      opts.onChunk({ text: 'Sure: {"name":"Ava"} there you go' });
      opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
      return {};
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
      return {};
    });
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      opts.onChunk({ text: '{"name":"Kael"}' });
      opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
      return {};
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

  it("falls back on assorted real-world capability-error phrasings", async () => {
    const phrasings = [
      "This model does not support function calling",
      "Tool calls not supported",
      "Function calling is not supported for this model",
      "Invalid value for 'tool_choice': tool_choice is not supported for this model",
    ];
    for (const message of phrasings) {
      mockStream.mockReset();
      mockStream.mockImplementationOnce(async () => {
        throw new Error(message);
      });
      mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
        opts.onChunk({ text: '{"name":"Ava"}' });
        opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
        return {};
      });

      const result = await runStructuredTask(makeArgs());

      expect(JSON.parse(result)).toEqual({ name: "Ava" });
      expect(mockStream).toHaveBeenCalledTimes(2);
    }
  });

  it("does not fall back on a generic 'does not support' error unrelated to tool calling", async () => {
    // e.g. "This model does not support streaming for your region" — a real,
    // unrelated failure that used to be misread as a capability error and
    // silently retried as a different-shaped request instead of surfaced.
    mockStream.mockImplementationOnce(async () => {
      throw new Error("This model does not support streaming for your region");
    });

    await expect(runStructuredTask(makeArgs())).rejects.toThrow("does not support streaming");
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on a genuine malformed-call error that happens to contain \"function call\"", async () => {
    mockStream.mockImplementationOnce(async () => {
      throw new Error("Invalid function call: missing required argument 'name'");
    });

    await expect(runStructuredTask(makeArgs())).rejects.toThrow("Invalid function call");
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  describe("skipping the forced-tool attempt", () => {
    const qwenThinking = {
      // DashScope: the platform whose compatible-mode is measured to take json_schema.
      modelId: "qwen3.8-max", baseUrl: "https://relay/v1", standard: "openai_compat" as const, platform: "dashscope" as const,
      thinkingCategory: "qwen-budget" as const, reasoningEffort: "high" as const,
    };

    it("goes straight to strict JSON when the downgrade is predictable and json_schema is available", async () => {
      // Qwen with thinking on downgrades a forced tool_choice to `auto`
      // (forcesToolChoiceAuto); with json_schema in hand the tool attempt buys
      // nothing, so it is one request, not two.
      mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
        opts.onChunk({ text: '{"name":"Ava"}' });
        opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
        return {};
      });

      expect(JSON.parse(await runStructuredTask(makeArgs(qwenThinking)))).toEqual({ name: "Ava" });
      expect(mockStream).toHaveBeenCalledTimes(1);
      const only = mockStream.mock.calls[0][0];
      expect(only.tools).toBeUndefined();
      expect(only.structured).toEqual({ schema: OUTPUT_TOOL.function });
    });

    it("still tries the tool when only json_object would be available", async () => {
      // Under `auto` the model may well call the tool, and a tool call beats
      // JSON mode's "valid JSON, shape in prose" — worth the attempt.
      mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
        opts.onChunk({ toolCalls: [{ index: 0, id: "c1", name: "emit_result", arguments: '{"name":"Ava"}' }] });
        opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
        return {};
      });
      await runStructuredTask(makeArgs({ ...qwenThinking, modelId: "qwen-plus" }));
      expect(mockStream).toHaveBeenCalledTimes(1);
      expect(mockStream.mock.calls[0][0].tools).toHaveLength(1);
    });

    it("still tries the tool when thinking is off, where forcing is legal", async () => {
      mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
        opts.onChunk({ toolCalls: [{ index: 0, id: "c1", name: "emit_result", arguments: '{"name":"Ava"}' }] });
        opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
        return {};
      });
      await runStructuredTask(makeArgs({ ...qwenThinking, reasoningEffort: "off" }));
      expect(mockStream.mock.calls[0][0].tools).toHaveLength(1);
    });

    it("also skips once this endpoint has said with a 400 that forcing is illegal", async () => {
      // DeepSeek V4's shape: nothing in the config predicts it, the memo does.
      const ds = { modelId: "gpt-5", baseUrl: "https://relay/v1", standard: "openai_compat" as const, platform: "openai" as const };
      noteLearned(ds, "forcedToolChoice", false);
      mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
        opts.onChunk({ text: '{"name":"Ava"}' });
        opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
        return {};
      });
      await runStructuredTask(makeArgs(ds));
      expect(mockStream).toHaveBeenCalledTimes(1);
      expect(mockStream.mock.calls[0][0].tools).toBeUndefined();
    });

    // The table's cell is a reason too (capability-resolution-lld.md B4): a
    // relay upstream that takes forcing with a 200 and ignores it, on a wire
    // whose JSON path has the strict tier. The skip used to see only the
    // category and the learned store, and ran the forced round to lose it.
    it.each([
      ["Kiro's Claude on the Messages route, strict declared", {
        standard: "anthropic_compat", platform: "newapi", modelId: "[x]claude-opus-4-6", relayUpstream: "kiro",
        structuredOutput: "json_schema",
      }],
      ["anti's Claude on Chat Completions, strict declared", {
        standard: "openai_compat", platform: "newapi", modelId: "[x]claude-opus-4-6", relayUpstream: "anti",
        structuredOutput: "json_schema",
      }],
      ["Azure's GPT on Chat Completions, strict by auto", {
        standard: "openai_compat", platform: "newapi", modelId: "gpt-5.6-sol", relayUpstream: "azure",
      }],
    ] as const)("also skips where the table says forcing is ignored: %s", async (_label, conn) => {
      mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
        opts.onChunk({ text: '{"name":"Ava"}' });
        opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
        return {};
      });
      await runStructuredTask(makeArgs({ ...conn, baseUrl: "https://relay.example/v1" }));
      expect(mockStream).toHaveBeenCalledTimes(1);
      expect(mockStream.mock.calls[0][0].tools).toBeUndefined();
    });

    it("stops skipping once the endpoint has also refused json_schema", async () => {
      // Both ceilings say no: forcing is downgraded and strict mode is gone, so
      // the tool attempt under `auto` is again the stronger bet.
      noteLearned(qwenThinking, "forcedToolChoice", false);
      noteLearned(qwenThinking, "structuredOutput", "json_object");
      mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
        opts.onChunk({ toolCalls: [{ index: 0, id: "c1", name: "emit_result", arguments: '{"name":"Ava"}' }] });
        opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
        return {};
      });
      // A category that does not predict the downgrade, so only the ceilings decide.
      await runStructuredTask(makeArgs({ ...qwenThinking, thinkingCategory: "openai-generic" }));
      expect(mockStream.mock.calls[0][0].tools).toHaveLength(1);
    });
  });
});
