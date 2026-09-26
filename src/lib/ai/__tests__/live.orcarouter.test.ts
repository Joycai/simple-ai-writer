/**
 * LIVE probe of OrcaRouter's four protocol surfaces on paid models — NOT part
 * of the suite. Runs only when ORCA_KEY is set. Drives the real adapters
 * through `streamCompletion` with the `orcarouter` preset's addresses, so what
 * is verified is the app's own request bodies and its own reading of each
 * stream — the facts are in docs/api/landscape.md §7 第十八个样本 (2026-09-26).
 *
 * What sits behind each surface (measured, same sample): the Messages and
 * `generateContent` paths hand back the vendor's own bodies (a real `msg_01…`
 * id and signature; Vertex AI's `createTime` / `trafficType`), but the
 * gateway re-serializes the *request* from the fields it knows — an unknown
 * top-level key or an invalid enum is dropped with a 200 on Messages. Chat
 * Completions and most Responses requests go through an OpenRouter-shaped
 * layer (`gen-…` ids, `provider`, `usage.cost`); `store: true` or an `include`
 * of `web_search_call.action.sources` switches a Responses request to the raw
 * OpenAI body. So a case here that pins a *refusal* pins the gateway, not the
 * vendor.
 *
 *   ORCA_KEY=sk-orca-…   the key; nothing else is configurable on purpose —
 *                        the model ids below are what the sample measured
 */
import { describe, expect, it } from "vitest";
import { streamCompletion } from "../index";
import { imagePart } from "../imagePart";
import { jsonModeShaping } from "../jsonMode";
import type {
  ApiStandard, AuthMode, ContentPart, StreamChunk, StreamMessage, StreamOptions, ToolDefinition,
} from "../types";
import type { ThinkingCategoryId } from "../reasoning";

const KEY = process.env.ORCA_KEY ?? "";
const ORIGIN = "https://api.orcarouter.ai";

interface Route {
  name: string;
  standard: ApiStandard;
  category: ThinkingCategoryId;
  baseUrl: string;
  authMode?: AuthMode;
  /** The cheap model every shape case runs on. */
  model: string;
}
// The four rows of `PROVIDER_PRESETS.orcarouter` (platforms.ts), one each.
const CHAT: Route = { name: "Chat", standard: "openai_compat", category: "openai-generic", baseUrl: `${ORIGIN}/v1`, model: "openai/gpt-6-luna" };
const RESP: Route = { name: "Resp", standard: "openai_responses_compat", category: "responses-effort", baseUrl: `${ORIGIN}/v1`, model: "openai/gpt-6-luna" };
const ANTH: Route = { name: "Anth", standard: "anthropic_compat", category: "claude-adaptive", baseUrl: ORIGIN, authMode: "bearer", model: "anthropic/claude-sonnet-5" };
const GEM: Route = { name: "Gem", standard: "gemini_compat", category: "gemini3", baseUrl: `${ORIGIN}/v1beta`, authMode: "bearer", model: "google/gemini-3.8-flash" };
const ROUTES = [CHAT, RESP, ANTH, GEM];

/** A 64×64 teal PNG (0,128,128), inlined so the probe needs no fixture file. */
const TEAL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATElEQVR42u3PMQkAAAwDsEqv9EnoPQjEQJL2NwEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGB5QDPEgDxM5Bd8gAAAABJRU5ErkJggg==";

interface Collected {
  text: string;
  reasoning: string;
  searches: number;
  body?: Record<string, unknown>;
  toolCalls?: Extract<StreamChunk, { toolCalls: unknown }>;
  done?: Extract<StreamChunk, { done: true }>;
}

