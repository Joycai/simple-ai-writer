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
import {
  dashscopeNativeBase, generateImage, ImageHttpError, isEditUnsupportedError, NoImageError,
  type ImageProgress,
} from "../ai/image";

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

/** Base64 whose leading bytes carry a real signature — what mime sniffing keys on. */
const PNG_B64 = btoa("\x89PNG\r\n\x1a\n" + "0".repeat(60));
const JPEG_B64 = btoa("\xff\xd8\xff\xe0" + "0".repeat(60));

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

  it("types inlineData by its bytes when the declared mime lies", async () => {
    // hk.chenmoai.com `[R]gemini-3.1-flash-image-preview` (2026-09): mimeType
    // says image/png over JPEG bytes — saved as .png the file lies about itself.
    mockJson({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: JPEG_B64 } }] } }] });
    const res = await generateImage(GEMINI, { prompt: "a cat" });
    expect(res.images[0]).toEqual({ dataUrl: `data:image/jpeg;base64,${JPEG_B64}`, mime: "image/jpeg" });
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

  it("sends the prompt as a one-part array even without input images", async () => {
    // hk.chenmoai.com `[R]gpt-image-2` (2026-09): a string `content` gets
    // `400 images[0] must be an http/https URL or image data URI`; the array works.
    const calls = mockJson({ choices: [{ message: { images: [{ b64_json: PNG_B64 }] } }] });
    await generateImage(RELAY, { prompt: "a cat" });
    const content = (calls[0].body.messages as { content: unknown }[])[0].content;
    expect(content).toEqual([{ type: "text", text: "a cat" }]);
  });

  it("reads images[].b64_json, typing it by its bytes", async () => {
    mockJson({ choices: [{ message: { images: [{ b64_json: JPEG_B64 }] } }] });
    const res = await generateImage(RELAY, { prompt: "a cat" });
    expect(res.images).toEqual([{ dataUrl: `data:image/jpeg;base64,${JPEG_B64}`, mime: "image/jpeg" }]);
  });

  it("dedupes one picture delivered in three fields at once", async () => {
    // hk.chenmoai.com `[R]gpt-image-2`: `content`, `images[0].b64_json` and
    // `image_b64_json` are the same bare base64 string.
    mockJson({
      choices: [{ message: { role: "assistant", content: PNG_B64, images: [{ b64_json: PNG_B64 }], image_b64_json: PNG_B64 } }],
      usage: { prompt_tokens: 14, completion_tokens: 1756 },
    });
    const res = await generateImage(RELAY, { prompt: "a cat" });
    expect(res.images).toHaveLength(1);
    expect(res.images[0].mime).toBe("image/png");
    // The base64 must not survive as "commentary".
    expect(res.text).toBeUndefined();
    expect(res.usage).toEqual({ inputTokens: 14, outputTokens: 1756 });
  });

  it("treats a bare link as the picture and downloads it", async () => {
    // The same relay answers an *edit* with nothing but a signed S3 URL.
    const link = "https://signed.example.com/images/abc?X-Amz-Expires=86400";
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: `${link}\n` } }] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(Uint8Array.from(atob(JPEG_B64), (c) => c.charCodeAt(0)), {
        status: 200, headers: { "content-type": "image/png" },
      });
    }));
    const res = await generateImage(RELAY, { prompt: "make it green", images: ["data:image/png;base64,aGk="] });
    expect(calls[1]).toBe(link);
    expect(res.images).toHaveLength(1);
    // The link's content-type said PNG; the bytes are JPEG, and the bytes win.
    expect(res.images[0].mime).toBe("image/jpeg");
    expect(res.text).toBeUndefined();
  });

  it("still quotes short prose rather than mistaking it for base64", async () => {
    mockJson({ choices: [{ message: { content: "Done, here is your apple." } }] });
    await expect(generateImage(RELAY, { prompt: "x" })).rejects.toThrow(/here is your apple/);
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

  it("sends the resolution tier as imageConfig.imageSize alongside the ratio", async () => {
    const calls = mockJson({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGk=" } }] } }],
    });
    await generateImage(GEMINI, { prompt: "x", aspect: "16:9", imageSize: "2K" });
    const cfg = calls[0].body.generationConfig as Record<string, unknown>;
    expect(cfg.imageConfig).toEqual({ aspectRatio: "16:9", imageSize: "2K" });
  });

  it("omits imageConfig entirely when neither field is set", async () => {
    const calls = mockJson({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGk=" } }] } }],
    });
    await generateImage(GEMINI, { prompt: "x" });
    const cfg = calls[0].body.generationConfig as Record<string, unknown>;
    expect(cfg).not.toHaveProperty("imageConfig");
  });
});

