/**
 * DashScope's native route, end to end through `streamCompletion`: the
 * request it builds, and what it reads out of streams the endpoint really sent
 * (`fixtures/dashscope-native/`, recorded 2026-09-28 on maas.qianwenaiapi.com —
 * docs/api/landscape.md §7 第二十一个样本).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { streamCompletion, type StreamChunk, type StreamMessage, type StreamOptions } from "../index";
import { __resetLearned } from "../capability/learned";
import { nativeBody, toNativeMessages } from "../dashscope";
import type { AccumulatedToolCall } from "../types";

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