async function ask(route: Route, messages: StreamMessage[], opts: Partial<StreamOptions> = {}, modelId = route.model): Promise<Collected> {
  const c: Collected = { text: "", reasoning: "", searches: 0 };
  await streamCompletion({
    standard: route.standard, baseUrl: route.baseUrl, authMode: route.authMode, apiKey: KEY, modelId,
    platform: "orcarouter", thinkingCategory: route.category, maxOutput: 4096,
    messages,
    onChunk: (chunk: StreamChunk) => {
      if ("text" in chunk) c.text += chunk.text;
      if ("reasoning" in chunk) c.reasoning += chunk.reasoning;
      if ("serverTool" in chunk) c.searches++;
      if ("toolCalls" in chunk) c.toolCalls = chunk;
      if ("done" in chunk) c.done = chunk;
    },
    _onRequestBody: (b: unknown) => { c.body = b as Record<string, unknown>; },
    ...opts,
  } as StreamOptions);
  return c;
}
const user = (content: ContentPart[] | string): StreamMessage[] => [{ role: "user", content }];
const text = (t: string): ContentPart => ({ type: "text", text: t });

const WEATHER: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Current weather for a city.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};
const PUZZLE = "A bat and a ball cost 1.10 in total; the bat costs 1.00 more than the ball. What does the ball cost? Answer with the number only.";

