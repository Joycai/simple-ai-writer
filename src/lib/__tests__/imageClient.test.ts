/**
 * Response handling for the image client — the part that differs most between
 * providers and is invisible until a real generation is paid for.
 *
 * Covers the three shapes an endpoint can answer in (inline base64, a signed
 * URL, or a refusal dressed as a 200) plus the parameter decisions that break
 * whole providers when wrong: `size` must be absent unless asked for, since
 * xAI rejects the field outright.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateImage, NoImageError } from "../ai/image";

const OPENAI = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "k",
  standard: "openai" as const,
  modelId: "img-1",
};

const GEMINI = {
  baseUrl: "https://gem.example.com/v1beta",
  apiKey: "k",
  standard: "gemini" as const,
  modelId: "gemini-image",
};

/** Stub fetch with one JSON response, recording what was sent. */
function mockJson(payload: unknown, status = 200) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("generateImage · OpenAI shape", () => {
  it("turns b64_json into a data URL and reports token usage", async () => {
    mockJson({
      data: [{ b64_json: "aGk=" }],
      usage: { input_tokens: 12, output_tokens: 34 },
    });
    const res = await generateImage(OPENAI, { prompt: "a cat" });
    expect(res.images).toHaveLength(1);
    expect(res.images[0].dataUrl).toBe("data:image/png;base64,aGk=");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
  });

  it("omits `size` unless the caller asked for one", async () => {
    const calls = mockJson({ data: [{ b64_json: "aGk=" }] });
    await generateImage(OPENAI, { prompt: "a cat" });
    expect(calls[0].body).not.toHaveProperty("size");

    vi.unstubAllGlobals();
    const sized = mockJson({ data: [{ b64_json: "aGk=" }] });
    await generateImage(OPENAI, { prompt: "a cat", size: "1024x1024" });
    expect(sized[0].body.size).toBe("1024x1024");
  });

  it("downloads a URL response into bytes rather than storing the link", async () => {
    // Signed URLs expire; a gallery entry pointing at one would rot within the
    // hour, so the adapter must inline the bytes at generation time.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.com/x?sig=1" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      }),
    );
    const res = await generateImage(OPENAI, { prompt: "a cat" });
    expect(call).toBe(2);
    expect(res.images[0].dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(atob(res.images[0].dataUrl.split(",")[1])).toBe("\x89PNG");
  });

  it("surfaces an error delivered inside a 200 body", async () => {
    mockJson({ error: { message: "content policy" } });
    await expect(generateImage(OPENAI, { prompt: "x" })).rejects.toThrow(/content policy/);
  });

  it("throws NoImageError when the response carries no image", async () => {
    mockJson({ data: [] });
    await expect(generateImage(OPENAI, { prompt: "x" })).rejects.toBeInstanceOf(NoImageError);
  });
});

describe("generateImage · Gemini shape", () => {
  it("extracts inlineData and keeps any accompanying text", async () => {
    const calls = mockJson({
      candidates: [{
        content: { parts: [{ text: "here you go" }, { inlineData: { mimeType: "image/webp", data: "aGk=" } }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1290 },
    });
    const res = await generateImage(GEMINI, { prompt: "a cat" });
    expect(calls[0].url).toContain(":generateContent");
    expect((calls[0].body.generationConfig as Record<string, unknown>).responseModalities)
      .toEqual(["TEXT", "IMAGE"]);
    expect(res.images[0]).toEqual({ dataUrl: "data:image/webp;base64,aGk=", mime: "image/webp" });
    expect(res.text).toBe("here you go");
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 1290 });
  });

  it("reports a blocked prompt as a safety refusal", async () => {
    mockJson({ promptFeedback: { blockReason: "SAFETY" } });
    await expect(generateImage(GEMINI, { prompt: "x" })).rejects.toThrow(/SAFETY/);
  });

  it("names the finish reason when a candidate came back imageless", async () => {
    mockJson({ candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }] });
    await expect(generateImage(GEMINI, { prompt: "x" })).rejects.toThrow(/IMAGE_SAFETY/);
  });
});

describe("generateImage · editing", () => {
  it("refuses input images instead of silently generating something unrelated", async () => {
    mockJson({ data: [{ b64_json: "aGk=" }] });
    await expect(
      generateImage(OPENAI, { prompt: "make it blue", images: ["data:image/png;base64,aGk="] }),
    ).rejects.toThrow(/not implemented/i);
  });
});
