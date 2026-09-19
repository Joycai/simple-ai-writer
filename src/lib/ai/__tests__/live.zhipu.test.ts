/**
 * LIVE probe of 智谱 BigModel's standard endpoint — NOT part of the suite.
 * Runs only when GLM_KEY (a pay-as-you-go key) is set. Drives the real adapter
 * through `streamCompletion` / `testProviderConnection` on the one route the
 * `zhipu` platform lists, so what is verified is the app's own request bodies:
 * the `glm` / `glm-switch` thinking categories, `imagePart` and the Chat `file`
 * part, the reasoning echo across a tool round, and the platform's downgrade of
 * a forced `tool_choice` (glm-4.7 refuses a named one while thinking).
 *
 * The facts it pins are docs/api/landscape.md §7 第十四个样本 (2026-09-19).
 */
import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { streamCompletion } from "../index";
import { imagePart } from "../imagePart";
import { resolvePlatform } from "../platforms";
import { testProviderConnection } from "../providerProbe";
import type { ContentPart, StreamChunk, StreamMessage, StreamOptions, ToolDefinition } from "../types";
import type { ThinkingCategoryId } from "../reasoning";

const KEY = process.env.GLM_KEY ?? "";
const BASE = "https://open.bigmodel.cn/api/paas/v4";
/** The three measured models and the category each starter row carries. */
const MODELS: [string, ThinkingCategoryId][] = [
  ["glm-4.5-air", "glm-switch"],
  ["glm-4.7", "glm-switch"],
  ["glm-5.3-flash", "glm"],
];
/** The lightest setting each category allows: off for the switch, `low` for 5.3 (it cannot stop thinking). */
const lightest = (cat: ThinkingCategoryId): StreamOptions["reasoningEffort"] => (cat === "glm" ? "low" : "off");

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

interface Collected {
  text: string;
  reasoning: string;
  inputTokens: number;
  toolCalls?: Extract<StreamChunk, { toolCalls: unknown }>;
}

async function ask(
  modelId: string,
  thinkingCategory: ThinkingCategoryId,
  messages: StreamMessage[],
  opts: Partial<StreamOptions> = {},
): Promise<Collected> {
  const c: Collected = { text: "", reasoning: "", inputTokens: 0 };
  await streamCompletion({
    standard: "openai_compat", baseUrl: BASE, apiKey: KEY, modelId,
    platform: resolvePlatform(undefined, BASE, "openai_compat"),
    thinkingCategory, reasoningEffort: lightest(thinkingCategory), maxOutput: 4096,
    messages,
    onChunk: (chunk: StreamChunk) => {
      if ("text" in chunk) c.text += chunk.text;
      if ("reasoning" in chunk) c.reasoning += chunk.reasoning;
      if ("toolCalls" in chunk) c.toolCalls = chunk;
      if ("done" in chunk) c.inputTokens = chunk.inputTokens;
    },
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

describe.skipIf(!KEY)("LIVE 智谱 BigModel", () => {
  it("the address infers the zhipu platform", () => {
    expect(resolvePlatform(undefined, BASE, "openai_compat")).toBe("zhipu");
  });

  it("passes the channel's connection test, and a wrong key fails it", async () => {
    expect((await testProviderConnection(BASE, KEY, "openai_compat")).ok).toBe(true);
    expect((await testProviderConnection(BASE, "not-a-key", "openai_compat")).ok).toBe(false);
  }, 60_000);

  it.each(MODELS)("%s streams an answer at its lightest thinking", async (modelId, cat) => {
    const c = await ask(modelId, cat, user("用两个字问好。"));
    expect(c.text.trim().length).toBeGreaterThan(0);
    expect(c.inputTokens).toBeGreaterThan(0);
    // The switch really switches: nothing streams as reasoning once it is off.
    if (cat === "glm-switch") expect(c.reasoning).toBe("");
  }, 120_000);

  it.each(MODELS.filter(([, cat]) => cat === "glm-switch"))(
    "%s thinks when the switch is left unset (the endpoint's default)",
    async (modelId, cat) => {
      const c = await ask(modelId, cat, user("17 × 23 = ? 只答数字。"), { reasoningEffort: undefined });
      expect(c.text).toMatch(/391/);
      expect(c.reasoning.length).toBeGreaterThan(0);
    },
    180_000,
  );

  it("glm-5.3-flash sees the app's image part and reads its PDF part", async () => {
    const img = await ask("glm-5.3-flash", "glm", user([
      text("Describe the colour of this image in one word. If there is no image, answer NOIMAGE."),
      imagePart(png(64, 64, [0, 128, 128]), "auto"),
    ]));
    // Teal (0,128,128) reads as "Blue" at `low` and "Teal" at the default —
    // either way the picture arrived; a dropped one answers NOIMAGE.
    expect(img.text).not.toMatch(/NOIMAGE/i);
    expect(img.text).toMatch(/teal|cyan|turquoise|green|blue/i);
    const doc = await ask("glm-5.3-flash", "glm", user([
      { type: "file", file: { file_data: pdf(), filename: "secret.pdf" } },
      text("What is the secret word and number in the attached document? If you see no document, answer NONE."),
    ]));
    expect(doc.text).toMatch(/PELICAN/i);
    expect(doc.text).toMatch(/7342/);
  }, 180_000);

  it.each(MODELS)("%s finishes a tool round with thinking on (the reasoning echo is accepted)", async (modelId, cat) => {
    const opts = { tools: [WEATHER], reasoningEffort: (cat === "glm" ? "low" : "high") as StreamOptions["reasoningEffort"] };
    const first = user("北京现在天气怎样？必须先调用 get_weather 工具。");
    const r1 = await ask(modelId, cat, first, opts);
    expect(r1.toolCalls?.toolCalls[0]?.name).toBe("get_weather");
    const call = r1.toolCalls!.toolCalls[0];
    const history: StreamMessage[] = [
      ...first,
      {
        role: "assistant", content: null,
        tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }],
        _reasoning: r1.toolCalls!._reasoning,
      },
      { role: "tool", tool_call_id: call.id, content: "{\"city\":\"北京\",\"weather\":\"小雨\",\"temp_c\":17}" },
    ];
    const r2 = await ask(modelId, cat, history, opts);
    expect(r2.text).toMatch(/雨|17/);
  }, 240_000);

  // GLM-5.2's `none` keeps thinking; the category's off is the switch.
  it("glm-5.2 under glm-effort: off stops thinking, max thinks", async () => {
    const off = await ask("glm-5.2", "glm-effort", user("17 × 23 = ? 只答数字。"), { reasoningEffort: "off" });
    expect(off.text).toMatch(/391/);
    expect(off.reasoning).toBe("");
    const max = await ask("glm-5.2", "glm-effort", user("17 × 23 = ? 只答数字。"), { reasoningEffort: "max" });
    expect(max.text).toMatch(/391/);
    expect(max.reasoning.length).toBeGreaterThan(0);
  }, 180_000);

  // Unforced, this is `400 1210 API 调用参数有误` on glm-4.7 with thinking on.
  it("a named tool_choice goes out as auto, so glm-4.7 with thinking on still answers", async () => {
    const c = await ask("glm-4.7", "glm-switch", user("北京现在天气怎样？"), {
      tools: [WEATHER], toolChoice: { type: "function", function: { name: "get_weather" } }, reasoningEffort: "high",
    });
    expect(c.toolCalls || c.text.trim()).toBeTruthy();
  }, 180_000);
});
