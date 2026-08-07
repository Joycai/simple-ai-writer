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
import { generateImage, ImageHttpError, isEditUnsupportedError, NoImageError } from "../ai/image";

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

  it("asks for the bytes, not a link", async () => {
    // A signed-URL response costs a second network round-trip that can fail
    // after the generation is already billed. `extraBody` can still drop the
    // field for relays that reject it.
    const calls = mockJson({ data: [{ b64_json: "aGk=" }] });
    await generateImage(OPENAI, { prompt: "a cat" });
    expect(calls[0].body.response_format).toBe("b64_json");

    vi.unstubAllGlobals();
    const overridden = mockJson({ data: [{ b64_json: "aGk=" }] });
    await generateImage(OPENAI, { prompt: "a cat", extraBody: { response_format: undefined } });
    expect(overridden[0].body.response_format).toBeUndefined();
  });

  it("retries without response_format when the endpoint rejects the field", async () => {
    // gpt-image-1 always returns base64 and refuses the parameter. Failing
    // here would mean the app could not use it at all without the author
    // discovering `extraBody`.
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      call++;
      return call === 1
        ? new Response(JSON.stringify({
            error: { message: "Unknown parameter: 'response_format'.", param: "response_format" },
          }), { status: 400, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
    }));

    const res = await generateImage(OPENAI, { prompt: "a cat" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format).toBe("b64_json");
    expect(bodies[1]).not.toHaveProperty("response_format");
    expect(res.images).toHaveLength(1);
    // And it is not read as "this endpoint cannot edit" — that would bill a
    // second full generation on the edit path.
    expect(isEditUnsupportedError(new ImageHttpError("Image edit error", 400,
      JSON.stringify({ error: { message: "Unknown parameter: 'response_format'.", param: "response_format" } })))).toBe(false);
  });

  it("sends `n` only when it isn't the default", async () => {
    // dall-e-3 rejects any n but 1, and omitting it means 1 everywhere — the
    // same rule the edit and Gemini routes already followed.
    const one = mockJson({ data: [{ b64_json: "aGk=" }] });
    await generateImage(OPENAI, { prompt: "x", n: 1 });
    expect(one[0].body).not.toHaveProperty("n");

    vi.unstubAllGlobals();
    const many = mockJson({ data: [{ b64_json: "aGk=" }, { b64_json: "aGk=" }] });
    await generateImage(OPENAI, { prompt: "x", n: 2 });
    expect(many[0].body.n).toBe(2);
  });

  it("reads the format off the bytes instead of assuming PNG", async () => {
    // gpt-image-1 takes an output_format, and relays return whatever their
    // upstream produced — a JPEG saved as `.png` opens nowhere.
    const jpeg = btoa("\xff\xd8\xff\xe0\x00\x10JFIF");
    mockJson({ data: [{ b64_json: jpeg }] });
    const res = await generateImage(OPENAI, { prompt: "x" });
    expect(res.images[0].mime).toBe("image/jpeg");
  });

  it("accepts base64 delivered in the `url` field", async () => {
    // A common relay habit. Fetching it as a link happens to work in a browser
    // and does not in Tauri's reqwest transport.
    mockJson({ data: [{ url: "data:image/webp;base64,aGk=" }] });
    const res = await generateImage(OPENAI, { prompt: "x" });
    expect(res.images[0]).toEqual({ dataUrl: "data:image/webp;base64,aGk=", mime: "image/webp" });
  });

  it("refuses a download that isn't an image", async () => {
    // A relay answering 200 with an HTML error page otherwise lands in the
    // gallery as an unopenable `.png` while the UI reports success.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(JSON.stringify({ data: [{ url: "https://cdn.example.com/x" }] }), {
              status: 200, headers: { "content-type": "application/json" },
            })
          : new Response("<html>gateway error</html>", {
              status: 200, headers: { "content-type": "text/html" },
            })),
    );
    await expect(generateImage(OPENAI, { prompt: "x" })).rejects.toThrow(/rather than an image/);
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

