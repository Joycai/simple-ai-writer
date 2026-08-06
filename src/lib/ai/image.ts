/**
 * Image generation client — the sibling of `streamCompletion` for models that
 * return pictures instead of prose.
 *
 * Deliberately NOT built on the streaming path: an image response is one JSON
 * body carrying base64 (or a short-lived URL), with no SSE, no token deltas and
 * no tool loop. Threading that through `StreamChunk` would bend every text
 * consumer around a case it can never hit.
 *
 * One entry point for both generation and editing: every provider expresses an
 * edit as "the same endpoint, with input images attached", so a second function
 * would only push provider branching out to the callers. `req.images` being
 * non-empty *is* the edit request. See docs/image-generation-plan.md §2.
 */

import { fetch } from "../http";
import { convertToGeminiContents, DEFAULT_GEMINI_BASE } from "./gemini";
import { toSafetySettingsArray } from "./safety";
import type { GeminiSafetySettings } from "./safety";
import type { ApiStandard, ImageRoute } from "./types";

/** The provider coordinates every image call needs. */
export interface ImageConn {
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  modelId: string;
  safetySettings?: GeminiSafetySettings;
  /** Overrides the endpoint choice derived from `standard`. See ImageRoute. */
  route?: ImageRoute;
}

/**
 * Which endpoint to call. The protocol picks the default, but a relay can
 * serve a model the protocol's usual endpoint rejects, so an explicit route
 * always wins.
 */
export function resolveImageRoute(standard: ApiStandard, declared?: ImageRoute): ImageRoute {
  if (declared) return declared;
  return standard === "gemini" ? "gemini" : "images-api";
}

export interface ImageRequest {
  prompt: string;
  /** Input images as base64 data URLs. Non-empty turns the call into an edit. */
  images?: string[];
  /**
   * Edit mask as a base64 data URL — transparent where the model may repaint.
   * OpenAI's edits endpoint only; the other routes have no equivalent field
   * and ignore it rather than failing.
   */
  mask?: string;
  /** How many images to return. Providers cap this; the caller should too. */
  n?: number;
  /** e.g. "1024x1024". Omitted when the model declares no supported sizes. */
  size?: string;
  /**
   * e.g. "9:16". Gemini's image models take the framing this way rather than
   * as pixel dimensions; the OpenAI-shaped routes ignore it and use `size`.
   */
  aspect?: string;
  /** Extra top-level request fields, mirroring StreamOptions.extraBody. */
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  /** base64 data URL — every adapter normalizes to this, URLs included. */
  dataUrl: string;
  mime: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  /** Commentary some models return alongside the picture (Gemini does). */
  text?: string;
  /** Reported only by providers that meter image generation as tokens. */
  usage?: { inputTokens: number; outputTokens: number };
}

/** Thrown when the endpoint answered, but with no image in it. */
export class NoImageError extends Error {
  constructor(detail?: string) {
    super(detail ? `The model returned no image: ${detail}` : "The model returned no image.");
    this.name = "NoImageError";
  }
}

/**
 * Generate images. Dispatches on the provider's wire protocol, the same split
 * `streamCompletion` makes.
 */
export async function generateImage(conn: ImageConn, req: ImageRequest): Promise<ImageResult> {
  switch (resolveImageRoute(conn.standard, conn.route)) {
    case "gemini":
      // One endpoint for both: the input images simply become extra parts.
      return geminiImage(conn, req);
    case "chat":
      // Likewise — an edit is a multimodal user message.
      return chatImage(conn, req);
    default:
      // The OpenAI protocol is the odd one out: editing is a different URL
      // with a different encoding (multipart), not the same call with extra
      // fields.
      return req.images?.length ? openaiEdit(conn, req) : openaiImage(conn, req);
  }
}

/**
 * True for errors that mean "this endpoint can't edit", as opposed to a
 * request that was understood and refused.
 *
 * Drives the visible fallback to regeneration (see the image session store):
 * getting this wrong in the permissive direction would silently paper over a
 * real refusal, so it matches only shapes that indicate the *route* is absent
 * — a missing endpoint, a rejected model, an unsupported operation.
 */
