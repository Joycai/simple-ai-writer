/**
 * LIVE probe of the ② OpenAI Responses family — NOT part of the suite.
 * Runs only when OPENAI_KEY is set. Drives the real adapter through
 * `streamCompletion`, so what is verified is the app's own request bodies and
 * its own reading of the stream, not a hand-written imitation.
 *
 *   OPENAI_KEY=sk-…                         the key (official or a relay's)
 *   OPENAI_RESPONSES_BASE=https://…/v1      default: the official base
 *   OPENAI_RESPONSES_MODELS=a,b,c           default: gpt-5.4,gpt-5.5,gpt-5.6-sol
 *                                           (a relay may spell them `[Pro]gpt-5.4`)
 *
 * The standard is `openai_responses` on the official base and the compat half
 * anywhere else, which is also what decides the connection test's fallback.
 * docs/api/qianwen-compat-plan.md §6 I; the facts it checks are the ones in
 * docs/api/responses.md, and the three left open in the plan's §4.5.
 */
import { describe, expect, it } from "vitest";
import { streamCompletion } from "../ai";
import { jsonModeShaping } from "../ai/jsonMode";
import { fetchRemoteModels, testProviderConnection } from "../ai/providerProbe";
import { DEFAULT_OPENAI_BASE } from "../ai/urls";
import type { ApiStandard, StreamChunk, StreamMessage, StreamOptions } from "../ai/types";

const KEY = process.env.OPENAI_KEY ?? "";
const BASE = process.env.OPENAI_RESPONSES_BASE ?? DEFAULT_OPENAI_BASE;
const MODELS = (process.env.OPENAI_RESPONSES_MODELS ?? "gpt-5.4,gpt-5.5,gpt-5.6-sol").split(",").map((s) => s.trim()).filter(Boolean);
const STANDARD: ApiStandard = BASE.replace(/\/+$/, "") === DEFAULT_OPENAI_BASE ? "openai_responses" : "openai_responses_compat";
/** GPT-5.4's effort ceiling is `xhigh`; `max` is a 400 there (responses.md §2.1). */
const capsAtXhigh = (m: string) => /5\.4/.test(m);

const PROMPT: StreamMessage[] = [{ role: "user", content: "In one word: what colour is the sky on a clear day?" }];

interface Collected {
  text: string; reasoning: string; toolCalls: { id: string; name: string; arguments: string }[];
  items?: { modelId: string; items: unknown[] }; done?: Record<string, unknown>; bodies: Record<string, unknown>[];
}
async function run(partial: Partial<StreamOptions> & Pick<StreamOptions, "modelId">): Promise<Collected> {
  const c: Collected = { text: "", reasoning: "", toolCalls: [], bodies: [] };
  await streamCompletion({
    standard: STANDARD, baseUrl: BASE, apiKey: KEY,
    messages: PROMPT,
    onChunk: (chunk: StreamChunk) => {
      const k = chunk as Record<string, unknown>;
      if (typeof k.text === "string") c.text += k.text;
      if (typeof k.reasoning === "string") c.reasoning += k.reasoning;
      if (Array.isArray(k.toolCalls)) {
        c.toolCalls.push(...(k.toolCalls as Collected["toolCalls"]));
        c.items = k._responseItems as Collected["items"];
      }
      if (k.done) c.done = k;
    },
    _onRequestBody: (b) => c.bodies.push(b as Record<string, unknown>),
    ...partial,
  });
  return c;
}

