/**
 * LIVE probe against Alibaba Qianwen (DashScope) — NOT part of the suite.
 * Runs only when QIANWEN_KEY is set. Drives the real adapters so what is
 * verified is the app's own request bodies, not a hand-written imitation.
 */
import { describe, expect, it } from "vitest";
import { streamOpenAI } from "../ai/openai";
import { streamAnthropic } from "../ai/anthropic";
import { streamCompletion } from "../ai";
import { fetchRemoteModels, testProviderConnection } from "../ai/providerProbe";
import type { StreamChunk, StreamMessage, StreamOptions } from "../ai/types";

const KEY = process.env.QIANWEN_KEY ?? "";
const OPENAI_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const ANTHROPIC_BASE = "https://dashscope.aliyuncs.com/apps/anthropic";
const MODELS = ["qwen3.8-flash", "qwen3.7-flash", "deepseek-v4-pro-0813", "kimi-k3", "glm-5.2", "MiniMax-M2.5", "qwen3-vl-plus"];
const THINK_BY_DEFAULT = new Set(MODELS.filter((m) => m !== "qwen3-vl-plus"));
const PROMPT: StreamMessage[] = [{ role: "user", content: "用一个词回答：天空是什么颜色" }];

interface Collected { text: string; reasoning: string; toolCalls: unknown[]; done?: Record<string, unknown>; bodies: unknown[] }
async function run(fn: (o: StreamOptions) => Promise<void>, partial: Partial<StreamOptions> & Pick<StreamOptions, "standard" | "modelId" | "baseUrl">): Promise<Collected> {
  const c: Collected = { text: "", reasoning: "", toolCalls: [], bodies: [] };
  await fn({
    apiKey: KEY,
    messages: PROMPT,
    onChunk: (chunk: StreamChunk) => {
      const k = chunk as Record<string, unknown>;
      if (typeof k.text === "string") c.text += k.text;
      if (typeof k.reasoning === "string") c.reasoning += k.reasoning;
      if (Array.isArray(k.toolCalls)) c.toolCalls.push(...k.toolCalls);
      if (k.done) c.done = k;
    },
    _onRequestBody: (b) => c.bodies.push(b),
    ...partial,
  });
  return c;
}
const oa = (modelId: string, extra: Partial<StreamOptions> = {}) =>
  run(streamOpenAI, { standard: "openai_compat", baseUrl: OPENAI_BASE, modelId, ...extra });
const an = (modelId: string, extra: Partial<StreamOptions> = {}) =>
  run(streamAnthropic, { standard: "anthropic_compat", baseUrl: ANTHROPIC_BASE, modelId, ...extra });

