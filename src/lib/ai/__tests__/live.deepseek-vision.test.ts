/**
 * LIVE probe of DeepSeek's picture input — NOT part of the suite.
 * Runs only when DEEPSEEK_KEY is set. Drives the real adapters through
 * `streamCompletion` on all three wires the vendor documents, so what is
 * verified is the app's own request bodies (`imagePart`, the Anthropic
 * `blocksOf`, the Responses `input_image` / `input_file` mapping).
 *
 * The facts it pins are docs/api/landscape.md §2.1 (measured 2026-09-17),
 * including the two the app's constants were set from on the docs' word:
 * the 8192px edge (`MAX_IMAGE_EDGE`) and that PDFs are not an input here.
 */
import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { streamCompletion } from "../index";
import { imagePart } from "../imagePart";
import type { ApiStandard, ContentPart, StreamChunk, StreamMessage } from "../types";

const KEY = process.env.DEEPSEEK_KEY ?? "";
const WIRES: [ApiStandard, string][] = [
  ["openai_compat", "https://api.deepseek.com"],
  ["anthropic_compat", "https://api.deepseek.com/anthropic"],
  ["openai_responses_compat", "https://api.deepseek.com"],
];
const [CHAT] = WIRES;

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

interface Collected { text: string; inputTokens: number }
async function ask(
  [standard, baseUrl]: [ApiStandard, string],
  content: ContentPart[],
  modelId = "deepseek-flash",
): Promise<Collected> {
  const c: Collected = { text: "", inputTokens: 0 };
  await streamCompletion({
    standard, baseUrl, apiKey: KEY, modelId,
    messages: [{ role: "user", content }] as StreamMessage[],
    thinkingCategory: "deepseek", reasoningEffort: "off",
    onChunk: (chunk: StreamChunk) => {
      const k = chunk as Record<string, unknown>;
      if (typeof k.text === "string") c.text += k.text;
      if (k.done && typeof k.inputTokens === "number") c.inputTokens = k.inputTokens;
    },
  });
  return c;
}
const text = (t: string): ContentPart => ({ type: "text", text: t });
const file = (dataUrl: string, filename: string): ContentPart => ({ type: "file", file: { file_data: dataUrl, filename } });

describe.skipIf(!KEY)("LIVE DeepSeek vision", () => {
  describe.each(WIRES)("%s", (standard, base) => {
    it("deepseek-flash sees the app's image part", async () => {
      const c = await ask([standard, base], [text(ASK_COLOUR), imagePart(TEAL, "auto")]);
      expect(c.text).toMatch(/teal|cyan|turquoise|green/i);
      // A 64px square is upscaled to ~544² and billed ~180 tokens; a dropped
      // image leaves only the ~30-token prompt.
      expect(c.inputTokens).toBeGreaterThan(150);
    }, 120_000);

    it("a PDF never reaches the model", async () => {
      const p = ask([standard, base], [file(pdf(), "secret.pdf"), text(ASK_PDF)]);
      if (standard === "openai_compat") {
        // The app's nested file part isn't even parsed; the flat one the docs
        // show is parsed and refused (images only) — neither shape reads a PDF.
        await expect(p).rejects.toThrow(/file must have a file_id or file_data/);
      } else {
        // The other two wires answer 200 with the document swapped for an
        // `[Unsupported Document]` placeholder — silent, so pin it.
        const c = await p;
        expect(c.text).not.toMatch(/PELICAN|7342/);
        expect(c.inputTokens).toBeLessThan(100);
      }
    }, 120_000);
  });

  it("detail:low bills a large picture at the 512² rate", async () => {
    const big = png(2000, 2000, [0, 128, 128]);
    const low = await ask(CHAT, [text(ASK_COLOUR), imagePart(big, "low")]);
    const full = await ask(CHAT, [text(ASK_COLOUR), imagePart(big, "auto")]);
    expect(low.inputTokens).toBeLessThan(300);
    expect(full.inputTokens).toBeGreaterThan(900);
  }, 180_000);

  it("8192px is the edge: one pixel more is refused (MAX_IMAGE_EDGE)", async () => {
    const ok = await ask(CHAT, [text(ASK_COLOUR), imagePart(png(8192, 16, [0, 0, 255]), "auto")]);
    expect(ok.text.length).toBeGreaterThan(0);
    // The refusal names the format, not the size — misleading, but it is what
    // an author would see if MAX_IMAGE_EDGE ever stopped holding.
    await expect(ask(CHAT, [text(ASK_COLOUR), imagePart(png(8193, 16, [0, 0, 255]), "auto")]))
      .rejects.toThrow(/unsupported image/);
    await expect(ask(CHAT, [text(ASK_COLOUR), imagePart(png(16, 8193, [0, 0, 255]), "auto")]))
      .rejects.toThrow(/unsupported image/);
  }, 180_000);

  it("a 9×9 picture is accepted as-is (no floor here, unlike DashScope)", async () => {
    const c = await ask(CHAT, [text(ASK_COLOUR), imagePart(png(9, 9, [0, 0, 255]), "auto")]);
    expect(c.text).toMatch(/blue/i);
  }, 120_000);

  it("deepseek-v4-pro drops the picture without an error", async () => {
    const c = await ask(CHAT, [text(ASK_COLOUR), imagePart(TEAL, "auto")], "deepseek-v4-pro");
    // What it answers varies run to run ("NOIMAGE", "Skyblue", "Unable to
    // determine.") — it is guessing. The token count is the stable evidence.
    expect(c.text).not.toMatch(/teal|turquoise/i);
    expect(c.inputTokens).toBeLessThan(60);
  }, 120_000);
});
