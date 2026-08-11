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
import { beginImageApiLog } from "./apiLog";
import { convertToGeminiContents } from "./gemini";
import { toSafetySettingsArray } from "./safety";
import type { GeminiSafetySettings } from "./safety";
import { familyOf, type ApiStandard, type ImageRoute } from "./types";
import { geminiUrl, openaiUrl } from "./urls";

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
  return familyOf(standard) === "gemini" ? "gemini" : "images-api";
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
 * An error the endpoint reported, with the parts a decision can be made on
 * kept apart from the prose.
 *
 * The message still reads the way it always did (it is what the author sees),
 * but `status`, `code` and `param` are what code branches on. Matching a
 * regex against the concatenated message is how `Unsupported parameter: 'x'
 * is not supported with this model.` came to mean "this endpoint cannot edit"
 * — and every such misread costs a second, billable generation.
 */
export class ImageHttpError extends Error {
  /** HTTP status, or 200 for an error delivered inside a successful body. */
  readonly status: number;
  /** The raw response body, for display and for last-resort matching. */
  readonly body: string;
  /** OpenAI-shaped `error.code`, when the body carried one. */
  readonly code?: string;
  /** OpenAI-shaped `error.param` — the field the endpoint objected to. */
  readonly param?: string;

  constructor(label: string, status: number, body: string) {
    const structured = parseErrorBody(body);
    super(`${label} ${status}: ${structured.message ?? body}`);
    this.name = "ImageHttpError";
    this.status = status;
    this.body = body;
    this.code = structured.code;
    this.param = structured.param;
  }
}

/** Pull `{ error: { message, code, param } }` out of a response body, if present. */
function parseErrorBody(body: string): { message?: string; code?: string; param?: string } {
  try {
    const json = JSON.parse(body) as { error?: { message?: string; code?: string; param?: string } | string };
    if (typeof json.error === "string") return { message: json.error };
    if (json.error) {
      return { message: json.error.message, code: json.error.code, param: json.error.param };
    }
  } catch {
    // Plenty of relays answer with plain text or an HTML error page.
  }
  return {};
}

/** Read a response body as JSON, with an error a user can act on when it isn't. */
async function readJson(res: Response, label: string): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Without this the author sees `Unexpected token <` and has no way to know
    // the relay answered with an HTML error page.
    throw new ImageHttpError(label, res.status, text.slice(0, 400));
  }
}

/** Wall-clock cap on one generation. Slow endpoints exist; infinite ones don't. */
const GENERATE_TIMEOUT_MS = 180_000;
/** Cap on pulling back an already-generated image from a signed URL. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * The caller's signal, plus a deadline.
 *
 * Not `AbortSignal.any` + `AbortSignal.timeout`: this code runs in a webview
 * whose Chromium version is whatever the OS shipped, and a missing static
 * would take out image generation entirely rather than degrade. Callers must
 * invoke `done()` so a completed request stops holding a timer.
 */
function withDeadline(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException(`The image request timed out after ${Math.round(ms / 1000)}s.`, "TimeoutError")),
    ms,
  );
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) ctrl.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Generate images. Dispatches on the provider's wire protocol, the same split
 * `streamCompletion` makes.
 */
export async function generateImage(conn: ImageConn, req: ImageRequest): Promise<ImageResult> {
  const route = resolveImageRoute(conn.standard, conn.route);
  // Logged like `streamCompletion` is. These calls bill per attempt and their
  // failures are the least reproducible in the app, so leaving them out of the
  // debug log was the wrong way round.
  const log = beginImageApiLog({
    standard: conn.standard,
    route,
    baseUrl: conn.baseUrl,
    modelId: conn.modelId,
    prompt: req.prompt,
    n: req.n,
    size: req.size,
    aspect: req.aspect,
    inputImages: req.images?.length ?? 0,
    extraBody: req.extraBody,
  });

  try {
    const result = await dispatchImage(route, conn, req);
    log.success({ images: result.images.length, usage: result.usage, text: result.text });
    return result;
  } catch (e) {
    log.error(e);
    throw e;
  }
}

