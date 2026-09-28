/**
 * LIVE probe of DashScope's native route (百炼 `/api/v1`, multimodal
 * generation) — NOT part of the suite. Runs only when QIANWEN_KEY is set (a
 * pay-as-you-go key). Drives the real `streamCompletion` and the real probes,
 * so what is verified is the app's own request bodies. Results:
 * docs/api/landscape.md §7 第二十一个样本.
 */
import { describe, expect, it } from "vitest";
import { streamCompletion } from "../index";
import { fetchRemoteModels, testProviderConnection } from "../providerProbe";
import { discPng } from "./liveImageBytes";
import type { StreamChunk, StreamMessage, StreamOptions } from "../types";

const KEY = process.env.QIANWEN_KEY ?? "";
const BASE = "https://maas.qianwenaiapi.com/api/v1";
const OLD_BASE = "https://dashscope.aliyuncs.com/api/v1";
/** The four the route is for (qwen3.8-plus does not exist, 2026-09-28). */
const MODELS = ["qwen3.7-flash", "qwen3.7-plus", "qwen3.8-flash", "qwen3.8-max"];

interface Collected { text: string; reasoning: string; toolCalls: Record<string, unknown>[]; done: Record<string, unknown>; bodies: Record<string, unknown>[] }

async function run(modelId: string, extra: Partial<StreamOptions> = {}): Promise<Collected> {
  const c: Collected = { text: "", reasoning: "", toolCalls: [], done: {}, bodies: [] };
  await streamCompletion({
    baseUrl: BASE, apiKey: KEY, standard: "dashscope_compat", platform: "dashscope", modelId,
    messages: [{ role: "user", content: "用一个词回答：天空是什么颜色" }],
    onChunk: (chunk: StreamChunk) => {
      const k = chunk as Record<string, unknown>;
      if (typeof k.text === "string") c.text += k.text;
      if (typeof k.reasoning === "string") c.reasoning += k.reasoning;
      if (Array.isArray(k.toolCalls)) c.toolCalls.push(...(k.toolCalls as Record<string, unknown>[]));
      if (k.done) c.done = k;
    },
    _onRequestBody: (b) => c.bodies.push(b as Record<string, unknown>),
    ...extra,
  });
  return c;
}

const params = (c: Collected) => (c.bodies[0].parameters ?? {}) as Record<string, unknown>;