export function isEditUnsupportedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(404|405|501)\b/.test(msg)
    || /not\s+found/i.test(msg)
    || /(does\s+not|doesn't|no)\s+support/i.test(msg)
    || /not\s+supported/i.test(msg)
    || /unsupported/i.test(msg)
    || /only\s+imagen\s+models/i.test(msg);
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function dataUrlOf(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/**
 * Decode a data URL into bytes for multipart upload.
 *
 * Deliberately not `lib/fs/images.ts`'s `dataUrlToBytes`: that module imports
 * plugin-fs at module scope, and the wire adapters have no business pulling
 * the filesystem in behind them.
 */
// The Uint8Array<ArrayBuffer> annotation is load-bearing: Blob rejects the
// default Uint8Array<ArrayBufferLike>, whose buffer could be a SharedArrayBuffer.
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array<ArrayBuffer>; mime: string } {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma === -1) throw new Error("Input image is not a data URL");
  const mime = dataUrl.slice(5, comma).replace(";base64", "").trim() || "image/png";
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime };
}

/** File extension to send with an uploaded part; the API validates on it. */
function extForMime(mime: string): string {
  if (mime.includes("webp")) return "webp";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "png";
}

/**
 * Fetch an image URL and inline it as a data URL.
 *
 * Endpoints that answer with links (xAI's default, most relays) hand back
 * short-lived signed URLs — storing one as a gallery reference would leave a
 * picture that silently 404s within the hour, so the bytes are pulled now.
 */
