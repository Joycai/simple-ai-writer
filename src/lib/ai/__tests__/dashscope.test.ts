/**
 * DashScope's native route, end to end through `streamCompletion`: the
 * request it builds, and what it reads out of streams the endpoint really sent
 * (`fixtures/dashscope-native/`, recorded 2026-09-28 on maas.qianwenaiapi.com —
 * docs/api/landscape.md §7 第二十一个样本), plus the refused-request bodies
 * read off `streamDashscope` directly (第二十二个样本).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { streamCompletion, type StreamChunk, type StreamMessage, type StreamOptions } from "../index";
import { __resetLearned, classify } from "../capability/learned";
import { nativeBody, streamDashscope, toNativeMessages } from "../dashscope";
import type { AccumulatedToolCall, ToolDefinition } from "../types";

declare const __dirname: string;
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/dashscope-native", name), "utf8");

const BASE = "https://maas.qianwenaiapi.com/api/v1";

/** A body that streams `raw` cut at `cuts` — the way the network happens to deliver it. */
function sseResponse(raw: string, cuts: number[] = []): Response {
  const encoder = new TextEncoder();
  const pieces: string[] = [];
  let at = 0;
  for (const c of [...cuts, raw.length]) {
    pieces.push(raw.slice(at, c));
    at = c;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

interface Call { url: string; headers: Record<string, string>; body: Record<string, unknown> }

async function run(
  response: () => Response,
  extra: Partial<StreamOptions> = {},
): Promise<{ chunks: StreamChunk[]; calls: Call[] }> {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return response();
  }));
  const chunks: StreamChunk[] = [];
  await streamCompletion({
    baseUrl: BASE, apiKey: "k", standard: "dashscope_compat", platform: "dashscope", modelId: "qwen3.7-plus",
    messages: [{ role: "user", content: "hi" }], onChunk: (c) => { chunks.push(c); }, ...extra,
  });
  return { chunks, calls };
}

type Bag = { text?: string; reasoning?: string; toolCalls?: AccumulatedToolCall[]; done?: boolean } & Record<string, unknown>;
const bags = (chunks: StreamChunk[]) => chunks as Bag[];
const textOf = (chunks: StreamChunk[]) => bags(chunks).map((c) => c.text ?? "").join("");
const reasoningOf = (chunks: StreamChunk[]) => bags(chunks).map((c) => c.reasoning ?? "").join("");
const doneOf = (chunks: StreamChunk[]) => bags(chunks).find((c) => c.done)!;

afterEach(() => {
  vi.unstubAllGlobals();
  __resetLearned();
});

describe("DashScope native route — the request", () => {
  it("posts the envelope to the multimodal endpoint, streamed", async () => {
    const { calls } = await run(() => sseResponse(fixture("json-qwen3.7-flash.sse")), { temperature: 0.3, maxTokens: 64 });
    const [call] = calls;
    expect(call.url).toBe(`${BASE}/services/aigc/multimodal-generation/generation`);
    expect(call.headers["X-DashScope-SSE"]).toBe("enable");
    expect(call.headers.Authorization).toBe("Bearer k");
    expect(call.body).toEqual({
      model: "qwen3.7-plus",
      input: { messages: [{ role: "user", content: "hi" }] },
      parameters: { result_format: "message", incremental_output: true, temperature: 0.3, max_tokens: 64 },
    });
    // No envelope field of Chat Completions' leaks in beside its own.
    expect(Object.keys(call.body)).toEqual(["model", "input", "parameters"]);
  });

  it("puts the thinking fields in parameters, spelled as Chat Completions spells them", async () => {
    const budget = await run(() => sseResponse(fixture("json-qwen3.7-flash.sse")), {
      thinkingCategory: "qwen-budget", reasoningEffort: "high", thinkingBudget: 2048,
    });
    expect(budget.calls[0].body.parameters).toMatchObject({ enable_thinking: true, thinking_budget: 2048 });
    const effort = await run(() => sseResponse(fixture("json-qwen3.7-flash.sse")), {
      modelId: "qwen3.8-flash", thinkingCategory: "qwen-effort", reasoningEffort: "medium",
    });
    expect(effort.calls[0].body.parameters).toMatchObject({ reasoning_effort: "medium" });
  });

  it("sends search as parameters.enable_search, and the escape hatch into parameters too", async () => {
    const { calls } = await run(() => sseResponse(fixture("json-qwen3.7-flash.sse")), {
      serverTools: ["web_search", "web_extractor", "code_interpreter"],
      extraBody: { response_format: { type: "json_object" } },
    });
    const params = calls[0].body.parameters as Record<string, unknown>;
    expect(params.enable_search).toBe(true);
    // Not measured on this route: the cells keep them off.
    expect(params).not.toHaveProperty("search_options");
    expect(params).not.toHaveProperty("enable_code_interpreter");
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(calls[0].body).not.toHaveProperty("response_format");
  });

  it("respells content parts, and hands a thinking turn's reasoning back under its own name", () => {
    const messages: StreamMessage[] = [
      { role: "user", content: [{ type: "text", text: "这是什么？" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } }] },
      {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "look", arguments: "{}" } }],
        _reasoning: { field: "reasoning_content", text: "先看看图。" },
      },
      { role: "tool", tool_call_id: "call_1", content: "一座灯塔" },
    ];
    expect(toNativeMessages({ messages, modelId: "qwen3.7-plus" })).toEqual([
      { role: "user", content: [{ text: "这是什么？" }, { image: "data:image/png;base64,AAAA" }] },
      {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "look", arguments: "{}" } }],
        reasoning_content: "先看看图。",
      },
      { role: "tool", tool_call_id: "call_1", content: "一座灯塔" },
    ]);
  });

  it("refuses a clip or a file by name rather than sending a part it cannot spell", () => {
    const opts = {
      baseUrl: BASE, apiKey: "k", standard: "dashscope_compat", platform: "dashscope", modelId: "qwen3.7-plus",
      messages: [{ role: "user", content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } }] }],
      onChunk: () => {},
    } as StreamOptions;
    expect(() => nativeBody(opts)).toThrow(/DashScope: a video_url part/);
  });
});

