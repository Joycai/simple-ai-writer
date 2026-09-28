/**
 * The JSON path of a structured task, through the real `streamCompletion` with
 * only `fetch` stubbed — the shaping is `streamCompletion`'s now (capability-
 * resolution-lld P7), so asserting on what `runStructuredTask` hands it would
 * test nothing. What is held: the output schema is enforced in strict mode
 * where the model takes it, and the nulls strict mode needs come back out; a
 * refused tier steps down once and the next task starts there; a model
 * declared off gets the cue alone, inside the user turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetLearned } from "../../ai/capability/learned";
import { JSON_ONLY_CUE } from "../../ai/jsonMode";
import type { ToolDefinition } from "../../ai/types";
import { runStructuredTask, type StructuredTaskArgs } from "../structured";

function sse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(encoder.encode(l));
      c.close();
    },
  }), { status: 200 });
}
const text = (t: string) => () => sse([`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n`, "data: [DONE]\n"]);
const refuse = (msg: string) => () => new Response(msg, { status: 400 });
const refuseChoice = refuse("Thinking mode does not support this tool_choice");
const refuseSchema = refuse("Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.");

/** Answer each request with the next reply (the last one repeats); record every body. */
function script(replies: (() => Response)[]) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return replies[Math.min(bodies.length - 1, replies.length - 1)]();
  }));
  return bodies;
}

const TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "emit_result",
    description: "Emit the structured result.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, note: { type: "string" } },
      required: ["name"],
    },
  },
};

function makeArgs(overrides: Partial<StructuredTaskArgs> = {}): StructuredTaskArgs {
  return {
    baseUrl: "https://relay/v1", apiKey: "k", standard: "openai_compat", platform: "dashscope", modelId: "qwen3.8-max",
    systemPrompt: "base prompt", toolInstruction: "Call emit_result once.", jsonInstruction: "Respond with only the result.",
    outputTool: TOOL, userContent: "go",
    ...overrides,
  };
}

const format = (b: Record<string, unknown>) => b.response_format as { type?: string } | undefined;
const messages = (b: Record<string, unknown>) => b.messages as { role: string; content: unknown }[];

beforeEach(() => __resetLearned());
afterEach(() => vi.unstubAllGlobals());

describe("the structured task's JSON path", () => {
  it("enforces the output schema in strict mode on a model that takes it, and takes the nulls back out", async () => {
    // Forced tool refused → re-sent under auto, which the model answers in
    // prose → the JSON path, in json_schema.
    const bodies = script([refuseChoice, text('{"name":"Ava","note":null}')]);

    expect(JSON.parse(await runStructuredTask(makeArgs()))).toEqual({ name: "Ava" });
    expect(bodies.map((b) => b.tool_choice)).toEqual(["required", "auto", undefined]);
    expect(bodies[2].response_format).toEqual({
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
    });
    // Strict mode has no "json" precondition, so no cue.
    expect(messages(bodies[2])).toEqual([
      { role: "system", content: "base prompt\nRespond with only the result." },
      { role: "user", content: "go" },
    ]);
  });

  it("steps json_schema down to json_object when the endpoint refuses it, and the next task starts there", async () => {
    const bodies = script([refuseChoice, text('{"name":"Ava"}'), refuseSchema, text('{"name":"Ava"}')]);
    expect(JSON.parse(await runStructuredTask(makeArgs()))).toEqual({ name: "Ava" });
    expect(bodies.slice(2).map((b) => format(b)?.type)).toEqual(["json_schema", "json_object"]);

    // Forcing is refused and strict mode is gone: the tool is tried under auto,
    // then the JSON path goes straight to json_object.
    const next = script([text('{"name":"Kael"}')]);
    expect(JSON.parse(await runStructuredTask(makeArgs()))).toEqual({ name: "Kael" });
    expect(next.map((b) => b.tool_choice)).toEqual(["auto", undefined]);
    expect(format(next[1])?.type).toBe("json_object");
  });

  it("goes straight to strict JSON when forcing is predictably downgraded, and still takes the nulls out", async () => {
    // Qwen thinking: the forced tool would go out as auto, and json_schema is
    // in hand — so one request, on the JSON path.
    const bodies = script([text('{"name":"Ava","note":null}')]);
    const out = await runStructuredTask(makeArgs({ thinkingCategory: "qwen-budget", reasoningEffort: "high" }));
    expect(JSON.parse(out)).toEqual({ name: "Ava" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools).toBeUndefined();
    expect(format(bodies[0])?.type).toBe("json_schema");
  });

  it("sends no JSON field when the model's declaration is off — the cue alone, at the end of the user turn", async () => {
    const bodies = script([refuseChoice, text('{"name":"Ava"}')]);
    await runStructuredTask(makeArgs({ structuredOutput: "off" }));
    const json = bodies[2];
    expect(format(json)).toBeUndefined();
    expect(messages(json)).toHaveLength(2);
    expect(messages(json)[1]).toEqual({ role: "user", content: `go\n\n${JSON_ONLY_CUE}` });
  });
});