describe("generateImage · quality tier", () => {
  it("sends `quality` on the OpenAI route only when set", async () => {
    let calls = mockJson({ data: [{ b64_json: "aGk=" }] });
    await generateImage(OPENAI, { prompt: "x", quality: "high" });
    expect(calls[0].body.quality).toBe("high");

    calls = mockJson({ data: [{ b64_json: "aGk=" }] });
    await generateImage(OPENAI, { prompt: "x" });
    expect(calls[0].body).not.toHaveProperty("quality");
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
    // docs/feature/image-generation-plan.md §2.3.
    const calls = mockMultipart({ data: [{ b64_json: "aGk=" }] });
    await generateImage(OPENAI, { prompt: "make it blue", images: [SOURCE] });

    expect(calls[0].url).toBe("https://api.example.com/v1/images/edits");
    expect(calls[0].contentType).toBeNull();
    const form = calls[0].form;
    expect(form.get("prompt")).toBe("make it blue");
    expect(form.get("model")).toBe("img-1");
    expect(form.get("image")).toBeInstanceOf(Blob);
  });

  it("retries a rejected edit size with the closest documented preset", async () => {
    // gpt-image-2 edits get the same computed sizes generations do; an
    // endpoint that enforces the documented presets answers 400 (unbilled),
    // and the one retry falls back to the nearest preset ratio.
    const calls: { form: FormData }[] = [];
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ form: init.body as FormData });
        if (first) {
          first = false;
          return new Response(
            JSON.stringify({ error: { message: "Invalid value for size", param: "size" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const res = await generateImage(OPENAI, { prompt: "recompose", images: [SOURCE], size: "1440x2160" });
    expect(calls).toHaveLength(2);
    expect(calls[0].form.get("size")).toBe("1440x2160");
    expect(calls[1].form.get("size")).toBe("1024x1536");
    expect(res.images).toHaveLength(1);
  });

  it("drops size on the retry when the rejected size already was a preset", async () => {
    const calls: { form: FormData }[] = [];
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ form: init.body as FormData });
        if (first) {
          first = false;
          return new Response(
            JSON.stringify({ error: { message: "size is not supported", param: "size" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await generateImage(OPENAI, { prompt: "x", images: [SOURCE], size: "1024x1536" });
    expect(calls).toHaveLength(2);
    expect(calls[1].form.get("size")).toBeNull();
  });

  it("does not size-retry an error about something else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { message: "image file size exceeds the limit", param: "image" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        )),
    );
    await expect(
      generateImage(OPENAI, { prompt: "x", images: [SOURCE], size: "1440x2160" }),
    ).rejects.toThrow(/file size exceeds/);
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
    expect(parts[1]).toHaveProperty("inlineData");
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

describe("generateImage · dashscope route", () => {
  // Qwen/Wan image models speak DashScope's native protocol at /api/v1 — the
  // provider row stores the compatible-mode base the text side uses, and the
  // route derives the native base from it.
  const DASHSCOPE = {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "k",
    standard: "openai_compat" as const,
    modelId: "qwen-image-3.0",
    route: "dashscope" as const,
  };
  const NATIVE = "https://dashscope.aliyuncs.com/api/v1";
  const IMAGE_PART = { image: "data:image/png;base64,aGk=" };

  /** Like mockJson, but keeps the request headers too. */
  function mockDashscope(payload: unknown, status = 200) {
    const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
        return new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    return calls;
  }

  it("derives the native base from whatever the author configured", () => {
    expect(dashscopeNativeBase("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe(NATIVE);
    expect(dashscopeNativeBase("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/")).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1",
    );
    // Already native, or a bare host: pass through rather than doubling up.
    expect(dashscopeNativeBase(NATIVE)).toBe(NATIVE);
    expect(dashscopeNativeBase("https://dashscope.aliyuncs.com")).toBe(NATIVE);
  });

  it("posts the native body to multimodal-generation with Bearer auth", async () => {
    const calls = mockDashscope({
      output: { choices: [{ message: { content: [IMAGE_PART] } }] },
    });
    const res = await generateImage(DASHSCOPE, {
      prompt: "a cat",
      size: "1024x1024",
      extraBody: { watermark: false },
    });

    expect(calls[0].url).toBe(`${NATIVE}/services/aigc/multimodal-generation/generation`);
    expect(calls[0].headers.get("authorization")).toBe("Bearer k");
    expect(calls[0].body.model).toBe("qwen-image-3.0");
    const input = calls[0].body.input as { messages: { role: string; content: unknown[] }[] };
    expect(input.messages[0].content).toEqual([{ text: "a cat" }]);
    const params = calls[0].body.parameters as Record<string, unknown>;
    // The size reaches the wire in DashScope's spelling regardless of how the
    // author wrote it, n is ALWAYS explicit — wan2.7's documented default is
    // n = 4, so omitting it would bill four pictures for one — and extraBody
    // lands in `parameters`, DashScope's knob namespace, not the top level.
    expect(params.size).toBe("1024*1024");
    expect(params.n).toBe(1);
    expect(params.watermark).toBe(false);
    expect(res.images[0].dataUrl).toBe("data:image/png;base64,aGk=");
  });

  it("sends an edit as image parts before the instruction, on the same endpoint", async () => {
    const calls = mockDashscope({
      output: { choices: [{ message: { content: [IMAGE_PART] } }] },
    });
    await generateImage(DASHSCOPE, {
      prompt: "make it blue",
      images: ["data:image/png;base64,c3Jj"],
      n: 2,
    });
    const input = calls[0].body.input as { messages: { content: unknown[] }[] };
    expect(input.messages[0].content).toEqual([
      { image: "data:image/png;base64,c3Jj" },
      { text: "make it blue" },
    ]);
    expect((calls[0].body.parameters as Record<string, unknown>).n).toBe(2);
  });

  it("downloads a URL answer immediately — DashScope links die in 24 hours", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return new Response(JSON.stringify({
            output: { choices: [{ message: { content: [
              { image: "https://dashscope-result.oss.aliyuncs.com/x.png?Expires=1" },
              { text: "扩写后的提示词" },
            ] } }] },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      }),
    );
    const res = await generateImage(DASHSCOPE, { prompt: "a cat" });
    expect(call).toBe(2);
    expect(res.images[0].dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    // The rewritten prompt survives as commentary, same as revised_prompt does.
    expect(res.text).toBe("扩写后的提示词");
  });

  it("carries a refusal's code so it is not misread as a missing route", async () => {
    // DashScope's errors are top-level {code, message} — DataInspectionFailed
    // is a content-review refusal, and regenerating on it would bill twice.
    mockDashscope({ code: "DataInspectionFailed", message: "inappropriate content" }, 400);
    let caught: unknown;
    try {
      await generateImage(DASHSCOPE, { prompt: "x", images: ["data:image/png;base64,aGk="] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ImageHttpError);
    expect((caught as ImageHttpError).code).toBe("DataInspectionFailed");
    expect((caught as ImageHttpError).message).toMatch(/inappropriate content/);
    expect(isEditUnsupportedError(caught)).toBe(false);
  });

  it("surfaces an error delivered inside a 200 body", async () => {
    mockDashscope({ code: "Throttling", message: "Requests throttled" });
    await expect(generateImage(DASHSCOPE, { prompt: "x" })).rejects.toThrow(/Requests throttled/);
  });

  it("throws NoImageError when the response carries no image", async () => {
    mockDashscope({ output: { choices: [{ message: { content: [{ text: "只有文字" }] } }] } });
    await expect(generateImage(DASHSCOPE, { prompt: "x" })).rejects.toBeInstanceOf(NoImageError);
  });

  describe("async task flow (caps.asyncTask — wan text-to-image)", () => {
    const WAN = { ...DASHSCOPE, modelId: "wan2.7-image", asyncTask: true };

    afterEach(() => vi.useRealTimers());

    it("submits with X-DashScope-Async and polls the task to completion", async () => {
      vi.useFakeTimers();
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const calls: { url: string; headers: Headers; method: string }[] = [];
      let poll = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url: String(url), headers: new Headers(init?.headers), method: init?.method ?? "GET" });
          const u = String(url);
          if (u.endsWith("/services/aigc/image-generation/generation")) {
            return new Response(JSON.stringify({ output: { task_id: "t1", task_status: "PENDING" } }), {
              status: 200, headers: { "content-type": "application/json" },
            });
          }
          if (u.endsWith("/tasks/t1")) {
            poll++;
            return new Response(JSON.stringify(
              poll === 1
                ? { output: { task_id: "t1", task_status: "RUNNING" } }
                // Wan tasks answer in the results[].url shape, not choices.
                : { output: { task_id: "t1", task_status: "SUCCEEDED", results: [{ url: "https://cdn/x.png" }] } },
            ), { status: 200, headers: { "content-type": "application/json" } });
          }
          return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
        }),
      );

      const pending = generateImage(WAN, { prompt: "a cat" });
      // Swallow a rejection that fires while timers are still being advanced.
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(3_000); // → poll 1: RUNNING
      await vi.advanceTimersByTimeAsync(3_000); // → poll 2: SUCCEEDED → download
      const res = await pending;

      expect(calls[0].url).toBe(`${NATIVE}/services/aigc/image-generation/generation`);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].headers.get("x-dashscope-async")).toBe("enable");
      expect(calls[1].url).toBe(`${NATIVE}/tasks/t1`);
      expect(res.images[0].dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    });

    it("轮询时报出进度：排队 / 生成，各带已等多久和放弃上限", async () => {
      // 批准之后这次工具调用就停在审批的 promise 里了，日志上只剩一个 running
      // 的工具步——那和端点挂了长得一模一样。上限是有用的那一半：把「是不是卡了」
      // 变成「它还有八分钟」。
      vi.useFakeTimers();
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      let poll = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.endsWith("/services/aigc/image-generation/generation")) {
            return new Response(JSON.stringify({ output: { task_id: "t1", task_status: "PENDING" } }), {
              status: 200, headers: { "content-type": "application/json" },
            });
          }
          if (u.endsWith("/tasks/t1")) {
            poll++;
            const output =
              poll === 1
                ? { task_id: "t1", task_status: "PENDING" }
                : poll === 2
                  ? { task_id: "t1", task_status: "RUNNING" }
                  : { task_id: "t1", task_status: "SUCCEEDED", results: [{ url: "https://cdn/x.png" }] };
            return new Response(JSON.stringify({ output }), {
              status: 200, headers: { "content-type": "application/json" },
            });
          }
          return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
        }),
      );

      const seen: ImageProgress[] = [];
      const pending = generateImage(WAN, { prompt: "a cat", onProgress: (p) => seen.push(p) });
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await pending;

      // 成功的那一次不报——那一刻等待结束了，说话的是结果。
      expect(seen.map((p) => p.phase)).toEqual(["queued", "running"]);
      expect(seen.map((p) => p.polls)).toEqual([1, 2]);
      expect(seen[1].elapsedMs).toBeGreaterThan(seen[0].elapsedMs);
      expect(seen[0].timeoutMs).toBe(600_000);
    });

    it("同步路由一次都不报——一个请求没有中间状态可言", async () => {
      // 那种「先动起来再说」的假进度条正是这里要避免的：一条 tick 就是一句
      // 「我知道进展」，而同步路由在发出去和答回来之间什么都不知道。
      mockJson({ data: [{ b64_json: "aGk=" }] });
      const seen: ImageProgress[] = [];
      await generateImage(OPENAI, { prompt: "x", onProgress: (p) => seen.push(p) });
      expect(seen).toEqual([]);
    });

    it("reports a failed task with its own error message", async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          String(url).endsWith("/tasks/t1")
            ? new Response(JSON.stringify({
                output: { task_id: "t1", task_status: "FAILED", code: "InvalidParameter", message: "size out of range" },
              }), { status: 200, headers: { "content-type": "application/json" } })
            : new Response(JSON.stringify({ output: { task_id: "t1", task_status: "PENDING" } }), {
                status: 200, headers: { "content-type": "application/json" },
              })),
      );
      const pending = generateImage(WAN, { prompt: "x" });
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).rejects.toThrow(/size out of range/);
    });

    it("stops polling the moment the caller aborts", async () => {
      vi.useFakeTimers();
      const ctrl = new AbortController();
      const fetchMock = vi.fn(async (url: string) =>
        String(url).endsWith("/tasks/t1")
          ? new Response(JSON.stringify({ output: { task_id: "t1", task_status: "RUNNING" } }), {
              status: 200, headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ output: { task_id: "t1", task_status: "PENDING" } }), {
              status: 200, headers: { "content-type": "application/json" },
            }));
      vi.stubGlobal("fetch", fetchMock);

      const pending = generateImage(WAN, { prompt: "x", signal: ctrl.signal });
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(3_000); // one poll happens
      const pollsBefore = fetchMock.mock.calls.length;
      ctrl.abort(new DOMException("stopped", "AbortError"));
      await expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock.mock.calls.length).toBe(pollsBefore);
    });
  });
});

