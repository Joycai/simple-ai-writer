/**
 * LIVE probe of a New API relay's Kiro-backed Claude — NOT part of the suite.
 * Runs only when CHENMO_KEY is set. Drives the real adapters through
 * `streamCompletion` on both routes the channel serves (Messages with
 * `claude-adaptive`, Chat Completions with `openai-generic`; it has no
 * Responses or Gemini route — 500 `convert_request_failed`), so what is
 * verified is the app's own request bodies: `imagePart`, the `file` part on
 * each route, thinking + effort, the tool round, and what the capability
 * table's `KIRO_CLAUDE` cells keep off the wire (a forced `tool_choice`,
 * `web_search`, JSON mode).
 *
 * Several cases pin a **failure** the relay hides behind a 200 (the PDF is
 * dropped, `max_tokens` is ignored, Chat's `reasoning_effort: "max"` turns
 * thinking off). If one starts failing, the relay changed — re-probe and
 * update docs/api/landscape.md §7 第十五个样本 (2026-09-23), which these facts
 * pin, and the `KIRO_CLAUDE` matcher in capabilities.ts.
 */
import { describe, expect, it } from "vitest";
import { streamCompletion } from "../index";
import { imagePart } from "../imagePart";
import { jsonModeShaping } from "../jsonMode";
import type {
  ApiStandard, ContentPart, StreamChunk, StreamMessage, StreamOptions, ToolDefinition,
} from "../types";
import type { ThinkingCategoryId } from "../reasoning";

const KEY = process.env.CHENMO_KEY ?? "";
const BASE = "http://42.240.165.241:3000";
const MODELS = ["[特价kiro量]claude-opus-4-6", "[特价kiro量]claude-opus-5"];
type Route = [ApiStandard, ThinkingCategoryId];
const ANTH: Route = ["anthropic_compat", "claude-adaptive"];
const CHAT: Route = ["openai_compat", "openai-generic"];

/** A 64×64 teal PNG (0,128,128), inlined so the probe needs no fixture file. */
const TEAL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATElEQVR42u3PMQkAAAwDsEqv9EnoPQjEQJL2NwEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGB5QDPEgDxM5Bd8gAAAABJRU5ErkJggg==";

/** A one-page PDF whose only content is a line the model could not guess. */
function pdf(): string {
  const text = "BT /F1 18 Tf 20 50 Td (The secret word is PELICAN 7342) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return `data:application/pdf;base64,${Buffer.from(out).toString("base64")}`;
}

interface Collected {
  text: string;
  reasoning: string;
  searches: number;
  body?: Record<string, unknown>;
  toolCalls?: Extract<StreamChunk, { toolCalls: unknown }>;
}

