/**
 * `streamCompletion` as the one fallback executor (capability-resolution-lld
 * §3.7, P7). What is held, through the real adapters with only `fetch` stubbed:
 * a refusal of something the request carried is learned and the request is
 * planned again one step down; anything else surfaces as it came; nothing is
 * retried after the first chunk; every retry is paid for by a ceiling that
 * strictly went down, so the loop ends; and the JSON shaping lands where the
 * plan says — fields in the body, the cue in the last user turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamCompletion } from "../index";
import { __resetLearned, learnedCeiling, noteLearned, STRUCTURED_RANK } from "../capability/learned";
import { JSON_ONLY_CUE, type StructuredOutputMode } from "../jsonMode";
import type { StreamMessage, StreamOptions, ToolDefinition } from "../types";

const OK = ['data: {"choices":[{"delta":{"content":"{}"}}]}\n', "data: [DONE]\n"];

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(encoder.encode(x));
      c.close();
    },
  }), { status: 200 });
}

type Reply = Response | (() => Response);
/** Answer each request with the next reply (the last one repeats); record every body. */
function script(replies: Reply[]) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const r = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return typeof r === "function" ? r() : r;
  }));
  return bodies;
}

const refuse = (text: string) => () => new Response(text, { status: 400 });
const refuseFormat = (mode: string) => refuse(`Invalid parameter: 'response_format' of type '${mode}' is not supported with this model.`);
const refuseChoice = refuse("Thinking mode does not support this tool_choice");
const ok = () => sse(OK);