describe("generateImage · ComfyUI route", () => {
  // 一张最小 txt2img 工作流：KSampler 连着正/负 CLIPTextEncode 和 latent。
  const WORKFLOW = {
    "3": {
      class_type: "KSampler",
      inputs: { seed: 5, positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] },
    },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "old" } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "bad hands" } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } },
  };

  const COMFY = {
    baseUrl: "http://127.0.0.1:8188",
    apiKey: "",
    standard: "openai_compat" as const,
    modelId: "sdxl-portrait",
    route: "comfyui" as const,
    comfy: { workflow: JSON.stringify(WORKFLOW) },
  };

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  afterEach(() => vi.useRealTimers());

  /** submit → history(挂起 N 次) → history(完成) → view 的整条链路。 */
  function mockComfy(entry: unknown, pendingPolls = 1) {
    const calls: { url: string; method: string; body?: Record<string, unknown>; form?: FormData }[] = [];
    let polls = 0;
    let uploads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        method: init?.method ?? "GET",
        // multipart 上传的 body 是 FormData，不能当 JSON 解析。
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        form: init?.body instanceof FormData ? init.body : undefined,
      });
      if (u.endsWith("/upload/image")) {
        uploads++;
        return new Response(JSON.stringify({ name: `up-${uploads}.png`, subfolder: "" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/prompt")) {
        return new Response(JSON.stringify({ prompt_id: "p1", number: 0 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/history/p1")) {
        polls++;
        // 完成前 history 是 {}——条目缺席即"仍在跑"。
        return new Response(JSON.stringify(polls <= pendingPolls ? {} : { p1: entry }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/view")) {
        return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }));
    return calls;
  }

  it("injects the prompt into the graph, polls history and fetches the files", async () => {
    vi.useFakeTimers();
    const calls = mockComfy({
      status: { status_str: "success", completed: true },
      outputs: { "9": { images: [{ filename: "ComfyUI_0001.png", subfolder: "", type: "output" }] } },
    });

    const pending = generateImage(COMFY, { prompt: "a cat", size: "832x1216", n: 2, extraBody: { seed: 42 } });
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000); // → poll 1: 还没好
    await vi.advanceTimersByTimeAsync(1_000); // → poll 2: 完成 → view
    const res = await pending;

    expect(calls[0].url).toBe("http://127.0.0.1:8188/prompt");
    const graph = calls[0].body!.prompt as typeof WORKFLOW;
    expect(graph["6"].inputs.text).toBe("a cat");
    expect(graph["7"].inputs.text).toBe("bad hands"); // 模板负面原样照发
    expect(graph["3"].inputs.seed).toBe(42);           // extraBody.seed 显式覆盖
    expect(graph["5"].inputs).toMatchObject({ width: 832, height: 1216, batch_size: 2 });
    expect(calls[calls.length - 1].url).toContain("/view?filename=ComfyUI_0001.png");
    expect(res.images[0].dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("randomizes the seed when none is given — an unchanged graph re-executes nothing", async () => {
    vi.useFakeTimers();
    const calls = mockComfy({
      status: { status_str: "success", completed: true },
      outputs: { "9": { images: [{ filename: "x.png", subfolder: "", type: "output" }] } },
    }, 0);
    const pending = generateImage(COMFY, { prompt: "x" });
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    const graph = calls[0].body!.prompt as typeof WORKFLOW;
    expect(typeof graph["3"].inputs.seed).toBe("number");
    expect(graph["3"].inputs.seed).not.toBe(5); // 1/2^32 的碰撞概率可以接受
  });

  it("keeps only SaveImage outputs when preview temps are present", async () => {
    vi.useFakeTimers();
    const calls = mockComfy({
      status: { status_str: "success", completed: true },
      outputs: {
        "8": { images: [{ filename: "preview.png", subfolder: "", type: "temp" }] },
        "9": { images: [{ filename: "final.png", subfolder: "sub", type: "output" }] },
      },
    }, 0);
    const pending = generateImage(COMFY, { prompt: "x" });
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await pending;
    expect(res.images).toHaveLength(1);
    const view = calls.find((c) => c.url.includes("/view"))!;
    expect(view.url).toContain("filename=final.png");
    expect(view.url).toContain("subfolder=sub");
  });

  it("surfaces a run's execution_error with the failing node named", async () => {
    vi.useFakeTimers();
    mockComfy({
      status: {
        status_str: "error", completed: false,
        messages: [["execution_start", {}], ["execution_error", {
          node_id: "4", node_type: "CheckpointLoaderSimple",
          exception_message: "Model not found: sdxl.safetensors",
        }]],
      },
    }, 0);
    const pending = generateImage(COMFY, { prompt: "x" });
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).rejects.toThrow(/CheckpointLoaderSimple: Model not found/);
  });

  it("passes a submit rejection (node_errors) through verbatim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { type: "invalid_prompt", message: "Cannot execute because a node is missing" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    )));
    await expect(generateImage(COMFY, { prompt: "x" })).rejects.toThrow(/node is missing/);
  });

  it("uploads input images and fills the LoadImage slot, negative included", async () => {
    vi.useFakeTimers();
    const wf = {
      ...WORKFLOW,
      "10": { class_type: "LoadImage", inputs: { image: "default.png" } },
    };
    const conn = { ...COMFY, comfy: { workflow: JSON.stringify(wf) } };
    const calls = mockComfy({
      status: { status_str: "success", completed: true },
      outputs: { "9": { images: [{ filename: "x.png", subfolder: "", type: "output" }] } },
    }, 0);

    const pending = generateImage(conn, {
      prompt: "a cat", negative: "blurry", images: ["data:image/png;base64,aGk="],
    });
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await pending;

    const upload = calls.find((c) => c.url.endsWith("/upload/image"))!;
    expect(upload.method).toBe("POST");
    expect(upload.form).toBeInstanceOf(FormData); // multipart，绝不能手动设 Content-Type
    const submit = calls.find((c) => c.url.endsWith("/prompt"))!;
    const graph = submit.body!.prompt as typeof wf;
    expect(graph["10"].inputs.image).toBe("up-1.png");
    expect(graph["7"].inputs.text).toBe("blurry");   // 负面进负面节点
    expect(graph["6"].inputs.text).toBe("a cat");    // 正面里没有 "Avoid:"
    expect(res.images).toHaveLength(1);
  });

  it("refuses input images when the workflow has no LoadImage slot — before any upload", async () => {
    const calls = mockComfy({}, 0);
    await expect(
      generateImage(COMFY, { prompt: "x", images: ["data:image/png;base64,aGk="] }),
    ).rejects.toThrow(/no LoadImage node/);
    expect(calls.some((c) => c.url.endsWith("/upload/image"))).toBe(false);
  });

  it("refuses more images than the workflow has slots", async () => {
    const wf = { ...WORKFLOW, "10": { class_type: "LoadImage", inputs: { image: "d.png" } } };
    const conn = { ...COMFY, comfy: { workflow: JSON.stringify(wf) } };
    mockComfy({}, 0);
    await expect(
      generateImage(conn, { prompt: "x", images: ["data:a;base64,aGk=", "data:a;base64,aGk="] }),
    ).rejects.toThrow(/1 image input/);
  });

  it("refuses to run without an imported workflow", async () => {
    await expect(
      generateImage({ ...COMFY, comfy: undefined }, { prompt: "x" }),
    ).rejects.toThrow(/no ComfyUI workflow/);
  });

  it("cancels the queued job when the caller aborts", async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const calls = mockComfy({}, 99);
    const pending = generateImage(COMFY, { prompt: "x", signal: ctrl.signal });
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    ctrl.abort(new DOMException("stopped", "AbortError"));
    await expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    const cancel = calls.find((c) => c.url.endsWith("/queue") && c.method === "POST");
    expect(cancel?.body).toEqual({ delete: ["p1"] });
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