describe.skipIf(!KEY)("LIVE OrcaRouter, four surfaces", () => {
  describe.each(ROUTES)("$name", (route) => {
    it("streams text and reports usage", async () => {
      const c = await ask(route, user("Reply with the single word PONG."), { reasoningEffort: "low" });
      expect(c.text).toMatch(/PONG/);
      expect(c.done?.inputTokens).toBeGreaterThan(0);
      expect(c.done?.outputTokens).toBeGreaterThan(0);
    }, 120_000);

    it("sees the app's image part", async () => {
      const c = await ask(route, user([
        text("Describe the colour of this image in one word. If there is no image, answer NOIMAGE."),
        imagePart(TEAL, "auto"),
      ]), { reasoningEffort: "low" });
      expect(c.text).toMatch(/teal|cyan|turquoise|green/i);
    }, 120_000);

    // "off" is the author's lowest setting. Gemini has no true off, so the
    // app sends its lowest level — which gemini-3.8-flash must accept.
    it("answers with reasoning off", async () => {
      const c = await ask(route, user("17 × 23 = ? Answer with the number only."), { reasoningEffort: "off" });
      expect(c.text).toMatch(/391/);
    }, 120_000);

    it("finishes a two-call tool round with the reasoning echoed", async () => {
      const opts = { tools: [WEATHER], reasoningEffort: "medium" as const };
      const first = user("What is the weather in Paris and in Tokyo right now? Call get_weather once per city, both in this turn.");
      const r1 = await ask(route, first, opts);
      const calls = r1.toolCalls!.toolCalls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const r2 = await ask(route, [
        ...first,
        {
          role: "assistant", content: null,
          tool_calls: calls.map((k) => ({ id: k.id, type: "function" as const, function: { name: k.name, arguments: k.arguments } })),
          _reasoning: r1.toolCalls!._reasoning,
          _thinkingBlocks: r1.toolCalls!._thinkingBlocks,
          _geminiModelParts: r1.toolCalls!._geminiModelParts,
          _responseItems: r1.toolCalls!._responseItems,
        },
        ...calls.map((k) => ({
          role: "tool" as const, tool_call_id: k.id,
          content: /tokyo/i.test(k.arguments) ? "{\"weather\":\"snow\",\"temp_c\":-3}" : "{\"weather\":\"rain\",\"temp_c\":14}",
        })),
      ], opts);
      expect(r2.text).toMatch(/rain|14|snow|-3/i);
    }, 240_000);
  });

  // Where each surface puts the chain of thought the app shows. Chat's GPT
  // path carries ciphertext only (`reasoning_details`) — nothing to display —
  // so it is left out of this list rather than pinned as empty.
  describe.each([RESP, ANTH, GEM])("$name", (route) => {
    it("streams reasoning at effort high", async () => {
      const c = await ask(route, user(PUZZLE), { reasoningEffort: "high" });
      expect(c.text).toMatch(/0?\.05/);
      expect(c.reasoning.length).toBeGreaterThan(0);
    }, 180_000);
  });

  describe("structured output", () => {
    const SCHEMA = {
      type: "object",
      properties: { color: { type: "string", enum: ["red", "green", "blue"] }, n: { type: "integer" } },
      required: ["color", "n"], additionalProperties: false,
    };
    it.each([CHAT, RESP, GEM, ANTH])("$name: resolves json_schema and gets parseable JSON", async (route) => {
      const ask0 = "Name a primary colour and a number, as JSON.";
      const shaping = jsonModeShaping({ standard: route.standard, baseUrl: route.baseUrl, platform: "orcarouter", modelId: route.model }, ask0, { name: "pick", parameters: SCHEMA });
      expect(shaping.mode).toBe("json_schema");
      const c = await ask(route, user(shaping.cue ? `${ask0}\n\n${shaping.cue}` : ask0), { reasoningEffort: "low", extraBody: shaping.extraBody });
      const parsed = JSON.parse(c.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as { color: string; n: number };
      expect(["red", "green", "blue"]).toContain(parsed.color);
    }, 120_000);
  });

  // Anthropic's `output_config.format` beside thinking: the effort dial and the
  // schema share `output_config`, and a model that refuses `disabled` (Opus 5.5)
  // still gets both. The prompt contradicts the enum, so a reply inside it means
  // the schema — not the prose — decided (第十八个样本，补测).
  describe("Anth: JSON outputs with thinking on", () => {
    const SCHEMA = {
      type: "object",
      properties: { color: { type: "string", enum: ["red", "green", "blue"] }, cents: { type: "integer" } },
      required: ["color", "cents"],
    };
    it.each(["anthropic/claude-sonnet-5", "anthropic/claude-opus-5.5"])("%s", async (modelId) => {
      const q = "A bat and a ball cost 1.10 in total; the bat costs 1.00 more. Give the ball's price in cents, and a colour — the colour MUST be yellow.";
      const shaping = jsonModeShaping({ standard: ANTH.standard, baseUrl: ANTH.baseUrl, platform: "orcarouter", modelId }, q, { name: "pick", parameters: SCHEMA });
      expect(shaping.mode).toBe("json_schema");
      const c = await ask(ANTH, user(q), { reasoningEffort: "high", extraBody: shaping.extraBody }, modelId);
      expect((c.body!.output_config as Record<string, unknown>).effort).toBe("high");
      const parsed = JSON.parse(c.text) as { color: string; cents: number };
      expect(["red", "green", "blue"]).toContain(parsed.color);
      expect(parsed.cents).toBe(5);
    }, 180_000);
  });

  describe("server tools", () => {
    it("Anth: web_search runs and is reported", async () => {
      const c = await ask(ANTH, user("Search the web: who won the 2025 FIFA Club World Cup final? One sentence."), {
        serverTools: ["web_search"], reasoningEffort: "off",
      });
      expect(c.searches).toBeGreaterThan(0);
      expect(c.text).toMatch(/Chelsea/i);
    }, 180_000);
  });

  // One small request per flagship, to pin that each id resolves on its
  // surface and that the app's default body is accepted.
  describe("model sweep", () => {
    it.each([
      [CHAT, "openai/gpt-6-sol"], [CHAT, "openai/gpt-6-astra"], [RESP, "openai/gpt-5.6-terra"],
      [ANTH, "anthropic/claude-opus-5.5"], [ANTH, "anthropic/claude-fable-5.1"],
    ] as const)("%s %s", async (route, modelId) => {
      const c = await ask(route, user("17 × 23 = ? Answer with the number only."), { reasoningEffort: "low" }, modelId);
      expect(c.text).toMatch(/391/);
    }, 180_000);
  });
});