const SCHEMA = { name: "emit", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } };
const TOOL: ToolDefinition = { type: "function", function: { name: "emit", description: "d", parameters: SCHEMA.parameters } };
// A DashScope relay row the catalog knows takes strict json_schema.
const QWEN = { standard: "openai_compat" as const, platform: "dashscope" as const, baseUrl: "https://relay/v1", modelId: "qwen3.8-max" };
const DEEPSEEK = { standard: "openai_compat" as const, baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash" };
const ASK: StreamMessage[] = [{ role: "system", content: "Reply in JSON." }, { role: "user", content: "Who?" }];

const run = (o: Partial<StreamOptions> & Pick<StreamOptions, "standard">) =>
  streamCompletion({ apiKey: "k", modelId: "m", baseUrl: "https://x/v1", messages: ASK, onChunk: () => {}, ...o } as StreamOptions);

const format = (b: Record<string, unknown>) => (b.response_format as { type?: string } | undefined)?.type ?? "none";

beforeEach(() => __resetLearned());
afterEach(() => vi.unstubAllGlobals());

describe("JSON tiers", () => {
  it("steps down one tier per refusal, reports where it landed, and the next request starts there", async () => {
    const bodies = script([refuseFormat("json_schema"), refuseFormat("json_object"), ok]);
    await expect(run({ ...QWEN, structured: { schema: SCHEMA } })).resolves.toEqual({ structured: "off" });
    expect(bodies.map(format)).toEqual(["json_schema", "json_object", "none"]);
    expect(learnedCeiling(QWEN, "structuredOutput")).toBe("off");

    const next = script([ok]);
    await expect(run({ ...QWEN, structured: { schema: SCHEMA } })).resolves.toEqual({ structured: "off" });
    expect(next.map(format)).toEqual(["none"]);
  });

  it("surfaces an error that is not about the parameter, once, without learning", async () => {
    const bodies = script([refuse("429 rate limited")]);
    await expect(run({ ...QWEN, structured: { schema: SCHEMA } })).rejects.toThrow("429");
    expect(bodies).toHaveLength(1);
    expect(learnedCeiling(QWEN, "structuredOutput")).toBeUndefined();
  });

  it("does not retry a request that carried no JSON field", async () => {
    const bodies = script([refuseFormat("json_object")]);
    await expect(run({ ...QWEN, structuredOutput: "off", structured: { schema: SCHEMA } })).rejects.toThrow("response_format");
    expect(bodies).toHaveLength(1);
  });

  it("still retries when a parallel request to the endpoint learned the refusal first", async () => {
    const bodies = script([
      () => {
        noteLearned(QWEN, "structuredOutput", "json_object");
        return refuseFormat("json_schema")();
      },
      ok,
    ]);
    await expect(run({ ...QWEN, structured: { schema: SCHEMA } })).resolves.toEqual({ structured: "json_object" });
    expect(bodies.map(format)).toEqual(["json_schema", "json_object"]);
  });

  it("does not retry after the first chunk", async () => {
    const bodies = script([() => sse([
      'data: {"choices":[{"delta":{"content":"{"}}]}\n',
      'data: {"error":{"message":"response_format rejected upstream"}}\n',
    ])]);
    await expect(run({ ...QWEN, structured: { schema: SCHEMA } })).rejects.toThrow("response_format");
    expect(bodies).toHaveLength(1);
    expect(learnedCeiling(QWEN, "structuredOutput")).toBeUndefined();
  });

  it("reports nothing for a request that did not ask for JSON", async () => {
    script([ok]);
    await expect(run({ ...QWEN })).resolves.toEqual({});
  });
});

describe("the cue", () => {
  // Declared off: no JSON field anywhere, the cue is the whole mechanism.
  const off = { ...QWEN, structuredOutput: "off" as const, structured: { schema: SCHEMA } };
  const lastUser = (b: Record<string, unknown>) => {
    const users = (b.messages as { role: string; content: unknown }[]).filter((m) => m.role === "user");
    return users[users.length - 1]?.content;
  };

  it("goes at the end of the last user turn when it is text", async () => {
    const bodies = script([ok]);
    await run(off);
    expect(lastUser(bodies[0])).toBe(`Who?\n\n${JSON_ONLY_CUE}`);
    expect((bodies[0].messages as unknown[]).length).toBe(2);
  });

  it("goes in as one more text part when the turn has parts", async () => {
    const bodies = script([ok]);
    await run({ ...off, messages: [{ role: "user", content: [{ type: "text", text: "Who?" }] }] });
    expect(lastUser(bodies[0])).toEqual([{ type: "text", text: "Who?" }, { type: "text", text: JSON_ONLY_CUE }]);
  });

  it("becomes the user turn when there is none", async () => {
    const bodies = script([ok]);
    await run({ ...off, messages: [{ role: "system", content: "Reply." }] });
    expect(lastUser(bodies[0])).toBe(JSON_ONLY_CUE);
  });

  it("is left out when the prompt already says json and native JSON mode is on", async () => {
    const bodies = script([ok]);
    await run({ ...QWEN, modelId: "some-unknown-model", structured: { schema: SCHEMA } });
    expect(format(bodies[0])).toBe("json_object");
    expect(lastUser(bodies[0])).toBe("Who?");
  });
});

describe("forced tool_choice", () => {
  it("re-sends a refused forced choice as auto, and later requests go out as auto", async () => {
    const bodies = script([refuseChoice, ok]);
    await run({ ...DEEPSEEK, tools: [TOOL], toolChoice: "required" });
    expect(bodies.map((b) => b.tool_choice)).toEqual(["required", "auto"]);
    expect(learnedCeiling(DEEPSEEK, "forcedToolChoice")).toBe(false);

    const next = script([ok]);
    await run({ ...DEEPSEEK, tools: [TOOL], toolChoice: "required" });
    expect(next.map((b) => b.tool_choice)).toEqual(["auto"]);
  });

  it("does not re-send a choice that already went out as auto", async () => {
    // Qwen's switch dialect takes auto only while thinking: the plan sends auto.
    const bodies = script([refuseChoice]);
    await expect(run({ ...QWEN, tools: [TOOL], toolChoice: "required", thinkingCategory: "qwen-budget", reasoningEffort: "high" }))
      .rejects.toThrow("tool_choice");
    expect(bodies.map((b) => b.tool_choice)).toEqual(["auto"]);
  });
});

describe("termination", () => {
  // A small deterministic PRNG, so a failure names its seed.
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const REPLIES = [refuseChoice, refuseFormat("json_schema"), refuse("upstream exploded"), ok];
  const rank = (m: StructuredOutputMode | undefined) => (m === undefined ? 3 : STRUCTURED_RANK[m]);

  it("ends within three retries on any sequence of answers, and only ever lowers a ceiling", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      __resetLearned();
      const next = rng(seed);
      // Sometimes start from an endpoint that has refused something already.
      if (next() < 0.3) noteLearned(QWEN, "structuredOutput", "json_object");
      if (next() < 0.3) noteLearned(QWEN, "forcedToolChoice", false);
      const replies = Array.from({ length: 6 }, () => REPLIES[Math.floor(next() * REPLIES.length)]);
      const before = rank(learnedCeiling(QWEN, "structuredOutput"));
      const bodies = script(replies);
      await run({ ...QWEN, tools: [TOOL], toolChoice: "required", structured: { schema: SCHEMA } }).catch(() => {});
      expect(bodies.length, `seed ${seed}`).toBeLessThanOrEqual(4);
      expect(rank(learnedCeiling(QWEN, "structuredOutput")), `seed ${seed}`).toBeLessThanOrEqual(before);
      // Each request after the first went out with something strictly lowered.
      for (let i = 1; i < bodies.length; i++) {
        const lowered = (bodies[i - 1].tool_choice !== "auto" && bodies[i].tool_choice === "auto")
          || format(bodies[i]) !== format(bodies[i - 1]);
        expect(lowered, `seed ${seed}, request ${i}`).toBe(true);
      }
    }
  });
});