const TOOLS = [{
  type: "function", function: {
    name: "get_weather", description: "Look up the current weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
}] as StreamOptions["tools"];
const WEATHER: StreamMessage[] = [{ role: "user", content: "What is the weather in Beijing right now? Use the tool." }];

/** A minimal, well-formed one-page PDF whose only text is `word`, as a data URL. */
function tinyPdf(word: string): string {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    (() => { const s = `BT /F1 24 Tf 20 40 Td (${word}) Tj ET`; return `<< /Length ${s.length} >>\nstream\n${s}\nendstream`; })(),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return `data:application/pdf;base64,${Buffer.from(out, "latin1").toString("base64")}`;
}

// 16×16 solid red PNG — small enough to cost nothing, large enough for every reader.
const RED_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGO4IyJCEmIY1TCqQWTYagAAAnEEEPBHj2sAAAAASUVORK5CYII=";

describe.skipIf(!KEY)("LIVE OpenAI Responses", () => {
  it("connection test lists models (or falls back to POST /responses on a relay without /models)", async () => {
    const r = await testProviderConnection(BASE, KEY, STANDARD);
    expect(r).toMatchObject({ ok: true });
    try {
      const ids = (await fetchRemoteModels(BASE, KEY, STANDARD)).map((m) => m.id);
      console.info(`models listed: ${ids.length}; probe models present: ${MODELS.filter((m) => ids.includes(m)).join(", ") || "none"}`);
    } catch (e) {
      console.info(`no /models here: ${e instanceof Error ? e.message : e}`);
    }
    const bad = await testProviderConnection(BASE, "sk-bad", STANDARD);
    expect(bad.ok).toBe(false);
  }, 60_000);

  describe.each(MODELS)("%s", (m) => {
    it("text: default (no effort sent) streams and ends on response.completed with usage", async () => {
      const c = await run({ modelId: m });
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.done).toMatchObject({ done: true, stopReason: "completed" });
      expect((c.done!.outputTokens as number) > 0).toBe(true);
      const body = c.bodies[0];
      expect(body).toMatchObject({ store: false, instructions: "" });
      expect(body).not.toHaveProperty("reasoning");
    }, 120_000);

    it("effort off → reasoning:{effort:none}, no summary events", async () => {
      const c = await run({ modelId: m, reasoningEffort: "off" });
      expect(c.bodies[0].reasoning).toEqual({ effort: "none" });
      expect(c.reasoning).toBe("");
      expect(c.text.length).toBeGreaterThan(0);
    }, 120_000);

    it("effort medium → reasoning:{effort,summary:auto}; summary arrives when the model actually reasoned", async () => {
      const c = await run({
        modelId: m, reasoningEffort: "medium",
        messages: [{ role: "user", content: "Which is larger, 9.11 or 9.9? Think it through, then answer in one line." }],
      });
      expect(c.bodies[0].reasoning).toEqual({ effort: "medium", summary: "auto" });
      expect(c.text.length).toBeGreaterThan(0);
      // Not asserted: the same request has come back with and without a
      // reasoning item (responses.md §2.1) — recorded so the run says which.
      console.info(`${m} medium: summary chars=${c.reasoning.length}, output tokens=${c.done?.outputTokens}`);
    }, 180_000);

    it("effort max: a 400 naming the legal values on 5.4, accepted on 5.5 / 5.6", async () => {
      const p = run({ modelId: m, reasoningEffort: "max" });
      if (capsAtXhigh(m)) await expect(p).rejects.toThrow(/Unsupported value|not supported/i);
      else expect((await p).text.length).toBeGreaterThan(0);
    }, 180_000);

    it("incomplete on max_output_tokens → truncated, stopReason max_output_tokens", async () => {
      const c = await run({
        modelId: m, reasoningEffort: "off", extraBody: { max_output_tokens: 16 },
        messages: [{ role: "user", content: "Write three paragraphs about the sea." }],
      });
      expect(c.done).toMatchObject({ done: true, truncated: true, stopReason: "max_output_tokens" });
    }, 120_000);

    it("tools: a call, its items echoed verbatim, and the second turn answers from the result", async () => {
      const first = await run({ modelId: m, messages: WEATHER, tools: TOOLS, reasoningEffort: "medium" });
      expect(first.toolCalls.length).toBeGreaterThan(0);
      const call = first.toolCalls[0];
      expect(call.name).toBe("get_weather");
      expect(JSON.parse(call.arguments)).toHaveProperty("city");
      expect(first.items?.modelId).toBe(m);
      const kinds = (first.items?.items ?? []).map((i) => (i as { type: string }).type);
      expect(kinds).toContain("function_call");
      const reasoningItem = (first.items?.items ?? []).find((i) => (i as { type: string }).type === "reasoning") as { encrypted_content?: string } | undefined;
      console.info(`${m} tool turn items: ${kinds.join(",")}; encrypted_content=${reasoningItem?.encrypted_content ? reasoningItem.encrypted_content.length + " chars" : "absent"}`);
      // The tools went out flat, non-strict, and the named form of tool_choice was not needed.
      expect((first.bodies[0].tools as Record<string, unknown>[])[0]).toMatchObject({ type: "function", name: "get_weather", strict: false });

      const history: StreamMessage[] = [
        ...WEATHER,
        {
          role: "assistant", content: null,
          tool_calls: first.toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.arguments } })),
          _responseItems: first.items,
        },
        ...first.toolCalls.map((tc) => ({ role: "tool" as const, tool_call_id: tc.id, content: JSON.stringify({ city: "Beijing", temperature_c: 27, sky: "clear" }) })),
      ];
      const second = await run({ modelId: m, messages: history, tools: TOOLS, reasoningEffort: "medium" });
      expect(second.text).toMatch(/27/);
      // The echo: the turn's own items, then the output, all in `input`.
      const input = second.bodies[0].input as Record<string, unknown>[];
      const types = input.map((i) => i.type ?? i.role);
      expect(types).toEqual(expect.arrayContaining(["user", "function_call", "function_call_output"]));
      if (reasoningItem) expect(types).toContain("reasoning");
    }, 300_000);

    it("forced tool_choice while thinking is legal here (no 400, no downgrade needed)", async () => {
      const c = await run({
        modelId: m, messages: WEATHER, tools: TOOLS, reasoningEffort: "medium",
        toolChoice: { type: "function", function: { name: "get_weather" } },
      });
      expect(c.toolCalls.length).toBeGreaterThan(0);
      // One request only — a retry would mean the endpoint refused the forced form.
      expect(c.bodies).toHaveLength(1);
      expect(c.bodies[0].tool_choice).toEqual({ type: "function", name: "get_weather" });
    }, 180_000);

    it("json_schema under text.format (no strict key) → the reply matches the schema", async () => {
      const schema = { name: "answer", parameters: { type: "object", properties: { colour: { type: "string" }, confidence: { type: "number" } }, required: ["colour"] } };
      const shaping = jsonModeShaping({ standard: STANDARD, baseUrl: BASE, modelId: m, structuredOutput: "json_schema" }, "", schema);
      expect(shaping.mode).toBe("json_schema");
      const c = await run({ modelId: m, reasoningEffort: "off", extraBody: shaping.extraBody });
      const format = (c.bodies[0].text as { format: Record<string, unknown> }).format;
      expect(format.type).toBe("json_schema");
      expect(format).not.toHaveProperty("strict");
      const parsed = JSON.parse(c.text);
      expect(typeof parsed.colour).toBe("string");
      expect(Object.keys(parsed).sort()).toEqual(["colour", "confidence"]);
    }, 120_000);

    it("json_object under text.format → valid JSON", async () => {
      const shaping = jsonModeShaping({ standard: STANDARD, baseUrl: BASE, modelId: m, structuredOutput: "json_object" }, "", undefined);
      const c = await run({
        modelId: m, reasoningEffort: "off", extraBody: shaping.extraBody,
        messages: [{ role: "user", content: `Answer as a JSON object with one key "colour": what colour is the sky? ${shaping.cue ?? ""}` }],
      });
      expect(() => JSON.parse(c.text)).not.toThrow();
    }, 120_000);

    it("input_image: a data-URL picture is read", async () => {
      const c = await run({
        modelId: m, reasoningEffort: "off",
        messages: [{ role: "user", content: [{ type: "text", text: "What colour is this image? One word." }, { type: "image_url", image_url: { url: RED_PNG } }] }],
      });
      expect(c.text).toMatch(/red/i);
    }, 120_000);

    it("input_file: a data-URL PDF is read (unverified before this run — responses.md §9)", async () => {
      const c = await run({
        modelId: m, reasoningEffort: "off",
        messages: [{ role: "user", content: [{ type: "text", text: "What is the only word printed in this PDF? Reply with just that word." }, { type: "file", file: { file_data: tinyPdf("PINEAPPLE"), filename: "one-word.pdf" } }] }],
      });
      expect(c.text).toMatch(/pineapple/i);
    }, 120_000);
  });
});