const TOOLS = [{
  type: "function", function: {
    name: "get_weather", description: "查询城市天气",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
}] as StreamOptions["tools"];
const WEATHER: StreamMessage[] = [{ role: "user", content: "北京天气怎么样？" }];

describe.skipIf(!KEY)("LIVE DashScope native", () => {
  it("connection test and the paged model list", async () => {
    const r = await testProviderConnection(BASE, KEY, "dashscope_compat");
    expect(r.ok).toBe(true);
    const ids = (await fetchRemoteModels(BASE, KEY, "dashscope_compat")).map((m) => m.id);
    console.log("native /models:", ids.length);
    expect(ids.length).toBeGreaterThan(100);
    for (const m of MODELS) expect(ids).toContain(m);
  }, 120_000);

  it.each(MODELS)("%s streams an answer with usage", async (modelId) => {
    const c = await run(modelId, { thinkingCategory: modelId.startsWith("qwen3.8") ? "qwen-effort" : "qwen-budget", reasoningEffort: "off" });
    console.log(modelId, JSON.stringify({ text: c.text, reasoning: c.reasoning.length, done: c.done, params: params(c) }));
    expect(c.text.trim().length).toBeGreaterThan(0);
    expect(c.done.inputTokens).toBeGreaterThan(0);
    expect(c.done.outputTokens).toBeGreaterThan(0);
    expect(c.done.stopReason).toBe("stop");
  }, 120_000);

  it("qwen3.7: the budget switch thinks, off does not", async () => {
    const on = await run("qwen3.7-flash", { thinkingCategory: "qwen-budget", reasoningEffort: "high", thinkingBudget: 256 });
    const off = await run("qwen3.7-flash", { thinkingCategory: "qwen-budget", reasoningEffort: "off" });
    console.log("3.7 budget", JSON.stringify({ on: [on.reasoning.length, params(on)], off: [off.reasoning.length, params(off)] }));
    expect(params(on)).toMatchObject({ enable_thinking: true, thinking_budget: 256 });
    expect(on.reasoning.length).toBeGreaterThan(0);
    expect(off.reasoning).toBe("");
  }, 120_000);

  it("qwen3.8: the effort ladder thinks, off does not", async () => {
    const low = await run("qwen3.8-flash", { thinkingCategory: "qwen-effort", reasoningEffort: "low" });
    const off = await run("qwen3.8-flash", { thinkingCategory: "qwen-effort", reasoningEffort: "off" });
    console.log("3.8 effort", JSON.stringify({ low: [low.reasoning.length, params(low)], off: [off.reasoning.length, params(off)] }));
    expect(low.reasoning.length).toBeGreaterThan(0);
    expect(off.reasoning).toBe("");
  }, 120_000);

  it("a tool round trip, the thinking turn's reasoning handed back", async () => {
    const first = await run("qwen3.7-plus", { messages: WEATHER, tools: TOOLS, thinkingCategory: "qwen-budget", reasoningEffort: "high" });
    console.log("tools 1", JSON.stringify({ calls: first.toolCalls, reasoning: first.reasoning.length, done: first.done }));
    expect(first.toolCalls).toHaveLength(1);
    const call = first.toolCalls[0] as { id: string; name: string; arguments: string };
    expect(call.name).toBe("get_weather");
    expect(JSON.parse(call.arguments)).toMatchObject({ city: expect.stringContaining("北京") });
    const second = await run("qwen3.7-plus", {
      tools: TOOLS, thinkingCategory: "qwen-budget", reasoningEffort: "high",
      messages: [
        ...WEATHER,
        {
          role: "assistant", content: null,
          tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }],
          ...(first.reasoning ? { _reasoning: { field: "reasoning_content", text: first.reasoning } } : {}),
        },
        { role: "tool", tool_call_id: call.id, content: "晴，26℃，东南风 2 级" },
      ],
    });
    console.log("tools 2", JSON.stringify({ text: second.text, done: second.done }));
    expect(second.text).toMatch(/26|晴/);
  }, 180_000);

  // qwen3.8 honours the forcing; qwen3.7-flash answers in prose instead — on
  // ① as well, so a property of the model, not of this wire (第二十一个样本).
  it("forced tool choice with thinking off", async () => {
    const c = await run("qwen3.8-flash", {
      messages: [{ role: "user", content: "你好" }], tools: TOOLS, toolChoice: "required",
      thinkingCategory: "qwen-effort", reasoningEffort: "off",
    });
    const flash37 = await run("qwen3.7-flash", {
      messages: [{ role: "user", content: "你好" }], tools: TOOLS, toolChoice: "required",
      thinkingCategory: "qwen-budget", reasoningEffort: "off",
    });
    console.log("forced", JSON.stringify({ sent: params(c).tool_choice, calls: c.toolCalls, "qwen3.7-flash": flash37.toolCalls.length }));
    expect(params(c).tool_choice).toBe("required");
    expect(c.toolCalls).toHaveLength(1);
  }, 120_000);

  it("json_object, and whether json_schema is enforced against the prompt", async () => {
    const obj = await run("qwen3.7-flash", {
      messages: [{ role: "user", content: "用 JSON 回答：天空是什么颜色？键名 color" }],
      extraBody: { response_format: { type: "json_object" } }, thinkingCategory: "qwen-budget", reasoningEffort: "off",
    });
    console.log("json_object", obj.text);
    expect(JSON.parse(obj.text)).toHaveProperty("color");
    // The schema allows only 绿色; the prompt asks for the sky's colour.
    const results: string[] = [];
    for (const modelId of ["qwen3.7-flash", "qwen3.8-flash"]) {
      const strict = await run(modelId, {
        messages: [{ role: "user", content: "晴天的天空是什么颜色？用 JSON 回答。" }],
        thinkingCategory: modelId.startsWith("qwen3.8") ? "qwen-effort" : "qwen-budget", reasoningEffort: "off",
        extraBody: {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "answer", strict: true,
              schema: { type: "object", properties: { color: { type: "string", enum: ["绿色"] } }, required: ["color"], additionalProperties: false },
            },
          },
        },
      });
      results.push(`${modelId}: ${strict.text}`);
    }
    console.log("json_schema", JSON.stringify(results));
  }, 180_000);

  it("reads a picture", async () => {
    const c = await run("qwen3.7-plus", {
      thinkingCategory: "qwen-budget", reasoningEffort: "off",
      messages: [{
        role: "user", content: [
          { type: "text", text: "图里的圆是什么颜色？用一个词回答。" },
          { type: "image_url", image_url: { url: discPng(64, false) } },
        ],
      }],
    });
    console.log("image", JSON.stringify({ text: c.text, done: c.done }));
    expect(c.text).toMatch(/红/);
  }, 120_000);

  it("searches when the model is granted it", async () => {
    const c = await run("qwen3.8-max", {
      messages: [{ role: "user", content: "今天是几月几日？只回答日期。" }], serverTools: ["web_search"],
    });
    console.log("search", JSON.stringify({ sent: params(c).enable_search, text: c.text, done: c.done }));
    expect(params(c).enable_search).toBe(true);
    expect(c.text.trim().length).toBeGreaterThan(0);
  }, 180_000);

  it("the old host serves the same route", async () => {
    const c = await run("qwen3.7-flash", { baseUrl: OLD_BASE, thinkingCategory: "qwen-budget", reasoningEffort: "off" });
    expect(c.text.trim().length).toBeGreaterThan(0);
  }, 120_000);

  it("a text-endpoint model says to use the Chat route", async () => {
    await expect(run("qwen-plus")).rejects.toThrow(/switch the model to the Chat route/);
  }, 60_000);
});