async function urlToDataUrl(url: string, signal?: AbortSignal): Promise<GeneratedImage> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Failed to download generated image (${res.status})`);
  const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  // Chunked to keep the spread under the argument-count limit — a 4 MB image
  // as one String.fromCharCode(...) call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { dataUrl: dataUrlOf(mime, btoa(binary)), mime };
}

// ─── OpenAI / OpenAI-compatible ──────────────────────────────────────────────

/**
 * `POST /images/generations`. Also the path for xAI and relays, which speak the
 * same shape with a smaller parameter set — hence sending `size` only when the
 * caller asked for one: xAI rejects the parameter outright.
 */
async function openaiImage(conn: ImageConn, req: ImageRequest): Promise<ImageResult> {
  const url = `${conn.baseUrl.replace(/\/$/, "")}/images/generations`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: conn.modelId,
      prompt: req.prompt,
      n: req.n ?? 1,
      ...(req.size ? { size: req.size } : {}),
      ...req.extraBody,
    }),
    signal: req.signal,
  });

  if (!res.ok) throw new Error(`Image API error ${res.status}: ${await res.text()}`);
  return parseOpenAiImagePayload(await res.json(), req.signal);
}

/** The `{ data: [...] }` body, shared by the generations and edits endpoints. */
async function parseOpenAiImagePayload(raw: unknown, signal?: AbortSignal): Promise<ImageResult> {
  const json = raw as {
    data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string } | string;
  };
  if (json.error) {
    const msg = typeof json.error === "string" ? json.error : json.error.message;
    throw new Error(`Image API: ${msg ?? JSON.stringify(json.error)}`);
  }

  const entries = json.data ?? [];
  const images: GeneratedImage[] = [];
  for (const entry of entries) {
    if (entry.b64_json) {
      // The wire format carries no mime; these endpoints return PNG unless
      // asked otherwise, and the app never asks.
      images.push({ dataUrl: dataUrlOf("image/png", entry.b64_json), mime: "image/png" });
    } else if (entry.url) {
      images.push(await urlToDataUrl(entry.url, signal));
    }
  }
  if (!images.length) throw new NoImageError(entries.length ? "no image data in response" : undefined);

  // Present on the token-billed image models, absent on the per-image ones.
  const usage = json.usage
    ? { inputTokens: json.usage.input_tokens ?? 0, outputTokens: json.usage.output_tokens ?? 0 }
    : undefined;
  // revised_prompt is what the provider actually rendered after its own
  // rewriting — worth surfacing, since it explains output the author's prompt
  // doesn't account for.
  const revised = entries.map((e) => e.revised_prompt).filter(Boolean).join("\n\n");
  return { images, usage, ...(revised ? { text: revised } : {}) };
}

/**
 * `POST /images/edits` — multipart, the only place in the app that uploads a
 * file body.
 *
 * **`Content-Type` must not be set here.** The header is generated by the
 * webview when it serializes the FormData, boundary included, and
 * plugin-http's fetch only copies browser-generated headers the caller did not
 * declare. Setting it by hand replaces a value containing the boundary with
 * one that doesn't, and every such request fails to parse server-side.
 * (Transport verified in docs/image-generation-plan.md §2.3.)
 */
async function openaiEdit(conn: ImageConn, req: ImageRequest): Promise<ImageResult> {
  const url = `${conn.baseUrl.replace(/\/$/, "")}/images/edits`;
  const form = new FormData();
  form.append("model", conn.modelId);
  form.append("prompt", req.prompt);

  const images = req.images ?? [];
  // Single vs plural field name: the API takes `image` for one and `image[]`
  // for several, and older endpoints only understand the singular form.
  const field = images.length > 1 ? "image[]" : "image";
  images.forEach((dataUrl, i) => {
    const { bytes, mime } = decodeDataUrl(dataUrl);
    form.append(field, new Blob([bytes], { type: mime }), `image-${i}.${extForMime(mime)}`);
  });
  if (req.mask) {
    const { bytes, mime } = decodeDataUrl(req.mask);
    form.append("mask", new Blob([bytes], { type: mime }), `mask.${extForMime(mime)}`);
  }
  if (req.size) form.append("size", req.size);
  if (req.n && req.n > 1) form.append("n", String(req.n));

  const res = await fetch(url, {
    method: "POST",
    headers: { ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}) },
    body: form,
    signal: req.signal,
  });
  if (!res.ok) throw new Error(`Image edit error ${res.status}: ${await res.text()}`);
  return parseOpenAiImagePayload(await res.json(), req.signal);
}

// ─── Chat completions (relay-hosted image models) ────────────────────────────

/**
 * `POST /chat/completions` — the route newAPI-style relays use for image models
 * that are not Imagen. The picture comes back inside the assistant message, and
 * every relay puts it somewhere slightly different, so all the known shapes are
 * accepted rather than betting on one:
 *
 *   - `message.images[]`      — OpenRouter's shape, adopted by newAPI
 *   - `message.content` parts — the multimodal-content array
 *   - markdown in the text    — `![img](data:…)` or `![img](https://…)`
 *
 * Anything that arrives as an http URL is downloaded, same as on the images
 * route: relays hand out expiring links.
 */
async function chatImage(conn: ImageConn, req: ImageRequest): Promise<ImageResult> {
  const url = `${conn.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: conn.modelId,
      messages: [{
        role: "user",
        // An edit is just a multimodal message here — the same `image_url`
        // parts a vision request uses, which is why relays accept it.
        content: req.images?.length
          ? [
              { type: "text", text: req.prompt },
              ...req.images.map((url) => ({ type: "image_url", image_url: { url } })),
            ]
          : req.prompt,
      }],
      stream: false,
      ...req.extraBody,
    }),
    signal: req.signal,
  });

  if (!res.ok) throw new Error(`Image API error ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    choices?: { message?: {
      content?: string | { type?: string; text?: string; image_url?: { url?: string } }[];
      images?: ({ image_url?: { url?: string }; url?: string } | string)[];
    } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string } | string;
  };
  if (json.error) {
    const msg = typeof json.error === "string" ? json.error : json.error.message;
    throw new Error(`Image API: ${msg ?? JSON.stringify(json.error)}`);
  }

  const message = json.choices?.[0]?.message;
  const urls: string[] = [];
  const texts: string[] = [];

  for (const entry of message?.images ?? []) {
    const u = typeof entry === "string" ? entry : entry.image_url?.url ?? entry.url;
    if (u) urls.push(u);
  }
  if (typeof message?.content === "string") {
    for (const m of message.content.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) urls.push(m[1]);
    // Strip the markdown images so the leftover prose reads as commentary.
    const prose = message.content.replace(/!\[[^\]]*\]\([^)\s]+\)/g, "").trim();
    if (prose) texts.push(prose);
  } else if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (part.image_url?.url) urls.push(part.image_url.url);
      else if (part.text) texts.push(part.text);
    }
  }

  const images: GeneratedImage[] = [];
  for (const u of urls) {
    if (u.startsWith("data:")) {
      const mime = u.slice(5, u.indexOf(";")) || "image/png";
      images.push({ dataUrl: u, mime });
    } else {
      images.push(await urlToDataUrl(u, req.signal));
    }
  }
  if (!images.length) {
    // The model replying in words is the usual symptom of a text model being
    // configured as an image one — say so with its own words attached.
    throw new NoImageError(texts.join(" ").slice(0, 200) || "the reply contained no image");
  }

  const usage = json.usage
    ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 }
    : undefined;
  return { images, usage, ...(texts.length ? { text: texts.join("\n\n") } : {}) };
}

