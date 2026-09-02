/**
 * Structured-output helper tests: forced tool path, JSON fallback for models
 * that reject tool_choice, and error passthrough for real failures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamOptions, ToolDefinition } from "../ai/types";
import { runStructuredTask, type StructuredTaskArgs } from "../agent/structured";
import { __resetJsonModeMemo } from "../ai/jsonMode";

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
  __resetJsonModeMemo();
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

  it("enforces the output schema on the fallback when the model takes strict json_schema mode", async () => {
    // The whole point of the per-model declaration: a thinking model that
    // refuses forced tool_choice used to fall back to "valid JSON, shape in
    // prose". With json_schema it falls back to the same schema the tool path
    // would have enforced — and the nulls strict mode requires come back out.
    mockStream.mockImplementationOnce(async () => {
      throw new Error("Thinking mode does not support this tool_choice");
    });
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      opts.onChunk({ text: '{"name":"Ava","note":null}' });
      opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
    });

    const tool: ToolDefinition = {
      ...OUTPUT_TOOL,
      function: {
        ...OUTPUT_TOOL.function,
        parameters: {
          type: "object",
          properties: { name: { type: "string" }, note: { type: "string" } },
          required: ["name"],
        },
      },
    };
    const result = await runStructuredTask(makeArgs({ modelId: "qwen3.8-max", outputTool: tool }));

    expect(JSON.parse(result)).toEqual({ name: "Ava" });
    const second = mockStream.mock.calls[1][0];
    expect(second.extraBody).toEqual({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "emit_result",
          strict: true,
          schema: {
            type: "object",
            properties: { name: { type: "string" }, note: { type: ["string", "null"] } },
            required: ["name", "note"],
            additionalProperties: false,
          },
        },
      },
    });
    // Strict mode has no "json" precondition, so no cue turn is appended.
    expect(second.messages).toHaveLength(2);
  });

  it("steps json_schema down to json_object when the endpoint rejects it, and remembers", async () => {
    // Forced tool refused → fallback in json_schema → the endpoint says it
    // does not take that either → one more request in json_object, which is
    // where the model's next structured task starts.
    mockStream.mockImplementationOnce(async () => {
      throw new Error("Thinking mode does not support this tool_choice");
    });
    mockStream.mockImplementationOnce(async () => {
      throw new Error("400 Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.");
    });
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      opts.onChunk({ text: '{"name":"Ava"}' });
      opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
    });

    const args = makeArgs({ modelId: "qwen3.8-max", baseUrl: "https://relay/v1" });
    expect(JSON.parse(await runStructuredTask(args))).toEqual({ name: "Ava" });
    expect(mockStream).toHaveBeenCalledTimes(3);
    expect(mockStream.mock.calls[1][0].extraBody).toMatchObject({ response_format: { type: "json_schema" } });
    expect(mockStream.mock.calls[2][0].extraBody).toEqual({ response_format: { type: "json_object" } });

    // Second task on the same endpoint+model: no json_schema attempt at all.
    mockStream.mockReset();
    mockStream.mockImplementationOnce(async () => {
      throw new Error("Thinking mode does not support this tool_choice");
    });
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      opts.onChunk({ text: '{"name":"Kael"}' });
      opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
    });
    await runStructuredTask(args);
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(mockStream.mock.calls[1][0].extraBody).toEqual({ response_format: { type: "json_object" } });
  });

  it("sends no JSON parameter on the fallback when the model's declaration is off", async () => {
    mockStream.mockImplementationOnce(async () => {
      throw new Error("Thinking mode does not support this tool_choice");
    });
    mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
      opts.onChunk({ text: '{"name":"Ava"}' });
      opts.onChunk({ done: true, inputTokens: 1, outputTokens: 1 });
    });

    await runStructuredTask(makeArgs({ modelId: "qwen3.8-max", structuredOutput: "off" }));

    const second = mockStream.mock.calls[1][0];
    expect(second.extraBody).toBeUndefined();
    // The cue is the whole mechanism now, so it is always there.
    expect(second.messages).toHaveLength(3);
  });

  it("does not fall back on a genuine malformed-call error that happens to contain \"function call\"", async () => {
    mockStream.mockImplementationOnce(async () => {
      throw new Error("Invalid function call: missing required argument 'name'");
    });

    await expect(runStructuredTask(makeArgs())).rejects.toThrow("Invalid function call");
    expect(mockStream).toHaveBeenCalledTimes(1);
  });
});