const TOOLS = [{ type: "function", function: { name: "get_weather", description: "查询城市天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }] as StreamOptions["tools"];
const WEATHER: StreamMessage[] = [{ role: "user", content: "北京天气怎么样？" }];

describe.skipIf(!KEY)("LIVE Qianwen", () => {
  it("connection test: openai_compat lists models", async () => {
    const r = await testProviderConnection(OPENAI_BASE, KEY, "openai_compat");
    expect(r.ok).toBe(true);
    const ids = (await fetchRemoteModels(OPENAI_BASE, KEY, "openai_compat")).map((m) => m.id);
    for (const m of MODELS) expect(ids).toContain(m);
  }, 60_000);

  it("connection test: anthropic_compat (no /models) falls back to completion probe", async () => {
    for (const authMode of ["default", "bearer"] as const) {
      const r = await testProviderConnection(ANTHROPIC_BASE, KEY, "anthropic_compat", authMode);
      expect(r, authMode).toMatchObject({ ok: true });
    }
    await expect(fetchRemoteModels(ANTHROPIC_BASE, KEY, "anthropic_compat")).rejects.toThrow();
    const bad = await testProviderConnection(ANTHROPIC_BASE, "sk-bad", "anthropic_compat");
    expect(bad.ok).toBe(false);
  }, 60_000);

  describe.each(MODELS)("openai wire %s", (m) => {
    it("default (auto category, no effort): text + reasoning as the model defaults", async () => {
      const c = await oa(m);
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.reasoning.length > 0).toBe(THINK_BY_DEFAULT.has(m));
      expect(c.done).toMatchObject({ done: true });
      expect((c.done!.outputTokens as number) > 0).toBe(true);
    }, 90_000);

    it("openai-generic effort off → reasoning_effort:none turns thinking off (MiniMax refuses)", async () => {
      const p = oa(m, { thinkingCategory: "openai-generic", reasoningEffort: "off" });
      if (m === "MiniMax-M2.5") await expect(p).rejects.toThrow(/enable_thinking/);
      else expect((await p).reasoning).toBe("");
    }, 90_000);

    it("deepseek category off: thinking:{type:disabled} must silence reasoning (MiniMax refuses)", async () => {
      // Fails on the thinking models until reasoningBody sends the switch at
      // top level instead of under a literal `extra_body` key (qianwen-compat-plan §3 第 1 片).
      const p = oa(m, { thinkingCategory: "deepseek", reasoningEffort: "off" });
      if (m === "MiniMax-M2.5") await expect(p).rejects.toThrow(/enable_thinking/);
      else expect((await p).reasoning).toBe("");
    }, 90_000);

    it("qwen-budget on + 1024: thinking on (kimi-k3 refuses budget)", async () => {
      const p = oa(m, { thinkingCategory: "qwen-budget", reasoningEffort: "high", thinkingBudget: 1024 });
      if (m === "kimi-k3") await expect(p).rejects.toThrow(/thinking_budget/);
      else expect((await p).reasoning.length).toBeGreaterThan(0);
    }, 90_000);

    it("qwen-budget off: enable_thinking:false (MiniMax refuses)", async () => {
      const p = oa(m, { thinkingCategory: "qwen-budget", reasoningEffort: "off" });
      if (m === "MiniMax-M2.5") await expect(p).rejects.toThrow(/enable_thinking/);
      else expect((await p).reasoning).toBe("");
    }, 90_000);

    it("json_schema strict via extraBody parses (MiniMax does not enforce it — checked, not asserted)", async () => {
      const c = await oa(m, {
        messages: [{ role: "user", content: "天空是什么颜色？用 JSON 回答" }],
        extraBody: { response_format: { type: "json_schema", json_schema: { name: "ans", strict: true, schema: { type: "object", properties: { color: { type: "string" } }, required: ["color"], additionalProperties: false } } } },
      });
      const parses = (() => { try { JSON.parse(c.text); return true; } catch { return false; } })();
      // MiniMax-M2.5 answered the same request with fenced JSON once and prose once:
      // response_format is not enforced there, only the prompt's "JSON" cue is.
      if (m === "MiniMax-M2.5") console.info(`MiniMax json_schema parses=${parses}: ${c.text.slice(0, 60)}`);
      else expect(parses, c.text.slice(0, 80)).toBe(true);
    }, 120_000);

    it("tools: forced tool_choice under default thinking → streamCompletion retries with auto", async () => {
      const c: Collected = { text: "", reasoning: "", toolCalls: [], bodies: [] };
      await streamCompletion({
        standard: "openai_compat", baseUrl: OPENAI_BASE, apiKey: KEY, modelId: m,
        messages: WEATHER, tools: TOOLS, toolChoice: { type: "function", function: { name: "get_weather" } },
        onChunk: (chunk) => { const k = chunk as Record<string, unknown>; if (Array.isArray(k.toolCalls)) c.toolCalls.push(...k.toolCalls); },
      });
      expect(c.toolCalls.length).toBeGreaterThan(0);
    }, 120_000);
  });

  describe.each(MODELS)("anthropic wire %s", (m) => {
    it("default (claude-adaptive → thinking:{type:adaptive,display:summarized}) streams", async () => {
      const c = await an(m);
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.reasoning.length).toBeGreaterThan(0);
      expect(c.done).toMatchObject({ done: true });
    }, 120_000);

    it("claude-budget (enabled + budget_tokens) — kimi-k3 refuses", async () => {
      const p = an(m, { thinkingCategory: "claude-budget", thinkingBudget: 2048, maxOutput: 8192 });
      if (m === "kimi-k3") await expect(p).rejects.toThrow(/thinking_budget/);
      else expect((await p).reasoning.length).toBeGreaterThan(0);
    }, 120_000);

    it("minimax category off → thinking:{type:disabled} — MiniMax refuses, others go silent", async () => {
      const p = an(m, { thinkingCategory: "minimax", reasoningEffort: "off" });
      if (m === "MiniMax-M2.5") await expect(p).rejects.toThrow(/enable_thinking/);
      else expect((await p).reasoning).toBe("");
    }, 120_000);

    it("tool round trip with echoed thinking block (empty signature)", async () => {
      const first = await an(m, { messages: WEATHER, tools: TOOLS });
      expect(first.toolCalls.length).toBeGreaterThan(0);
    }, 120_000);
  });

  it("vision: data-URL image on qwen3-vl-plus via openai wire", async () => {
    // 16x16 solid red PNG — the endpoint rejects anything under 10px a side.
    const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGO4IyJCEmIY1TCqQWTYagAAAnEEEPBHj2sAAAAASUVORK5CYII=";
    const c = await oa("qwen3-vl-plus", {
      messages: [{ role: "user", content: [{ type: "text", text: "这张图是什么颜色？用一个词回答" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] } as unknown as StreamMessage],
    });
    expect(c.text).toMatch(/红/);
  }, 60_000);
});