describe("DashScope native route — reading the stream", () => {
  it("reads the answer and the thinking beside it, and the turn's usage", async () => {
    const { chunks } = await run(() => sseResponse(fixture("think-qwen3.8-flash.sse")), { modelId: "qwen3.8-flash" });
    expect(textOf(chunks)).toBe("391");
    expect(reasoningOf(chunks)).toBe("用户要求计算17*23，并且只要数字结果。\n\n17 * 23 = 391\n");
    expect(doneOf(chunks)).toMatchObject({ done: true, inputTokens: 58, outputTokens: 32, stopReason: "stop" });
  });

  it("assembles a tool call whose id arrives once and then as an empty string", async () => {
    const { chunks } = await run(() => sseResponse(fixture("tools-qwen3.7-plus.sse")));
    expect(textOf(chunks)).toBe("我来帮您查询北京的天气情况。\n\n");
    const calls = bags(chunks).find((c) => c.toolCalls)!.toolCalls!;
    expect(calls).toEqual([
      { index: 0, id: "call_c384c63a20ae49af8904ea84", name: "get_weather", arguments: '{"city": "北京"}' },
    ]);
    expect(doneOf(chunks)).toMatchObject({ inputTokens: 273, outputTokens: 33, stopReason: "tool_calls" });
  });

  it("reads the same turn however the network cuts the bytes", async () => {
    const raw = fixture("tools-qwen3.7-plus.sse");
    const whole = await run(() => sseResponse(raw));
    let s = 7;
    for (let round = 0; round < 40; round++) {
      const cuts: number[] = [];
      for (let at = 0; at < raw.length;) {
        s = (s * 1103515245 + 12345) % 2 ** 31;
        at += 1 + (s % 97);
        if (at < raw.length) cuts.push(at);
      }
      const cut = await run(() => sseResponse(raw, cuts));
      expect(textOf(cut.chunks)).toBe(textOf(whole.chunks));
      expect(bags(cut.chunks).find((c) => c.toolCalls)).toEqual(bags(whole.chunks).find((c) => c.toolCalls));
      expect(doneOf(cut.chunks)).toEqual(doneOf(whole.chunks));
    }
  });

  it("does not hand a stream cut before its last frame over as a whole answer", async () => {
    const raw = fixture("tools-qwen3.7-plus.sse");
    const cut = raw.slice(0, raw.lastIndexOf("id:"));
    await expect(run(() => sseResponse(cut))).rejects.toThrow(/DashScope: the stream ended before the answer finished/);
  });

  it("marks a length stop as truncated, and reports cached tokens", async () => {
    const frame = (finish: string, text: string) =>
      `id:1\nevent:result\n:HTTP_STATUS/200\ndata:${JSON.stringify({
        output: { choices: [{ finish_reason: finish, message: { role: "assistant", content: [{ text }] } }] },
        usage: { input_tokens: 40, output_tokens: 8, prompt_tokens_details: { cached_tokens: 32 } },
      })}`;
    // The last frame without a trailing newline: the tail is read too.
    const { chunks } = await run(() => sseResponse(`${frame("null", "半")}\n\n${frame("length", "句")}`));
    expect(textOf(chunks)).toBe("半句");
    expect(doneOf(chunks)).toMatchObject({ truncated: true, stopReason: "length", cachedTokens: 32, inputTokens: 40 });
  });

  it("throws the error frame an HTTP 200 stream carries", async () => {
    await expect(run(() => sseResponse(fixture("error-image-too-small.sse"))))
      .rejects.toThrow(/^DashScope: InvalidParameter: <400> .*must be larger than 10/);
  });

  it("names the Chat route when the model lives on the text endpoint", async () => {
    const body = '{"code":"InvalidParameter","message":"url error, please check url！","request_id":"r"}';
    await expect(run(() => new Response(body, { status: 400 }), { modelId: "qwen-plus" }))
      .rejects.toThrow(/DashScope API error 400 .*url error.*switch the model to the Chat route/);
  });
});

