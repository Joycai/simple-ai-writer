/**
 * Opt-in Ark Plan Doubao Seed 2.1 Pro probe. DOUBAO_21_LIVE=1 and SEEDDACE_KEY
 * are both required; no model-list request. Synthetic fixtures only.
 * Official docs and measurements: landscape.md §7 Doubao Seed 2.1 Pro sample.
 * Each request gets a 30-minute outer deadline; streaming uses the app's
 * existing 2-minute first-chunk and 10-minute idle watchdog as well.
 */
import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { streamCompletion } from "../index";
import { imagePart } from "../imagePart";
import type { ApiStandard, StreamChunk, StreamMessage, StreamOptions, ToolDefinition } from "../types";

const KEY = process.env.SEEDDACE_KEY ?? "";
const BASE = "https://ark.cn-beijing.volces.com/api/plan/v3";
const MODEL = "doubao-seed-2.1-pro";
const TIMEOUT = 1_800_000;
const enabled = process.env.DOUBAO_21_LIVE === "1" && !!KEY;
/** A solid-colour PNG, built by hand so the probe needs no fixture file. */
function png(w: number, h: number, rgb: [number, number, number]): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

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


const user = (content: StreamMessage["content"]): StreamMessage[] => [{ role: "user", content } as StreamMessage];
const TOOL: ToolDefinition = { type: "function", function: {
  name: "lookup_code", description: "Returns the secret code for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
} };
const SCHEMA = { type: "object", properties: { answer: { type: "integer", enum: [7] } }, required: ["answer"], additionalProperties: false };

// Bypass prompt shaping and fallback: only the wire field may convey schema
// constraints in these tests. A 200 without a completed answer is not success.
async function raw(standard: ApiStandard, prompt: string, extra: Record<string, unknown>) {
  const responses = standard === "openai_responses_compat";
  const res = await fetch(`${BASE}/${responses ? "responses" : "chat/completions"}`, {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL,
      ...(responses ? { input: prompt, store: false, reasoning: { effort: "low" }, max_output_tokens: 4096 }
        : { messages: user(prompt), reasoning_effort: "low", max_tokens: 4096 }),
      ...extra,
    }), signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.json();
  return { status: res.status, body };
}

function rawText(standard: ApiStandard, body: Record<string, any>): string {
  expect(body.error).toBeFalsy();
  if (standard === "openai_responses_compat") {
    expect(body.status).toBe("completed");
    return body.output.filter((i: { type: string }) => i.type === "message")
      .flatMap((i: { content: { text?: string }[] }) => i.content.map(c => c.text ?? "")).join("");
  }
  expect(body.choices[0].finish_reason).toBe("stop");
  return body.choices[0].message.content;
}

async function ask(standard: ApiStandard, messages: StreamMessage[], opts: Partial<StreamOptions> = {}) {
  let text = "", reasoning = "";
  let calls: Extract<StreamChunk, { toolCalls: unknown }> | undefined;
  let done: Extract<StreamChunk, { done: true }> | undefined;
  let body: Record<string, unknown> | undefined;
  const started = Date.now();
  await streamCompletion({
    standard, baseUrl: BASE, apiKey: KEY, modelId: MODEL, platform: "volcengine-plan",
    reasoningEffort: "low", messages, signal: AbortSignal.timeout(TIMEOUT),
    ...opts,
    _onRequestBody: (b) => { body = b as Record<string, unknown>; },
    onChunk: (chunk) => {
      if ("text" in chunk) text += chunk.text;
      if ("reasoning" in chunk) reasoning += chunk.reasoning;
      if ("toolCalls" in chunk) calls = chunk;
      if ("done" in chunk) done = chunk;
    },
  });
  console.log(JSON.stringify({ standard, effort: opts.reasoningEffort ?? "low", ms: Date.now() - started,
    text, reasoningChars: reasoning.length, inputTokens: done?.inputTokens, outputTokens: done?.outputTokens,
    calls: calls?.toolCalls.map(c => c.name) }));
  expect(done?.truncated).not.toBe(true);
  expect(done?.inputTokens).toBeGreaterThan(0);
  return { text, reasoning, calls, done, body };
}