function dispatchImage(route: ImageRoute, conn: ImageConn, req: ImageRequest): Promise<ImageResult> {
  switch (route) {
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
  // The model answering in words is a refusal or a misconfiguration, never
  // evidence about the route — and its own text routinely contains phrases
  // like "I don't support image editing", which used to trigger a second
  // billable generation.
  if (err instanceof NoImageError) return false;
  if (!(err instanceof ImageHttpError)) return false;

  // "There is no such endpoint / method here" — unambiguous, and the case the
  // fallback exists for.
  if (err.status === 404 || err.status === 405 || err.status === 501) return true;

  // Structured error: trust it, and only a complaint about the *model* means
  // the route is absent. `Unsupported parameter: 'x' is not supported with
  // this model.` carries param:"x" — that request was understood, and
  // regenerating would bill twice for something dropping the field would fix.
  if (err.code || err.param) {
    return err.param === "model" || UNSUPPORTED_MODEL_CODES.has(err.code ?? "");
  }

  // No structured error at all (relays commonly answer in plain text). Fall
  // back to prose, but only phrasing that is about editing or the model.
  const body = err.body;
  if (/\bparam(eter)?\b/i.test(body)) return false;
  return /only\s+imagen\s+models/i.test(body)
    || /(does\s+not|doesn't|not|no)\s+support[^.]{0,40}\bedit/i.test(body)
    || /\bedit(ing|s)?\b[^.]{0,40}(not\s+supported|unsupported|not\s+available)/i.test(body);
}

/** OpenAI-shaped `error.code` values that name the model rather than the request. */
const UNSUPPORTED_MODEL_CODES = new Set([
  "model_not_found",
  "unsupported_model",
  "unknown_model",
  "model_not_supported",
]);

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

/** The mime type of a data URL, or a fallback. Tolerates a missing `;base64`. */
function mimeOfDataUrl(url: string): string {
  const comma = url.indexOf(",");
  if (comma === -1) return "image/png";
  return url.slice(5, comma).replace(";base64", "").trim() || "image/png";
}

/**
 * The image format a base64 payload actually is, from its leading magic bytes.
 *
 * The `data[]` wire format carries no mime, and these endpoints have long
 * defaulted to PNG — but `gpt-image-1` takes an `output_format`, and relays
 * hand back whatever their upstream produced. Guessing PNG for a JPEG writes a
 * file whose extension lies about its contents.
 */
function sniffImageMime(base64: string, fallback = "image/png"): string {
  // 12 base64 chars decode to 9 bytes — more than any signature below needs.
  let head: string;
  try {
    head = atob(base64.slice(0, 16));
  } catch {
    return fallback;
  }
  const b = (i: number) => head.charCodeAt(i);
  if (head.startsWith("\x89PNG")) return "image/png";
  if (b(0) === 0xff && b(1) === 0xd8) return "image/jpeg";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (head.startsWith("GIF8")) return "image/gif";
  return fallback;
}

/**
 * Fetch an image URL and inline it as a data URL.
 *
 * Endpoints that answer with links (xAI's default, most relays) hand back
 * short-lived signed URLs — storing one as a gallery reference would leave a
 * picture that silently 404s within the hour, so the bytes are pulled now.
 */
async function urlToDataUrl(url: string, signal?: AbortSignal): Promise<GeneratedImage> {
  // The picture is already paid for at this point, so one retry is worth it:
  // a link that has just been minted and a network that blinks are both
  // ordinary, and the alternative is losing a generation outright.
  try {
    return await downloadImage(url, signal);
  } catch (e) {
    if (signal?.aborted || (e as Error)?.name === "AbortError") throw e;
    return downloadImage(url, signal);
  }
}

async function downloadImage(url: string, signal?: AbortSignal): Promise<GeneratedImage> {
  const deadline = withDeadline(signal, DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: deadline.signal });
    if (!res.ok) throw new Error(`Failed to download generated image (${res.status})`);
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    // A relay answering a 200 with an HTML error page is common, and without
    // this check it lands in the gallery as a `.png` nothing can open while
    // the UI reports success.
    if (!mime.startsWith("image/")) {
      throw new Error(
        `The image link returned ${mime || "no content type"} rather than an image — the endpoint probably answered with an error page.`,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    // Chunked to keep the spread under the argument-count limit — a 4 MB image
    // as one String.fromCharCode(...) call overflows the stack.
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { dataUrl: dataUrlOf(mime, btoa(binary)), mime };
  } finally {
    deadline.done();
  }
}

// ─── OpenAI / OpenAI-compatible ──────────────────────────────────────────────

/**
 * `POST /images/generations`. Also the path for xAI and relays, which speak the
 * same shape with a smaller parameter set — hence sending `size` only when the
 * caller asked for one: xAI rejects the parameter outright.
 */
async function openaiImage(
  conn: ImageConn,
  req: ImageRequest,
  /**
   * Ask for base64 rather than a link. dall-e-2/3 and most relays default to a
   * short-lived signed URL, which costs a second network round-trip that can
   * fail *after* the generation is already billed. Cleared on the one retry
   * below — gpt-image-1 always returns base64 and rejects the field outright,
   * as do some relays.
   */
  askB64 = !("response_format" in (req.extraBody ?? {})),
): Promise<ImageResult> {
  const url = openaiUrl(conn.baseUrl, "/images/generations");
  const deadline = withDeadline(req.signal, GENERATE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: conn.modelId,
        prompt: req.prompt,
        ...(askB64 ? { response_format: "b64_json" } : {}),
        // Only when it isn't the default: dall-e-3 rejects any n but 1, and
        // sending nothing means 1 everywhere. Same rule as the other routes.
        ...(req.n && req.n > 1 ? { n: req.n } : {}),
        ...(req.size ? { size: req.size } : {}),
        ...req.extraBody,
      }),
      signal: deadline.signal,
    });
  } finally {
    deadline.done();
  }

  if (!res.ok) {
    const err = new ImageHttpError("Image API error", res.status, await res.text());
    // The endpoint objected to the field we added, not to anything the author
    // asked for — drop it and go once more, rather than making them find
    // `extraBody` to use their model at all. Only ever one retry: `askB64` is
    // false on the way back in.
    if (askB64 && namesResponseFormat(err)) return openaiImage(conn, req, false);
    throw err;
  }
  return parseOpenAiImagePayload(await readJson(res, "Image API error"), req.signal);
}