describe("generateImage · chat route", () => {
  // newAPI-style relays serve non-Imagen image models here; their
  // /images/generations answers "only imagen models are supported".
  const RELAY = { ...OPENAI, standard: "openai_compat" as const, route: "chat" as const };

  it("posts to /chat/completions instead of the images endpoint", async () => {
    const calls = mockJson({
      choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,aGk=" } }] } }],
    });
    const res = await generateImage(RELAY, { prompt: "a cat" });
    expect(calls[0].url).toBe("https://api.example.com/v1/chat/completions");
    expect(calls[0].body.model).toBe("img-1");
    expect(res.images[0].dataUrl).toBe("data:image/png;base64,aGk=");
  });

  it("pulls the image out of markdown in the message text", async () => {
    mockJson({
      choices: [{ message: { content: "画好了：\n![img](data:image/webp;base64,aGk=)" } }],
    });
    const res = await generateImage(RELAY, { prompt: "a cat" });
    expect(res.images[0].mime).toBe("image/webp");
    // The prose around the image survives as commentary, without the markdown.
    expect(res.text).toBe("画好了：");
  });

  it("reads a multimodal content array", async () => {
    mockJson({
      choices: [{ message: { content: [
        { type: "text", text: "done" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
      ] } }],
    });
    const res = await generateImage(RELAY, { prompt: "a cat" });
    expect(res.images).toHaveLength(1);
    expect(res.text).toBe("done");
  });

  it("quotes the model's own words when it replied in text only", async () => {
    // The usual symptom of a text model configured as an image model.
    mockJson({ choices: [{ message: { content: "I cannot generate images." } }] });
    await expect(generateImage(RELAY, { prompt: "x" }))
      .rejects.toThrow(/I cannot generate images/);
  });

  it("is only taken when declared — openai_compat defaults to the images API", async () => {
    const calls = mockJson({ data: [{ b64_json: "aGk=" }] });
    await generateImage({ ...OPENAI, standard: "openai_compat" }, { prompt: "x" });
    expect(calls[0].url).toBe("https://api.example.com/v1/images/generations");
  });
});

describe("generateImage · aspect ratio", () => {
  it("sends the ratio to Gemini, which has no size parameter", async () => {
    const calls = mockJson({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGk=" } }] } }],
    });
    await generateImage(GEMINI, { prompt: "x", aspect: "9:16", size: "1024x1024" });
    const cfg = calls[0].body.generationConfig as Record<string, unknown>;
    expect(cfg.imageConfig).toEqual({ aspectRatio: "9:16" });
    expect(calls[0].body).not.toHaveProperty("size");
  });
});

describe("generateImage · editing", () => {
  const SOURCE = "data:image/png;base64,aGk=";

  /** Stub fetch for a multipart request, capturing the parsed form. */
  function mockMultipart(payload: unknown) {
    const calls: { url: string; form: FormData; contentType: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          form: init.body as FormData,
          contentType: new Headers(init.headers).get("content-type"),
        });
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    return calls;
  }

  it("uploads to /images/edits as multipart, without setting Content-Type", async () => {
    // The header must come from the webview's FormData serialization, boundary
    // included — declaring it by hand breaks every such request. See
    // docs/image-generation-plan.md §2.3.
    const calls = mockMultipart({ data: [{ b64_json: "aGk=" }] });
    await generateImage(OPENAI, { prompt: "make it blue", images: [SOURCE] });

    expect(calls[0].url).toBe("https://api.example.com/v1/images/edits");
    expect(calls[0].contentType).toBeNull();
    const form = calls[0].form;
    expect(form.get("prompt")).toBe("make it blue");
    expect(form.get("model")).toBe("img-1");
    expect(form.get("image")).toBeInstanceOf(Blob);
  });

  it("switches to the plural field name for several inputs", async () => {
    // `image` for one, `image[]` for many — older endpoints only know the
    // singular form, so sending the plural always would break them.
    const calls = mockMultipart({ data: [{ b64_json: "aGk=" }] });
    await generateImage(OPENAI, { prompt: "blend", images: [SOURCE, SOURCE] });
    expect(calls[0].form.getAll("image[]")).toHaveLength(2);
    expect(calls[0].form.get("image")).toBeNull();
  });

  it("sends the mask when one is given", async () => {
    const calls = mockMultipart({ data: [{ b64_json: "aGk=" }] });
    await generateImage(OPENAI, { prompt: "repaint", images: [SOURCE], mask: SOURCE });
    expect(calls[0].form.get("mask")).toBeInstanceOf(Blob);
  });

  it("keeps Gemini on one endpoint, with the source image inline", async () => {
    const calls = mockJson({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGk=" } }] } }],
    });
    await generateImage(GEMINI, { prompt: "make it blue", images: [SOURCE] });
    expect(calls[0].url).toContain(":generateContent");
    const parts = (calls[0].body.contents as { parts: Record<string, unknown>[] }[])[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[1]).toHaveProperty("inline_data");
  });

  it("sends a chat-route edit as a multimodal message", async () => {
    const calls = mockJson({
      choices: [{ message: { images: [{ image_url: { url: SOURCE } }] } }],
    });
    await generateImage(
      { ...OPENAI, standard: "openai_compat", route: "chat" },
      { prompt: "make it blue", images: [SOURCE] },
    );
    const content = (calls[0].body.messages as { content: Record<string, unknown>[] }[])[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "text", text: "make it blue" });
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: SOURCE } });
  });
});