async function ask(
  [standard, thinkingCategory]: Route,
  modelId: string,
  messages: StreamMessage[],
  opts: Partial<StreamOptions> = {},
): Promise<Collected> {
  const c: Collected = { text: "", reasoning: "", searches: 0 };
  await streamCompletion({
    standard, baseUrl: standard === "openai_compat" ? `${BASE}/v1` : BASE, apiKey: KEY, modelId,
    platform: "newapi", thinkingCategory, maxOutput: 4096,
    messages,
    onChunk: (chunk: StreamChunk) => {
      if ("text" in chunk) c.text += chunk.text;
      if ("reasoning" in chunk) c.reasoning += chunk.reasoning;
      if ("serverTool" in chunk) c.searches++;
      if ("toolCalls" in chunk) c.toolCalls = chunk;
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

const ASK_PDF = "What is the secret word and number in the attached document? If you see no document, answer NONE.";
const FORCED: Partial<StreamOptions> = {
  tools: [WEATHER],
  toolChoice: { type: "function", function: { name: "get_weather" } },
};

describe.skipIf(!KEY)("LIVE New API relay, [特价kiro量] Claude", () => {
  describe.each(MODELS)("%s", (modelId) => {
    describe.each([["Anth", ANTH], ["Chat", CHAT]] as const)("%s", (_, route) => {
      it("sees the app's image part", async () => {
        const c = await ask(route, modelId, user([
          text("Describe the colour of this image in one word. If there is no image, answer NOIMAGE."),
          imagePart(TEAL, "auto"),
        ]), { reasoningEffort: "off" });
        expect(c.text).toMatch(/teal|cyan|turquoise|green/i);
      }, 120_000);

      // 200, no error, and the model says there is no document: the relay
      // drops the `document` block / `file` part before it reaches Kiro. The
      // table's `pdfInput` keeps this model out of the PDF subagent.
      it("drops the app's PDF part without an error", async () => {
        const c = await ask(route, modelId, user([
          { type: "file", file: { file_data: pdf(), filename: "secret.pdf" } },
          text(ASK_PDF),
        ]), { reasoningEffort: "off" });
        expect(c.text).not.toMatch(/PELICAN/i);
        expect(c.text).toMatch(/NONE/);
      }, 120_000);

      it("streams reasoning at effort high", async () => {
        const c = await ask(route, modelId, user("17 × 23 = ? Answer with the number only."), { reasoningEffort: "high" });
        expect(c.text).toMatch(/391/);
        expect(c.reasoning.length).toBeGreaterThan(0);
      }, 180_000);

      // The cap is not forwarded: a 16-token ceiling still gets the whole list.
      it("ignores max_tokens", async () => {
        const c = await ask(route, modelId, user("Count from 1 to 60 separated by spaces. Output nothing else."), {
          reasoningEffort: "off", maxOutput: 16,
        });
        expect(c.text).toMatch(/\b60\b/);
      }, 120_000);

      it("finishes a tool round with the reasoning echoed", async () => {
        const opts = { tools: [WEATHER], reasoningEffort: "high" as const };
        const first = user("What is the weather in Paris right now? You must call get_weather first.");
        const r1 = await ask(route, modelId, first, opts);
        const call = r1.toolCalls!.toolCalls[0];
        expect(call.name).toBe("get_weather");
        const r2 = await ask(route, modelId, [
          ...first,
          {
            role: "assistant", content: null,
            tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }],
            _reasoning: r1.toolCalls!._reasoning,
            _thinkingBlocks: r1.toolCalls!._thinkingBlocks,
          },
          { role: "tool", tool_call_id: call.id, content: "{\"city\":\"Paris\",\"weather\":\"sunny\",\"temp_c\":21}" },
        ], opts);
        expect(r2.text).toMatch(/sunny|21/i);
      }, 240_000);

      // The relay honours a forced choice on its non-streamed path only; this
      // app streams, so the table sends `auto` rather than a field that would
      // be ignored (curl, 2026-09-23: Anth 1 call in 32, Chat 0 in 4).
      it("sends a forced tool choice as auto", async () => {
        const c = await ask(route, modelId, user("What is the weather in Paris? Use the tool."), { ...FORCED, reasoningEffort: "off" });
        const tc = c.body!.tool_choice;
        expect(route === ANTH ? tc : { type: tc }).toEqual({ type: "auto" });
        expect(c.toolCalls?.toolCalls[0]?.name).toBe("get_weather");
      }, 180_000);
    });

    it("Anth: thinking blocks carry a signature the relay does not check", async () => {
      const c = await ask(ANTH, modelId, user("What is the weather in Paris right now? You must call get_weather first."), {
        tools: [WEATHER], reasoningEffort: "high",
      });
      expect(c.toolCalls!._thinkingBlocks?.blocks.length).toBeGreaterThan(0);
    }, 180_000);

    // `openai-generic` spells its top level as "max"; this relay maps that
    // (and "none", and anything it doesn't know) to no thinking at all.
    it("Chat: reasoning_effort max turns thinking off", async () => {
      const c = await ask(CHAT, modelId, user("17 × 23 = ? Answer with the number only."), { reasoningEffort: "max" });
      expect(c.body!.reasoning_effort).toBe("max");
      expect(c.text).toMatch(/391/);
      expect(c.reasoning).toBe("");
    }, 180_000);

    // `response_format` is ignored (fenced prose), so the table resolves this
    // model to `off`: no field, the cue alone.
    it("Chat: JSON mode resolves to the cue alone", () => {
      const shaping = jsonModeShaping({ standard: "openai_compat", baseUrl: `${BASE}/v1`, platform: "newapi", modelId }, "json please");
      expect(shaping.mode).toBe("off");
      expect(shaping.extraBody).toBeUndefined();
    });
  });

  // The relay answers a lone `web_search_*` itself (the first user message
  // searched verbatim, a canned list back, no model run), and this app sends
  // the model's server tools on tool-less requests too — so the table keeps
  // it off this model, and a writing request gets writing back.
  it("Anth: sends no web_search for this model, so a writing request is answered", async () => {
    const c = await ask(ANTH, MODELS[1], [
      { role: "system", content: "You are a writing assistant." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello! How can I help?" },
      { role: "user", content: "Rewrite this sentence more vividly: The cat sat on the mat." },
    ], { serverTools: ["web_search"], reasoningEffort: "off" });
    expect(c.body!.tools).toBeUndefined();
    expect(c.searches).toBe(0);
    expect(c.text).not.toMatch(/search results for/);
    expect(c.text).toMatch(/cat/i);
  }, 120_000);
});