/** True when an error is specifically about the `response_format` field. */
function namesResponseFormat(err: ImageHttpError): boolean {
  return err.param === "response_format" || /response_format/i.test(err.body);
}

/** The `{ data: [...] }` body, shared by the generations and edits endpoints. */
async function parseOpenAiImagePayload(raw: unknown, signal?: AbortSignal): Promise<ImageResult> {
  const json = raw as {
    data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string } | string;
  };
  // Status 200 with an error inside — carried as an ImageHttpError anyway so
  // the structured code/param survive for isEditUnsupportedError.
  if (json.error) throw new ImageHttpError("Image API error", 200, JSON.stringify({ error: json.error }));

  const entries = json.data ?? [];
  const images: GeneratedImage[] = [];
  for (const entry of entries) {
    if (entry.b64_json) {
      // The wire format carries no mime, so read it off the bytes: the
      // endpoints mostly return PNG, but `output_format: "jpeg"` exists and a
      // relay returns whatever its upstream did.
      const mime = sniffImageMime(entry.b64_json);
      images.push({ dataUrl: dataUrlOf(mime, entry.b64_json), mime });
    } else if (entry.url?.startsWith("data:")) {
      // Some relays put the base64 in `url`. Fetching that as a link happens
      // to work in a browser and does not in Tauri's reqwest transport.
      images.push({ dataUrl: entry.url, mime: mimeOfDataUrl(entry.url) });
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
  const url = openaiUrl(conn.baseUrl, "/images/edits");
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
  // Carried like every other route does — a relay that needs an extra field to
  // accept an edit had no way to get one here, with nothing saying why.
  // Multipart is flat, so object values go as JSON text.
  for (const [k, v] of Object.entries(req.extraBody ?? {})) {
    if (v === undefined || v === null) continue;
    form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }

  const deadline = withDeadline(req.signal, GENERATE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}) },
      body: form,
      signal: deadline.signal,
    });
    if (!res.ok) throw new ImageHttpError("Image edit error", res.status, await res.text());
    return await parseOpenAiImagePayload(await readJson(res, "Image edit error"), req.signal);
  } finally {
    deadline.done();
  }
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
  const url = openaiUrl(conn.baseUrl, "/chat/completions");
  // The chat protocol has no size/aspect fields, so the only channel this
  // route has for the author's framing choice is the prompt itself. Saying it
  // there is imperfect; dropping it silently — which is what happened before —
  // meant asking for 9:16 and getting a square picture with no explanation.
  const framing = [
    req.aspect ? `aspect ratio ${req.aspect}` : "",
    req.size ? `output size ${req.size}` : "",
  ].filter(Boolean).join(", ");
  const prompt = framing ? `${req.prompt}\n\n(Render at ${framing}.)` : req.prompt;

  const deadline = withDeadline(req.signal, GENERATE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
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
                { type: "text", text: prompt },
                ...req.images.map((url) => ({ type: "image_url", image_url: { url } })),
              ]
            : prompt,
        }],
        stream: false,
        // Same "only when it isn't the default" rule as the other routes. Most
        // relays serving an image model here return one picture regardless;
        // the UI says so rather than letting the count silently mean nothing.
        ...(req.n && req.n > 1 ? { n: req.n } : {}),
        ...req.extraBody,
      }),
      signal: deadline.signal,
    });
  } finally {
    deadline.done();
  }

  if (!res.ok) throw new ImageHttpError("Image API error", res.status, await res.text());

  const json = (await readJson(res, "Image API error")) as {
    choices?: { message?: {
      content?: string | { type?: string; text?: string; image_url?: { url?: string } }[];
      images?: ({ image_url?: { url?: string }; url?: string } | string)[];
    } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string } | string;
  };
  if (json.error) throw new ImageHttpError("Image API error", 200, JSON.stringify({ error: json.error }));

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
      images.push({ dataUrl: u, mime: mimeOfDataUrl(u) });
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
  const url = geminiUrl(conn.baseUrl, `/models/${conn.modelId}:generateContent`);

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
  const deadline = withDeadline(req.signal, GENERATE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
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
      signal: deadline.signal,
    });
  } finally {
    deadline.done();
  }

  if (!res.ok) throw new ImageHttpError("Gemini image error", res.status, await res.text());

  const json = (await readJson(res, "Gemini image error")) as {
    candidates?: {
      content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] };
      finishReason?: string;
    }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    error?: { message?: string };
  };
  if (json.error) throw new ImageHttpError("Gemini image error", 200, JSON.stringify({ error: json.error }));
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