describe("isEditUnsupportedError", () => {
  // Drives the visible fallback to regeneration — a second, separately billed
  // call — so it must fire on a missing route and stay quiet on anything the
  // endpoint actually understood.
  const http = (status: number, body: string) => new ImageHttpError("Image edit error", status, body);

  it("recognises a missing or rejecting endpoint", () => {
    expect(isEditUnsupportedError(http(404, "Not Found"))).toBe(true);
    expect(isEditUnsupportedError(http(405, "method not allowed"))).toBe(true);
    expect(isEditUnsupportedError(http(501, "not implemented"))).toBe(true);
    // Structured, naming the model rather than a field.
    expect(isEditUnsupportedError(http(400, JSON.stringify({
      error: { message: "The model `x` does not exist", code: "model_not_found" },
    })))).toBe(true);
    expect(isEditUnsupportedError(http(400, JSON.stringify({
      error: { message: "unsupported model for this endpoint", param: "model" },
    })))).toBe(true);
    // Unstructured relay text, explicitly about editing.
    expect(isEditUnsupportedError(http(400, "this model does not support image editing"))).toBe(true);
    expect(isEditUnsupportedError(http(400, "editing is not supported for this model"))).toBe(true);
    expect(isEditUnsupportedError(http(400, "only imagen models are supported"))).toBe(true);
  });

  it("leaves a genuine refusal alone", () => {
    expect(isEditUnsupportedError(http(400, "your prompt was rejected by the safety system"))).toBe(false);
    expect(isEditUnsupportedError(http(429, "rate limit exceeded"))).toBe(false);
    expect(isEditUnsupportedError(http(401, "invalid api key"))).toBe(false);
  });

  it("does not read an ordinary parameter error as a missing route", () => {
    // OpenAI's standard wording hits three of the old regexes at once, so a
    // fixable request error triggered a second full-price generation and the
    // author was handed a picture marked "degraded" instead of an explanation.
    expect(isEditUnsupportedError(http(400, JSON.stringify({
      error: {
        message: "Unsupported parameter: 'response_format' is not supported with this model.",
        type: "invalid_request_error",
        param: "response_format",
        code: "unsupported_parameter",
      },
    })))).toBe(false);
    // …and the same in plain text, from a relay that returns no error object.
    expect(isEditUnsupportedError(http(400, "Unsupported parameter: 'mask' is not supported."))).toBe(false);
  });

  it("never treats the model's own words as evidence about the route", () => {
    // NoImageError embeds up to 200 characters of whatever the model said.
    expect(isEditUnsupportedError(new NoImageError("I don't support image editing"))).toBe(false);
    // Nor does an error from somewhere else entirely.
    expect(isEditUnsupportedError(new Error("editing is not supported"))).toBe(false);
  });
});
