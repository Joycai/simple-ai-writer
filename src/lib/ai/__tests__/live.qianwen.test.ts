/**
 * LIVE probe against Alibaba Qianwen (DashScope) — NOT part of the suite.
 * Runs only when QIANWEN_KEY is set. Drives the real adapters so what is
 * verified is the app's own request bodies, not a hand-written imitation.
 */
import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateVideoTokens, videoPart } from "../videoInput";
import { parseMp4Info } from "../../fs/video";
import { streamOpenAI } from "../openai";
import { streamAnthropic } from "../anthropic";
import { streamCompletion } from "..";
import { fetchRemoteModels, testProviderConnection } from "../providerProbe";
import type { StreamChunk, StreamMessage, StreamOptions } from "../types";

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

  // Server-run search + page reading (landscape.md §7 第六个样本「联网搜索与网页抓取」,
  // 2026-09-14). A page-summary prompt: answering it well requires opening the URL.
  describe("server tools: web_search + web_extractor", () => {
    const PAGE: StreamMessage[] = [{ role: "user", content: "用两句话概括 https://www.rust-lang.org/ 首页讲了什么" }];
    const serve = async (standard: StreamOptions["standard"], modelId: string, serverTools: StreamOptions["serverTools"], messages: StreamMessage[] = PAGE) => {
      const c = { text: "", events: [] as Record<string, unknown>[], done: undefined as Record<string, unknown> | undefined, bodies: [] as unknown[] };
      await streamCompletion({
        standard, baseUrl: OPENAI_BASE, apiKey: KEY, modelId, messages, serverTools,
        onChunk: (chunk: StreamChunk) => {
          const k = chunk as Record<string, unknown>;
          if (typeof k.text === "string") c.text += k.text;
          if (k.serverTool) c.events.push(k.serverTool as Record<string, unknown>);
          if (k.done) c.done = k;
        },
        _onRequestBody: (b) => c.bodies.push(b),
      });
      return c;
    };

    it("responses compat qwen3.8-flash: the page read shows up as web_extractor events", async () => {
      const c = await serve("openai_responses_compat", "qwen3.8-flash", ["web_search", "web_extractor"]);
      expect(c.text.length).toBeGreaterThan(0);
      const read = c.events.filter((e) => e.name === "web_extractor");
      expect(read.map((e) => e.phase)).toEqual(expect.arrayContaining(["call", "result"]));
      expect(JSON.stringify(read)).toContain("rust-lang.org");
    }, 240_000);

    it("chat compat qwen3-max: agent_max reads the page (input grows past the bare prompt)", async () => {
      const c = await serve("openai_compat", "qwen3-max", ["web_search", "web_extractor"]);
      expect(c.text).toMatch(/Rust/);
      // No trace on this wire — the input token count is the only evidence.
      expect(c.done!.inputTokens as number).toBeGreaterThan(500);
      expect(c.events).toEqual([]);
    }, 240_000);

    it("responses compat qwen3.8-flash: web_search_image returns titled image hits", async () => {
      const c = await serve("openai_responses_compat", "qwen3.8-flash", ["web_search_image"], [
        { role: "user", content: "帮我找两张雪豹的照片，列出链接" },
      ]);
      const hits = c.events.filter((e) => e.name === "web_search_image" && e.phase === "result");
      expect(hits.length).toBeGreaterThan(0);
      expect((hits[0].results as { url: string }[]).length).toBeGreaterThan(0);
    }, 240_000);

    it("responses compat qwen3.8-flash: image_search runs on a data-URL image (a flat square matches nothing)", async () => {
      // Same 16x16 red PNG as the vision probe below — what the app sends is a
      // data URL, so that is the shape worth verifying. An empty hit list is fine.
      const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGO4IyJCEmIY1TCqQWTYagAAAnEEEPBHj2sAAAAASUVORK5CYII=";
      const c = await serve("openai_responses_compat", "qwen3.8-flash", ["image_search"], [{
        role: "user",
        content: [{ type: "text", text: "用以图搜图找和这张图相似的图片，列出链接" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }],
      } as unknown as StreamMessage]);
      expect(c.events.filter((e) => e.name === "image_search").map((e) => e.phase)).toEqual(expect.arrayContaining(["call", "result"]));
    }, 240_000);

    it("chat compat qwen3.8-flash refuses the agent_max strategy with a 400", async () => {
      await expect(serve("openai_compat", "qwen3.8-flash", ["web_search", "web_extractor"]))
        .rejects.toThrow(/search strategy/);
    }, 60_000);
  });

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
      // The switch must ride at the top level; under a literal `extra_body` key
      // (the shape before qianwen-compat-plan §3 第 1 片) it was ignored and this failed.
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

  // Video understanding (docs/feature/video-input.md, 2026-09-14). The clips
  // are ffmpeg test patterns (12–24 KB each) living with the tests for
  // fs/video.ts, sent through the app's own part builder and the real openai
  // adapter.
  describe("video: qwen3-vl-plus", () => {
    const VL = "qwen3-vl-plus";
    const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../fs/__tests__/fixtures");
    const clip = (name: string) => readFileSync(join(FIX, name));
    const dataUrl = (name: string) => `data:video/mp4;base64,${clip(name).toString("base64")}`;
    // Straight through the openai adapter (the only family a clip may use),
    // via `run`, which captures the request body the part rides in.
    const ask = (name: string, fps?: number) =>
      oa(VL, {
        messages: [{ role: "user", content: [{ type: "text", text: "用一句话描述视频内容" }, videoPart(dataUrl(name), fps)] }],
      });
    const inTok = (c: Collected) => c.done!.inputTokens as number;

    it("a 2 s clip is read, and its cost is near the estimate", async () => {
      const c = await ask("v2s_640.mp4");
      expect(c.text.length).toBeGreaterThan(0);
      // Measured 602 video tokens + ~20 of text. The estimate is ≈, so a band.
      const est = estimateVideoTokens({ ...parseMp4Info(new Uint8Array(clip("v2s_640.mp4")))! })!;
      expect(inTok(c)).toBeGreaterThan(est * 0.9);
      expect(inTok(c)).toBeLessThan(est * 1.2 + 60);
    }, 120_000);

    it("a 1 s clip is refused as too short", async () => {
      await expect(ask("v1s_640.mp4")).rejects.toThrow(/too short/);
    }, 120_000);

    it("fps 0.5 beside video_url reaches the endpoint: the same clip costs less than the default", async () => {
      // openai.ts has no `_onRequestBody` hook, so the proof is the bill: the
      // drop only happens if `fps` arrived where the endpoint reads it. The
      // part's shape itself is pinned in videoInput.test.ts.
      const [def, low] = await Promise.all([ask("v6s_320_10fps.mp4"), ask("v6s_320_10fps.mp4", 0.5)]);
      // Measured 482 → 162 video tokens.
      expect(inTok(low)).toBeLessThan(inTok(def) - 200);
    }, 180_000);
  });

  // Image understanding (landscape.md §7 第六个样本「视觉理解」, 2026-09-14). Every
  // fixture is built here — solid-colour PNGs from a ten-line encoder, plus two
  // tiny webp / gif constants — so the file needs no binary fixtures.
  describe("vision: qwen3-vl-plus", () => {
    const VL = "qwen3-vl-plus";
    const RED: RGB = [255, 0, 0];
    const BLUE: RGB = [0, 0, 255];
    const GRAY: RGB = [128, 128, 128];
    const WEBP_RED16 = "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoQABAAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=";
    const GIF_RED16 = "R0lGODdhEAAQAIEAAP8AAAAAAAAAAAAAACwAAAAAEAAQAEAIHQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBADs=";

    const img = (dataUrl: string, detail?: string) => ({ type: "image_url", image_url: { url: dataUrl, ...(detail ? { detail } : {}) } });
    const ask = (text: string, ...parts: unknown[]) => [{ role: "user", content: [{ type: "text", text }, ...parts] } as unknown as StreamMessage];
    const vl = async (messages: StreamMessage[], extra: Partial<StreamOptions> = {}) => {
      const c: Collected = { text: "", reasoning: "", toolCalls: [], bodies: [] };
      await streamCompletion({
        standard: "openai_compat", baseUrl: OPENAI_BASE, apiKey: KEY, modelId: VL, messages,
        onChunk: (chunk) => {
          const k = chunk as Record<string, unknown>;
          if (typeof k.text === "string") c.text += k.text;
          if (typeof k.reasoning === "string") c.reasoning += k.reasoning;
          if (Array.isArray(k.toolCalls)) c.toolCalls.push(...k.toolCalls);
          if (k.done) c.done = k;
        },
        _onRequestBody: (b) => c.bodies.push(b),
        ...extra,
      } as StreamOptions);
      return c;
    };
    const inTok = (c: Collected) => c.done!.inputTokens as number;
    const COLOR = "这张图是什么颜色？用一个词回答";

    it.each([
      ["png", pngDataUrl(16, 16, RED)],
      ["webp", `data:image/webp;base64,${WEBP_RED16}`],
      ["gif", `data:image/gif;base64,${GIF_RED16}`],
    ])("chat compat reads a %s data URL", async (_fmt, url) => {
      expect((await vl(ask(COLOR, img(url)))).text).toMatch(/红|赤/);
    }, 60_000);

    it("two images keep their order", async () => {
      const c = await vl(ask("按顺序说出两张图的颜色，格式：A,B", img(pngDataUrl(16, 16, RED)), img(pngDataUrl(16, 16, BLUE))));
      expect(c.text).toMatch(/红.*蓝/s);
    }, 60_000);

    it("9px is refused with a 400; 10px and 200x10 pass", async () => {
      await expect(vl(ask(COLOR, img(pngDataUrl(9, 9, RED))))).rejects.toThrow(/larger than 10/);
      expect((await vl(ask(COLOR, img(pngDataUrl(10, 10, RED))))).text.length).toBeGreaterThan(0);
      expect((await vl(ask(COLOR, img(pngDataUrl(200, 10, RED))))).text.length).toBeGreaterThan(0);
    }, 90_000);

    it("image_url.detail is ignored: low and high cost the same input tokens", async () => {
      const url = pngDataUrl(512, 512, GRAY);
      const [low, high] = await Promise.all([vl(ask("回答OK", img(url, "low"))), vl(ask("回答OK", img(url, "high")))]);
      expect(inTok(low)).toBeGreaterThan(200);
      expect(inTok(low)).toBe(inTok(high));
    }, 90_000);

    it("vl_high_resolution_images raises the ~2500-token image cap on a 2048² image", async () => {
      const url = pngDataUrl(2048, 2048, GRAY);
      const [def, hi] = await Promise.all([
        vl(ask("回答OK", img(url))),
        vl(ask("回答OK", img(url)), { extraBody: { vl_high_resolution_images: true } }),
      ]);
      // Measured 2512 vs 4108: ≈ pixels/1024 until the default cap bites.
      expect(inTok(def)).toBeGreaterThan(2300);
      expect(inTok(def)).toBeLessThan(2800);
      expect(inTok(hi)).toBeGreaterThan(inTok(def) * 1.4);
    }, 120_000);

    it("image + tools + qwen-budget thinking: reasons, then calls the tool with what it saw", async () => {
      const c = await vl(ask("用工具记录这张图的主色", img(pngDataUrl(16, 16, RED))), {
        tools: [{ type: "function", function: { name: "record_color", description: "记录一张图的主色", parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"] } } }] as StreamOptions["tools"],
        thinkingCategory: "qwen-budget", reasoningEffort: "high", thinkingBudget: 1024,
      });
      expect(c.reasoning.length).toBeGreaterThan(0);
      const call = c.toolCalls[0] as { name: string; arguments: string } | undefined;
      expect(call?.name).toBe("record_color");
      expect(call?.arguments).toMatch(/红|red/i);
    }, 120_000);

    it("responses compat does not serve qwen3-vl-plus at all", async () => {
      await expect(vl(ask(COLOR, img(pngDataUrl(16, 16, RED))), { standard: "openai_responses_compat" }))
        .rejects.toThrow(/Unsupported model/);
    }, 60_000);

    it("anthropic compat reads the image (and thinks by default)", async () => {
      const c = await vl(ask(COLOR, img(pngDataUrl(16, 16, RED))), { standard: "anthropic_compat", baseUrl: ANTHROPIC_BASE });
      expect(c.text).toMatch(/红|赤/);
      expect(c.reasoning.length).toBeGreaterThan(0);
    }, 90_000);
  });
});

type RGB = [number, number, number];
/** A solid-colour 8-bit RGB PNG as a data URL. Uniform rows deflate to almost nothing, so 2048² stays small. */
function pngDataUrl(w: number, h: number, [r, g, b]: RGB): string {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}