/**
 * A request refused before streaming. The body follows `X-DashScope-SSE`, which
 * this route always sends: one SSE error frame on the 400, or — without the
 * header — a plain JSON object (landscape.md §7 第二十二个样本). Called on
 * `streamDashscope` itself, so nothing between it and the author reshapes the
 * message.
 */
describe("streamDashscope: a refused request's body", () => {
  const URL = `${BASE}/services/aigc/multimodal-generation/generation`;
  const TOOL_CHOICE_MESSAGE =
    "<400> InternalError.Algo.InvalidParameter: The tool_choice parameter does not support being set to required or object in thinking mode";
  const sseFrame = (payload: Record<string, unknown>) =>
    `id:1\nevent:error\n:HTTP_STATUS/400\ndata:${JSON.stringify(payload)}\n\n`;

  /** The error `streamDashscope` throws when the endpoint answers `status` with `body`. */
  async function refusal(body: string, contentType: string, status = 400): Promise<Error> {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "content-type": contentType } })));
    const err = await streamDashscope({
      baseUrl: BASE, apiKey: "k", standard: "dashscope_compat", platform: "dashscope", modelId: "qwen3.8-flash",
      messages: [{ role: "user", content: "hi" }], onChunk: () => {},
    }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }

  it("reads code and message off the SSE frame's data line", async () => {
    const err = await refusal(fixture("error-image-too-small.sse"), "text/event-stream");
    expect(err.message).toMatch(
      new RegExp(
        `^DashScope API error 400 \\(${URL.replace(/[.?]/g, "\\$&")}\\): InvalidParameter: <400> .*must be larger than 10\\]` +
        " \\(request_id c269c642-174f-9d28-abe7-b3e3757c0eb6\\)$",
      ),
    );
    // None of the frame's scaffolding reaches the author.
    expect(err.message).not.toMatch(/event:|HTTP_STATUS|data:|\bid:1\b|[{}"]/);
  });

  it("reads the same code and message off a plain JSON body", async () => {
    const payload = JSON.parse(fixture("error-image-too-small.sse").split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    const json = await refusal(JSON.stringify(payload), "application/json");
    const sse = await refusal(fixture("error-image-too-small.sse"), "text/event-stream");
    expect(json.message).toBe(sse.message);
    expect(json.message).not.toMatch(/[{}"]/);
  });

  it("keeps the Chat-route hint when the url error comes as a frame", async () => {
    const err = await refusal(
      sseFrame({ code: "InvalidParameter", message: "url error, please check url！", request_id: "r" }),
      "text/event-stream",
    );
    expect(err.message).toMatch(/: InvalidParameter: url error, please check url！ \(request_id r\) — .*switch the model to the Chat route$/);
  });

  it("falls back to the raw text when the body is neither shape", async () => {
    const html = "<html><body>502 Bad Gateway</body></html>";
    expect((await refusal(html, "text/html", 502)).message).toBe(`DashScope API error 502 (${URL}): ${html}`);
    // An object without a message is not the vendor's refusal either.
    expect((await refusal('{"status":"busy"}', "application/json", 503)).message).toBe(
      `DashScope API error 503 (${URL}): {"status":"busy"}`,
    );
  });

  it("leaves the learned fallback able to read a forced tool_choice refusal in either shape", async () => {
    const payload = { code: "InvalidParameter", message: TOOL_CHOICE_MESSAGE, request_id: "r" };
    for (const err of [
      await refusal(sseFrame(payload), "text/event-stream"),
      await refusal(JSON.stringify(payload), "application/json"),
    ]) {
      expect(err.message).toContain(TOOL_CHOICE_MESSAGE);
      expect(classify(err, { forcedToolChoice: true })).toEqual({ fact: "forcedToolChoice", ceiling: false });
    }
  });

  it("re-sends a forced choice as auto after the framed 400, end to end", async () => {
    const tool: ToolDefinition = {
      type: "function",
      function: { name: "emit", description: "d", parameters: { type: "object", properties: {} } },
    };
    let n = 0;
    const { calls } = await run(
      () => n++ === 0
        ? new Response(sseFrame({ code: "InvalidParameter", message: TOOL_CHOICE_MESSAGE, request_id: "r" }), {
          status: 400, headers: { "content-type": "text/event-stream" },
        })
        : sseResponse(fixture("json-qwen3.7-flash.sse")),
      { modelId: "qwen3.8-flash", tools: [tool], toolChoice: "required" },
    );
    expect(calls.map((c) => (c.body.parameters as Record<string, unknown>).tool_choice)).toEqual(["required", "auto"]);
  });
});
