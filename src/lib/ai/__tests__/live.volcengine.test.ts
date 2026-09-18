/**
 * LIVE probe of 火山方舟 Agent / Coding Plan — NOT part of the suite.
 * Runs only when SEEDDACE_KEY (a plan key) is set. Drives the real adapters
 * through `streamCompletion` on both routes the `volcengine-plan` platform
 * lists, so what is verified is the app's own request bodies: `imagePart`,
 * the Chat `file` part and the Anthropic `document` block, the `doubao`
 * thinking category, Anthropic's `thinking` echo across a tool round.
 *
 * The facts it pins are docs/api/landscape.md §7 第十二个样本 (2026-09-18).
 */
import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { streamCompletion } from "../index";
import { imagePart } from "../imagePart";
import { resolvePlatform } from "../platforms";
import { testProviderConnection } from "../providerProbe";
import type {
  ApiStandard, ContentPart, StreamChunk, StreamMessage, StreamOptions, ToolDefinition,
} from "../types";
import type { ThinkingCategoryId } from "../reasoning";

const KEY = process.env.SEEDDACE_KEY ?? "";
const HOST = "https://ark.cn-beijing.volces.com";
type Wire = [ApiStandard, string, ThinkingCategoryId];
const WIRES: Wire[] = [
  ["openai_compat", `${HOST}/api/plan/v3`, "doubao"],
  ["anthropic_compat", `${HOST}/api/plan`, "doubao-switch"],
];
const MODELS = ["doubao-seed-2.0-mini", "doubao-seed-2.0-lite", "doubao-seed-2.1-turbo"];

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

const TEAL = png(64, 64, [0, 128, 128]);
const ASK_COLOUR = "Describe the colour of this image in one word. If there is no image, answer NOIMAGE.";
const ASK_PDF = "What is the secret word and number in the attached document? If you see no document, answer NONE.";

interface Collected {
  text: string;
  reasoning: string;
  inputTokens: number;
  toolCalls?: Extract<StreamChunk, { toolCalls: unknown }>;
}

async function ask(
  [standard, baseUrl, thinkingCategory]: Wire,
  messages: StreamMessage[],
  opts: Partial<StreamOptions> & { modelId?: string } = {},
): Promise<Collected> {
  const c: Collected = { text: "", reasoning: "", inputTokens: 0 };
  await streamCompletion({
    standard, baseUrl, apiKey: KEY, modelId: MODELS[0],
    platform: resolvePlatform(undefined, baseUrl, standard),
    thinkingCategory, reasoningEffort: "off", maxOutput: 2048,
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
const file = (dataUrl: string, filename: string): ContentPart => ({ type: "file", file: { file_data: dataUrl, filename } });

const WEATHER: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Current weather for a city.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

describe.skipIf(!KEY)("LIVE 火山方舟 Plan", () => {
  it("the address infers the plan platform on both routes", () => {
    for (const [standard, base] of WIRES) expect(resolvePlatform(undefined, base, standard)).toBe("volcengine-plan");
  });

  describe.each(WIRES)("%s", (standard, base, cat) => {
    const wire: Wire = [standard, base, cat];

    // No /models under /api/plan (404), so the drawer's test falls back to the
    // completion probe and reads the made-up model's rejection.
    it("passes the channel's connection test, and a wrong key fails it", async () => {
      const ok = await testProviderConnection(base, KEY, standard);
      expect(ok.ok).toBe(true);
      const bad = await testProviderConnection(base, "not-a-key", standard);
      expect(bad.ok).toBe(false);
    }, 60_000);

    it.each(MODELS)("%s streams an answer with thinking off", async (modelId) => {
      const c = await ask(wire, user("用两个字问好。"), { modelId });
      expect(c.text.trim().length).toBeGreaterThan(0);
      expect(c.reasoning).toBe("");
      expect(c.inputTokens).toBeGreaterThan(0);
    }, 120_000);

    it.each(MODELS)("%s sees the app's image part", async (modelId) => {
      const c = await ask(wire, user([text(ASK_COLOUR), imagePart(TEAL, "auto")]), { modelId });
      expect(c.text).toMatch(/teal|cyan|turquoise|green/i);
      // The 64px square is billed ~1300 tokens; a dropped image leaves ~50.
      expect(c.inputTokens).toBeGreaterThan(500);
    }, 120_000);

    it.each(MODELS)("%s reads the app's PDF part", async (modelId) => {
      const c = await ask(wire, user([file(pdf(), "secret.pdf"), text(ASK_PDF)]), { modelId });
      expect(c.text).toMatch(/PELICAN/i);
      expect(c.text).toMatch(/7342/);
    }, 120_000);

    it("thinking on streams reasoning", async () => {
      const c = await ask(wire, user("17 × 23 = ? 只答数字。"), {
        reasoningEffort: cat === "doubao" ? "low" : "high",
        maxOutput: 4096,
      });
      expect(c.text).toMatch(/391/);
      expect(c.reasoning.length).toBeGreaterThan(0);
    }, 180_000);

    it("finishes a tool round with thinking on (the reasoning echo is accepted)", async () => {
      const opts = {
        tools: [WEATHER],
        reasoningEffort: (cat === "doubao" ? "low" : "high") as StreamOptions["reasoningEffort"],
        maxOutput: 4096,
      };
      const first = user("北京现在天气怎样？必须先调用 get_weather 工具。");
      const r1 = await ask(wire, first, opts);
      expect(r1.toolCalls?.toolCalls[0]?.name).toBe("get_weather");
      const call = r1.toolCalls!.toolCalls[0];
      const history: StreamMessage[] = [
        ...first,
        {
          role: "assistant", content: null,
          tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }],
          _reasoning: r1.toolCalls!._reasoning,
          _thinkingBlocks: r1.toolCalls!._thinkingBlocks,
        },
        { role: "tool", tool_call_id: call.id, content: "{\"city\":\"北京\",\"weather\":\"小雨\",\"temp_c\":17}" },
      ];
      const r2 = await ask(wire, history, opts);
      expect(r2.text).toMatch(/雨|17/);
    }, 240_000);
  });
});