// ─── Gemini ──────────────────────────────────────────────────────────────────

/**
 * `POST /models/{id}:generateContent` with an IMAGE response modality — the
 * same endpoint as chat, which is why the message conversion is shared with the
 * streaming adapter rather than re-derived here.
 *
 * Non-streaming on purpose: the payload is one inline_data blob, so streaming
 * would buy nothing but a second SSE parser.
 */
async function geminiImage(conn: ImageConn, req: ImageRequest): Promise<ImageResult> {
  const base = (conn.baseUrl || DEFAULT_GEMINI_BASE).replace(/\/$/, "");
  const url = `${base}/models/${conn.modelId}:generateContent`;

  const contents = convertToGeminiContents([
    {
      role: "user",
      content: [
        { type: "text", text: req.prompt },
        ...(req.images ?? []).map((dataUrl) => ({
          type: "image_url" as const,
          image_url: { url: dataUrl },
        })),
      ],
    },
  ]);

  const safetySettings = toSafetySettingsArray(conn.safetySettings);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": conn.apiKey },
    body: JSON.stringify({
      contents,
      generationConfig: {
        // TEXT stays in the list: the image models refuse an IMAGE-only
        // modality set on some revisions, and the text part is useful anyway.
        responseModalities: ["TEXT", "IMAGE"],
        // Gemini takes framing as a ratio, not pixel dimensions — `size` is
        // meaningless here and `aspect` is the only control that lands.
        ...(req.aspect ? { imageConfig: { aspectRatio: req.aspect } } : {}),
        ...(req.n && req.n > 1 ? { candidateCount: req.n } : {}),
      },
      ...(safetySettings.length ? { safetySettings } : {}),
      ...req.extraBody,
    }),
    signal: req.signal,
  });

  if (!res.ok) throw new Error(`Gemini image error ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    candidates?: {
      content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] };
      finishReason?: string;
    }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    error?: { message?: string };
  };
  if (json.error) throw new Error(`Gemini: ${json.error.message ?? "unknown error"}`);
  if (json.promptFeedback?.blockReason) {
    throw new Error(
      `Gemini blocked this request (${json.promptFeedback.blockReason}). The prompt may have triggered a safety filter — try rewording it or another provider.`,
    );
  }

  const images: GeneratedImage[] = [];
  const texts: string[] = [];
  let blocked: string | undefined;
  for (const candidate of json.candidates ?? []) {
    // A per-candidate block is not an error when other candidates produced
    // images — remember it and only surface it if nothing came back at all.
    if (candidate.finishReason && candidate.finishReason !== "STOP") blocked = candidate.finishReason;
    for (const part of candidate.content?.parts ?? []) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType || "image/png";
        images.push({ dataUrl: dataUrlOf(mime, part.inlineData.data), mime });
      } else if (part.text) {
        texts.push(part.text);
      }
    }
  }
  if (!images.length) {
    throw new NoImageError(
      blocked
        ? `blocked (${blocked}) — the prompt may have triggered a safety filter`
        : texts.join(" ").slice(0, 200) || undefined,
    );
  }

  const usage = json.usageMetadata
    ? {
        inputTokens: json.usageMetadata.promptTokenCount ?? 0,
        outputTokens: json.usageMetadata.candidatesTokenCount ?? 0,
      }
    : undefined;
  return { images, usage, ...(texts.length ? { text: texts.join("\n\n") } : {}) };
}