for (const standard of ["openai_responses_compat", "openai_compat"] as const) {
  describe.skipIf(!enabled)(`LIVE Doubao Seed 2.1 Pro ${standard}`, () => {
    it("records documented aliases and disabled reasoning usage", async () => {
      for (const effort of ["none", "minimal", "xhigh", "max", "disabled"]) {
        const responses = standard === "openai_responses_compat";
        const extra = effort === "disabled"
          ? (responses ? { reasoning: undefined, thinking: { type: "disabled" } }
            : { reasoning_effort: undefined, thinking: { type: "disabled" } })
          : responses ? { reasoning: { effort } } : { reasoning_effort: effort };
        const r = await raw(standard, "What is 17 * 23?", extra);
        expect(r.status).toBe(200);
        expect(rawText(standard, r.body)).toContain("391");
        const tokens = responses ? r.body.usage.output_tokens_details.reasoning_tokens
          : r.body.usage.completion_tokens_details.reasoning_tokens;
        console.log(JSON.stringify({ standard, rawEffort: effort, reasoningTokens: tokens }));
        if (["none", "minimal", "disabled"].includes(effort)) expect(tokens).toBe(0);
        else expect(tokens).toBeGreaterThan(0);
      }
    }, TIMEOUT * 5);
    it("enforces raw schema without a schema prompt or fallback", async () => {
      const format = { name: "sum", schema: SCHEMA, strict: true };
      const r = await raw(standard, "What is 1+1? Return JSON with the correct answer and an extra explanation key.",
        standard === "openai_responses_compat"
          ? { text: { format: { type: "json_schema", ...format } } }
          : { response_format: { type: "json_schema", json_schema: format } });
      expect(r.status).toBe(200);
      expect(JSON.parse(rawText(standard, r.body))).toEqual({ answer: 7 });
    }, TIMEOUT);

    it("supports raw JSON mode and temperature", async () => {
      const r = await raw(standard, "Return a JSON object with answer 2.", standard === "openai_responses_compat"
        ? { text: { format: { type: "json_object" } } } : { response_format: { type: "json_object" } });
      expect(r.status).toBe(200);
      expect(JSON.parse(rawText(standard, r.body))).toEqual({ answer: 2 });
      const sampled = await raw(standard, "Reply OK.", { temperature: 0.2 });
      expect(sampled.status).toBe(200);
      expect(rawText(standard, sampled.body)).toMatch(/OK/);
    }, TIMEOUT * 2);

    it("records raw required enforcement against a no-tools prompt", async () => {
      const r = await raw(standard, "The city is Beijing. Reply OK without calling any tools.", {
        tool_choice: "required",
        tools: standard === "openai_responses_compat" ? [{ type: "function", ...TOOL.function }] : [TOOL],
      });
      expect(r.status).toBe(200);
      expect(r.body.error).toBeFalsy();
      if (standard === "openai_responses_compat") {
        expect(r.body.status).toBe("completed");
        expect(r.body.output.some((i: { type: string }) => i.type === "function_call")).toBe(false);
      } else {
        expect(r.body.choices[0].finish_reason).toBe("stop");
        expect(r.body.choices[0].message.tool_calls?.length ?? 0).toBe(0);
      }
    }, TIMEOUT);

    it.each(["off", "low", "medium", "high"] as const)("streams effort %s", async (reasoningEffort) => {
      const r = await ask(standard, user(reasoningEffort === "off" ? "What is 1+1? Reply with the number only." : "Find the smallest positive integer n such that n mod 7 = 3, n mod 11 = 5, n mod 13 = 7. Reply with n only."), { reasoningEffort });
      expect(r.text).toContain(reasoningEffort === "off" ? "2" : "423");
      if (reasoningEffort === "off") expect(r.reasoning).toBe("");
      else expect(r.reasoning.length).toBeGreaterThan(0);
      if (reasoningEffort !== "off") expect(standard === "openai_compat" ? r.body?.reasoning_effort : (r.body?.reasoning as { effort: string }).effort).toBe(reasoningEffort);
    }, TIMEOUT);

    it("reads an image and a PDF through the app's media projection", async () => {
      const opts = { modelType: "multimodal" as const, pdfInput: true, temperature: 0.2 };
      const img = await ask(standard, user([
        { type: "text", text: "Name the colour in this image. If absent say NONE." }, imagePart(png(64, 64, [0, 128, 128])),
      ]), opts);
      expect(img.text).toMatch(/teal|cyan|青/i);
      expect(img.body).toHaveProperty("temperature", 0.2);
      const doc = await ask(standard, user([
        { type: "text", text: "What is the secret word and number in this document? If absent say NONE." },
        { type: "file", file: { filename: "probe.pdf", file_data: pdf() } },
      ]), opts);
      expect(doc.text).toContain("PELICAN");
      expect(doc.text).toContain("7342");
    }, TIMEOUT * 2);

    it("enforces auto JSON schema against a contradictory prompt", async () => {
      const r = await ask(standard, user("What is 1+1? Return JSON with answer equal to the correct result and an extra explanation key."), {
        structured: { schema: { name: "sum", parameters: SCHEMA } },
      });
      expect(JSON.parse(r.text)).toEqual({ answer: 7 });
    }, TIMEOUT);

    it("completes a tool round with the native reasoning carry", async () => {
      const first = user("Call lookup_code for Beijing, then report its secret code exactly.");
      const r1 = await ask(standard, first, { tools: [TOOL], toolChoice: "required" });
      const call = r1.calls?.toolCalls[0];
      expect(call?.name).toBe("lookup_code");
      expect(r1.body?.tool_choice).toBe("auto");
      if (standard === "openai_compat") {
        expect(r1.calls?._reasoning?.text.length).toBeGreaterThan(0);
        expect(r1.calls?._reasoning?.encrypted?.value.length).toBeGreaterThan(0);
      } else {
        const items = r1.calls?._responseItems?.items as Record<string, unknown>[] | undefined;
        expect(items?.some(i => i.type === "reasoning" && typeof i.encrypted_content === "string"
          && i.encrypted_content.length > 0)).toBe(true);
      }
      expect(JSON.parse(call!.arguments)).toEqual({ city: "Beijing" });
      const r2 = await ask(standard, [...first, {
        role: "assistant", content: null,
        tool_calls: [{ id: call!.id, type: "function", function: { name: call!.name, arguments: call!.arguments } }],
        _carryScope: r1.calls?._carryScope,
        _reasoning: r1.calls?._reasoning, _responseItems: r1.calls?._responseItems,
      }, { role: "tool", tool_call_id: call!.id, content: '{"code":"HERON-5831"}' }], { tools: [TOOL] });
      expect(r2.text).toContain("HERON-5831");
      if (standard === "openai_compat") {
        expect((r2.body?.messages as Record<string, unknown>[])[1].reasoning_content).toBe(r1.calls?._reasoning?.text);
        expect((r2.body?.messages as Record<string, unknown>[])[1].encrypted_content).toBe(r1.calls?._reasoning?.encrypted?.value);
      } else {
        for (const item of r1.calls!._responseItems!.items) {
          expect(r2.body?.input).toContainEqual(item);
        }
      }
    }, TIMEOUT * 2);
  });
}
