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
import type { ServerToolEvent } from "../serverTools";

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

/**
 * A one-page PDF whose only text is a passphrase, built here so the probe needs
 * no fixture file: Helvetica, one content stream, a hand-counted xref.
 */
const PASSPHRASE_PDF = (() => {
  const content = "BT /F1 24 Tf 72 700 Td (The secret word is PELICAN-73.) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return `data:application/pdf;base64,${btoa(out)}`;
})();

interface Collected {
  text: string;
  reasoning: string;
  searches: number;
  /** Every server-tool report, in arrival order. */
  events: ServerToolEvent[];
  body?: Record<string, unknown>;
  toolCalls?: Extract<StreamChunk, { toolCalls: unknown }>;
  done?: Extract<StreamChunk, { done: true }>;
}

async function ask(route: Route, messages: StreamMessage[], opts: Partial<StreamOptions> = {}, modelId = route.model): Promise<Collected> {
  const c: Collected = { text: "", reasoning: "", searches: 0, events: [] };
  await streamCompletion({
    standard: route.standard, baseUrl: route.baseUrl, authMode: route.authMode, apiKey: KEY, modelId,
    platform: "orcarouter", thinkingCategory: route.category, maxOutput: 4096,
    messages,
    onChunk: (chunk: StreamChunk) => {
      if ("text" in chunk) c.text += chunk.text;
      if ("reasoning" in chunk) c.reasoning += chunk.reasoning;
      if ("serverTool" in chunk) { c.searches++; c.events.push(chunk.serverTool); }
      if ("toolCalls" in chunk) c.toolCalls = chunk;
      if ("done" in chunk) c.done = chunk;
    },
    _onRequestBody: (b: unknown) => { c.body = b as Record<string, unknown>; },
    ...opts,
  } as StreamOptions);
  return c;
}
/** Up to three runs, returning the first that streamed any reasoning (else the last). */
async function firstWithReasoning(run: () => Promise<Collected>): Promise<Collected> {
  let c = await run();
  for (let i = 1; i < 3 && !c.reasoning; i++) c = await run();
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
    // Responses streams a summary only on some requests (GPT 全家补测: absent
    // on runs where the model plainly thought), so it gets three tries.
    it("streams reasoning at effort high", async () => {
      const c = await firstWithReasoning(() => ask(route, user(PUZZLE), { reasoningEffort: "high" }));
      expect(c.text).toMatch(/0?\.05/);
      expect(c.reasoning.length).toBeGreaterThan(0);
    }, 540_000);
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

  // Re-measured 2026-09-26 on the streams this app actually reads: ④ and ③
  // report the cost only when asked (`X-OrcaRouter-Include-Cost`), ① and ②
  // either way (landscape.md §7 第十八个样本「再补测」).
  describe("reported cost", () => {
    it.each(ROUTES)("$name: done carries what the request cost", async (route) => {
      const c = await ask(route, user("Reply with the single word PONG."), { reasoningEffort: "low" });
      expect(c.done?.reportedCost).toBeGreaterThan(0);
      expect(c.done!.reportedCost!).toBeLessThan(0.05);
    }, 120_000);
  });

  // A one-page PDF with a passphrase only its text holds. ①② have the file part
  // in the protocol; ④ (`document`) and ③ (`inlineData application/pdf`) are
  // the cells this sample opened.
  describe("PDF input", () => {
    it.each([ANTH, GEM])("$name: reads the passphrase", async (route) => {
      const c = await ask(route, user([
        text("What is the secret word in this PDF? Answer with the word only."),
        { type: "file", file: { filename: "note.pdf", file_data: PASSPHRASE_PDF } },
      ]), { reasoningEffort: "low" });
      expect(c.text).toMatch(/PELICAN-73/);
    }, 120_000);
  });

  // ③'s built-in tools, through the adapter's own spelling and reporting.
  describe("Gem: built-in tools", () => {
    it("googleSearch runs and is reported with its sources", async () => {
      const c = await ask(GEM, user("Search the web: who won the 2025 FIFA Club World Cup final? One sentence."), {
        serverTools: ["web_search"], tools: [WEATHER], reasoningEffort: "low",
      });
      expect((c.body!.tools as unknown[])).toContainEqual({ googleSearch: {} });
      const search = c.events.find((e) => e.name === "web_search" && e.phase === "result");
      expect(search && "results" in search ? search.results.length : 0).toBeGreaterThan(0);
      expect(c.text).toMatch(/Chelsea/i);
    }, 180_000);

    it("urlContext reads a page and reports the URL", async () => {
      const c = await ask(GEM, user("Read https://example.com and tell me the page's heading, nothing else."), {
        serverTools: ["web_search", "web_extractor"], reasoningEffort: "low",
      });
      const read = c.events.find((e) => e.name === "web_extractor" && e.phase === "result");
      expect(read && "results" in read ? read.results[0]?.url : "").toMatch(/example\.com/);
      expect(read && "error" in read ? read.error : undefined).toBeUndefined();
      expect(c.text).toMatch(/Example Domain/i);
    }, 180_000);

    it("codeExecution runs, is reported, and its parts echo back on a tool round", async () => {
      const opts = { serverTools: ["code_interpreter" as const], tools: [WEATHER], reasoningEffort: "low" as const };
      const first = user("Use code execution to compute the 20th Fibonacci number (F1 = F2 = 1). Then call get_weather for the city named Fibonacci-town.");
      const r1 = await ask(GEM, first, opts);
      const run = r1.events.find((e) => e.name === "code_interpreter" && e.phase === "result");
      expect(run && "output" in run ? run.output : "").toMatch(/6765/);
      const calls = r1.toolCalls!.toolCalls;
      expect(r1.toolCalls!._geminiModelParts!.some((p) => !!(p as Record<string, unknown>).executableCode)).toBe(true);
      const r2 = await ask(GEM, [
        ...first,
        {
          role: "assistant", content: null,
          tool_calls: calls.map((k) => ({ id: k.id, type: "function" as const, function: { name: k.name, arguments: k.arguments } })),
          _geminiModelParts: r1.toolCalls!._geminiModelParts,
        },
        ...calls.map((k) => ({ role: "tool" as const, tool_call_id: k.id, content: "{\"weather\":\"sunny\"}" })),
      ], opts);
      // Written as 6,765 as often as 6765.
      expect(r2.text).toMatch(/6,?765/);
    }, 240_000);
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
      [ANTH, "anthropic/claude-opus-5.5"], [ANTH, "anthropic/claude-fable-5.1"],
    ] as const)("%s %s", async (route, modelId) => {
      const c = await ask(route, user("17 × 23 = ? Answer with the number only."), { reasoningEffort: "low" }, modelId);
      expect(c.text).toMatch(/391/);
    }, 180_000);
  });

  // The six GPT ids, each on both OpenAI surfaces (2026-09-27, 第十八个样本「GPT
  // 全家补测」). They sit on three different backends: gpt-6-luna / -sol behind
  // the OpenRouter-shaped layer with OpenAI upstream, gpt-6-astra and
  // gpt-5.6-terra behind the same layer with Azure upstream, and gpt-5.6-luna /
  // -sol answered by OpenAI's own bodies (`chatcmpl-` / `resp_` ids). The cases
  // that pin a refusal or an absence are the sample's findings, not wishes.
  const RAW_OPENAI = ["openai/gpt-5.6-luna", "openai/gpt-5.6-sol"];
  const REJECTED = /400.*upstream_rejected_request/;
  describe.each([
    "openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-luna",
    "openai/gpt-5.6-luna", "openai/gpt-5.6-terra", "openai/gpt-5.6-sol",
  ])("GPT %s", (modelId) => {
    describe.each([CHAT, RESP])("$name", (route) => {
      it("streams text and reports usage", async () => {
        const c = await ask(route, user("Reply with the single word PONG."), {}, modelId);
        expect(c.text).toMatch(/PONG/);
        expect(c.done?.inputTokens).toBeGreaterThan(0);
        expect(c.done?.outputTokens).toBeGreaterThan(0);
      }, 120_000);

      // The raw Responses body carries no cost even with the header (Chat's
      // raw body gets `usage.cost_usd`), so the fee group prices those rows.
      it("reports what the request cost", async () => {
        const c = await ask(route, user("Reply with the single word PONG."), {}, modelId);
        if (route === RESP && RAW_OPENAI.includes(modelId)) expect(c.done?.reportedCost).toBeUndefined();
        else expect(c.done?.reportedCost).toBeGreaterThan(0);
      }, 120_000);

      // gpt-6-astra refuses `none` on both surfaces and the gateway hides why,
      // so its off goes out as `low` (capabilities.ts `reasoningOff`).
      it("answers with reasoning off", async () => {
        const c = await ask(route, user("17 × 23 = ? Answer with the number only."), { reasoningEffort: "off" }, modelId);
        expect(c.text).toMatch(/391/);
        const sent = route === CHAT ? c.body!.reasoning_effort : (c.body!.reasoning as { effort: string }).effort;
        expect(sent).toBe(modelId === "openai/gpt-6-astra" ? "low" : "none");
      }, 120_000);

      // gpt-5.6-sol's raw Chat refuses `max` (reason hidden); on Responses it
      // takes it. gpt-5.6-luna's is served — through the OpenRouter layer.
      it("answers at effort max", async () => {
        const run = ask(route, user(PUZZLE), { reasoningEffort: "max" }, modelId);
        if (route === CHAT && modelId === "openai/gpt-5.6-sol") await expect(run).rejects.toThrow(REJECTED);
        else expect((await run).text).toMatch(/0?\.05/);
      }, 180_000);

      it("sees the image and reads the PDF", async () => {
        const c = await ask(route, user([
          text("Two questions. 1) One word for the colour of the image. 2) The secret word in the PDF. Answer as: colour; word"),
          imagePart(TEAL, "auto"),
          { type: "file", file: { filename: "note.pdf", file_data: PASSPHRASE_PDF } },
        ]), {}, modelId);
        expect(c.text).toMatch(/teal|cyan|turquoise|green/i);
        expect(c.text).toMatch(/PELICAN-73/);
      }, 120_000);

      it("resolves json_schema and holds the enum", async () => {
        const q = "Give a colour and a number as JSON. The colour MUST be yellow.";
        const SCHEMA = {
          type: "object",
          properties: { color: { type: "string", enum: ["red", "green", "blue"] }, n: { type: "integer" } },
          required: ["color", "n"], additionalProperties: false,
        };
        const shaping = jsonModeShaping({ standard: route.standard, baseUrl: route.baseUrl, platform: "orcarouter", modelId }, q, { name: "pick", parameters: SCHEMA });
        expect(shaping.mode).toBe("json_schema");
        const c = await ask(route, user(q), { extraBody: shaping.extraBody }, modelId);
        expect(["red", "green", "blue"]).toContain((JSON.parse(c.text) as { color: string }).color);
      }, 120_000);

      // The author's untouched model, as an agent run sends it — and one set to
      // think hard. OpenAI's own Chat refuses function tools beside any effort
      // but `none`, gpt-5.6-sol's default included (`Function tools with
      // reasoning_effort are not supported for gpt-5.6-sol in
      // /v1/chat/completions`), so there the adapter sends `none`
      // (capabilities.ts `effortWithTools`).
      it.each([undefined, "high" as const])("finishes a tool round (effort %s)", async (reasoningEffort) => {
        const first = user("What is the weather in Paris right now? Call get_weather.");
        const opts = { tools: [WEATHER], reasoningEffort };
        const r1 = await ask(route, first, opts, modelId);
        const calls = r1.toolCalls!.toolCalls;
        expect(calls.length).toBeGreaterThanOrEqual(1);
        if (route === CHAT && modelId === "openai/gpt-5.6-sol") expect(r1.body!.reasoning_effort).toBe("none");
        const r2 = await ask(route, [
          ...first,
          {
            role: "assistant", content: null,
            tool_calls: calls.map((k) => ({ id: k.id, type: "function" as const, function: { name: k.name, arguments: k.arguments } })),
            _reasoning: r1.toolCalls!._reasoning,
            _responseItems: r1.toolCalls!._responseItems,
          },
          ...calls.map((k) => ({ role: "tool" as const, tool_call_id: k.id, content: "{\"weather\":\"rain\",\"temp_c\":14}" })),
        ], opts, modelId);
        expect(r2.text).toMatch(/rain|14/i);
      }, 240_000);
    });

    // gpt-5.6-sol's Responses refuses any temperature (OpenAI's words), so the
    // adapter leaves the author's out (capabilities.ts `temperature`).
    it("Resp: sends the row's temperature where the model takes one", async () => {
      const c = await ask(RESP, user("Reply with the single word PONG."), { temperature: 0.5 }, modelId);
      expect(c.text).toMatch(/PONG/);
      if (modelId === "openai/gpt-5.6-sol") expect(c.body).not.toHaveProperty("temperature");
      else expect(c.body!.temperature).toBe(0.5);
    }, 120_000);

    it("Resp: streams a reasoning summary at effort high", async () => {
      const c = await firstWithReasoning(() => ask(RESP, user("Is 1,000,003 prime? Think it through, then answer yes or no."), { reasoningEffort: "high" }, modelId));
      expect(c.text).toMatch(/yes|no/i);
      expect(c.reasoning.length).toBeGreaterThan(0);
    }, 720_000);
  });
});
