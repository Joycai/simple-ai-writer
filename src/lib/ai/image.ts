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
 * non-empty *is* the edit request. See docs/feature/image-generation-plan.md §2.
 */

import {
  analyzeComfyWorkflow, injectComfyInputs, parseComfySize, parseComfyWorkflow,
  type ComfyWorkflowConfig,
} from "../comfy/workflow";
import { fetch } from "../http";
import { beginImageApiLog, type ImageCallLogger } from "./apiLog";
import { convertToGeminiContents } from "./gemini";
import { toSafetySettingsArray } from "./safety";
import type { GeminiSafetySettings } from "./safety";
import { geminiAuthHeaders } from "./gemini";
import { familyOf, type ApiStandard, type AuthMode, type ImageRoute } from "./types";
import { geminiUrl, openaiUrl, trimBase } from "./urls";

/** The provider coordinates every image call needs. */
export interface ImageConn {
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  /** How to present the key. Compat endpoints only; officials have one scheme. */
  authMode?: AuthMode;
  modelId: string;
  safetySettings?: GeminiSafetySettings;
  /** Overrides the endpoint choice derived from `standard`. See ImageRoute. */
  route?: ImageRoute;
  /** dashscope route only: submit-and-poll instead of one synchronous call. */
  asyncTask?: boolean;
  /** comfyui route only: the model's imported workflow (ImageCaps.comfy). */
  comfy?: ComfyWorkflowConfig;
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

/**
 * How a submitted image task is getting on, for the routes that poll.
 *
 * The two async routes take **minutes** (their deadline is 10) and, once the
 * author has approved, the only thing above this layer is a tool step sitting
 * on "running" — which is what a dead endpoint looks like too. Reported here
 * rather than timed from outside because only this loop knows the endpoint is
 * still answering, and (on DashScope) whether the task is queued or drawing.
 *
 * `timeoutMs` is the useful half: it turns "is this stuck?" into "it has eight
 * more minutes before it gives up".
 */
export interface ImageProgress {
  /**
   * What the endpoint says it is doing. Omitted where it cannot say — ComfyUI's
   * history only records *finished* runs, so an absent entry means queued or
   * drawing and there is no way to tell which.
   */
  phase?: "queued" | "running";
  /** Polls made so far. */
  polls: number;
  /** Milliseconds since the task was submitted. */
  elapsedMs: number;
  /** When this task will be abandoned. */
  timeoutMs: number;
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
  /**
   * Called by the submit-and-poll routes while they wait. Never called by the
   * synchronous ones: one request has nothing to report between "sent" and
   * "answered", and inventing a tick there would be an animation, not a fact.
   */
  onProgress?: (p: ImageProgress) => void;
  /**
   * Negative prompt — what must not appear. Only the comfyui route has a wire
   * spelling for it (the workflow's negative node); every other route ignores
   * it, and callers there keep folding it into the prompt via `specToPrompt`.
   * Never folded into a ComfyUI positive prompt: SD attracts what it reads,
   * so "Avoid: watermark" in the positive *invites* watermarks.
   */
  negative?: string;
  /** e.g. "1024x1024". Omitted when the model declares no supported sizes. */
  size?: string;
  /**
   * e.g. "9:16". Gemini's image models take the framing this way rather than
   * as pixel dimensions; the OpenAI-shaped routes ignore it and use `size`.
   */
  aspect?: string;
  /**
   * Gemini resolution tier — "1K" | "2K" | "4K", sent as
   * `imageConfig.imageSize`. Only the gemini route has a spelling for it; the
   * chat route folds it into the prompt like the other framing fields.
   */
  imageSize?: string;
  /**
   * OpenAI quality tier — "low" | "medium" | "high". GPT-Image models only;
   * omitted means the endpoint's own default ("auto"). The other routes have
   * no such field and ignore it.
   */
  quality?: string;
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
    const json = JSON.parse(body) as {
      error?: { message?: string; code?: string; param?: string } | string;
      code?: string;
      message?: string;
    };
    if (typeof json.error === "string") return { message: json.error };
    if (json.error) {
      return { message: json.error.message, code: json.error.code, param: json.error.param };
    }
    // DashScope puts `{ code, message }` at the top level (and inside a failed
    // task's `output`). Reading it here is what lets a refusal like
    // `DataInspectionFailed` carry a structured code instead of falling
    // through to the prose regexes in isEditUnsupportedError.
    if (typeof json.code === "string" && json.code) {
      return { message: json.message, code: json.code };
    }
    if (typeof json.message === "string" && json.message) return { message: json.message };
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
    imageSize: req.imageSize,
    quality: req.quality,
    inputImages: req.images?.length ?? 0,
    extraBody: req.extraBody,
  });

  try {
    const result = await dispatchImage(route, conn, req, log);
    log.success({ images: result.images.length, usage: result.usage, text: result.text });
    return result;
  } catch (e) {
    log.error(e);
    throw e;
  }
}

function dispatchImage(route: ImageRoute, conn: ImageConn, req: ImageRequest, log: ImageCallLogger): Promise<ImageResult> {
  switch (route) {
    case "gemini":
      // One endpoint for both: the input images simply become extra parts.
      return geminiImage(conn, req);
    case "chat":
      // Likewise — an edit is a multimodal user message.
      return chatImage(conn, req);
    case "dashscope":
      // One route, two transports: wan text-to-image only exists as an async
      // task, everything else answers in the request. The split is a declared
      // capability (caps.asyncTask), not a model-id guess.
      return conn.asyncTask ? dashscopeAsyncImage(conn, req, log) : dashscopeImage(conn, req);
    case "comfyui":
      // A local instance running the model's imported workflow — submit the
      // injected graph, poll history, fetch the files. Never a derived route.
      return comfyImage(conn, req, log);
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
 * A picture from a base64 payload, typed by its bytes.
 *
 * The declared mime is only the fallback: a relay's `inlineData.mimeType` says
 * `image/png` over JPEG bytes (hk.chenmoai.com, 2026-09), and a file saved
 * under the declared extension then lies about its contents.
 */
function imageFromBase64(base64: string, declared?: string): GeneratedImage {
  const mime = sniffImageMime(base64, declared || "image/png");
  return { dataUrl: dataUrlOf(mime, base64), mime };
}

/** Same rule for a data URL already assembled by the endpoint. */
function imageFromDataUrl(dataUrl: string): GeneratedImage {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return { dataUrl, mime: mimeOfDataUrl(dataUrl) };
  const payload = dataUrl.slice(comma + 1);
  const declared = mimeOfDataUrl(dataUrl);
  const mime = sniffImageMime(payload, declared);
  return mime === declared ? { dataUrl, mime } : { dataUrl: dataUrlOf(mime, payload), mime };
}

/** A whole string that is nothing but a picture — a bare link or bare base64. */
function classifyBareText(text: string): { kind: "link" | "base64"; value: string } | undefined {
  const t = text.trim();
  if (/^https?:\/\/\S+$/.test(t)) return { kind: "link", value: t };
  // 64 chars is well past any prose; the signature check is what decides.
  if (t.length >= 64 && /^[A-Za-z0-9+/]+=*$/.test(t) && sniffImageMime(t, "")) return { kind: "base64", value: t };
  return undefined;
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
    return imageFromBase64(btoa(binary), mime);
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
        ...(req.quality ? { quality: req.quality } : {}),
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
      images.push(imageFromDataUrl(entry.url));
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

/** The sizes the GPT-Image edits endpoint documents (besides "auto"). */
const EDIT_PRESET_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;

/** The documented edit preset whose aspect ratio is closest to `size`'s. */
function nearestEditPreset(size: string): string | undefined {
  const [w, h] = size.toLowerCase().split(/[x*×]/).map(Number);
  if (!w || !h) return undefined;
  let best: string | undefined;
  let delta = Infinity;
  for (const preset of EDIT_PRESET_SIZES) {
    const [pw, ph] = preset.split("x").map(Number);
    const d = Math.abs(Math.log(pw / ph) - Math.log(w / h));
    if (d < delta) { delta = d; best = preset; }
  }
  return best;
}

/**
 * True when an error is specifically about the `size` field's value.
 *
 * Deliberately narrow on the prose side: "size" also appears in complaints
 * about *file* size, and retrying with a different dimension cannot fix those.
 */
function namesSizeValue(err: ImageHttpError): boolean {
  if (err.param === "size") return true;
  if (err.param) return false;
  return /\bsize\b[^.]{0,60}(invalid|unsupported|not\s+supported)|(invalid|unsupported|not\s+supported)[^.]{0,40}\bsize\b/i
    .test(err.body);
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
 * (Transport verified in docs/feature/image-generation-plan.md §2.3.)
 */
async function openaiEdit(
  conn: ImageConn,
  req: ImageRequest,
  /**
   * One shot at recovering from a rejected `size`. gpt-image-2's generations
   * take arbitrary dimensions and the dialect sends the same on edits — the
   * official doc lists only presets there, and endpoints that enforce that
   * answer 400 (unbilled). The retry swaps in the closest documented preset,
   * or drops the field entirely if a preset was already what got rejected.
   */
  sizeRetry = true,
): Promise<ImageResult> {
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
  if (req.quality) form.append("quality", req.quality);
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
    if (!res.ok) {
      const err = new ImageHttpError("Image edit error", res.status, await res.text());
      if (sizeRetry && req.size && namesSizeValue(err)) {
        const preset = nearestEditPreset(req.size);
        // A preset that already failed means the endpoint wants no size at all.
        return openaiEdit(conn, { ...req, size: preset !== req.size ? preset : undefined }, false);
      }
      throw err;
    }
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
    req.imageSize ? `resolution ${req.imageSize}` : "",
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
          // Always the parts array, even with no input image. An edit is just
          // a multimodal message here — the same `image_url` parts a vision
          // request uses, which is why relays accept it — and the relay that
          // translates this call into an image request answers a plain string
          // with `400 images[0] must be an http/https URL or image data URI`
          // while taking the one-part array (hk.chenmoai.com `[R]gpt-image-2`,
          // 2026-09; it had accepted the string an hour earlier, so the two
          // spellings reach different channels). The array is valid Chat
          // Completions everywhere; the string is the one that costs a route.
          content: [
            { type: "text", text: prompt },
            ...(req.images ?? []).map((url) => ({ type: "image_url", image_url: { url } })),
          ],
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
      images?: ({ image_url?: { url?: string }; url?: string; b64_json?: string } | string)[];
      image_b64_json?: string;
    } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string } | string;
  };
  if (json.error) throw new ImageHttpError("Image API error", 200, JSON.stringify({ error: json.error }));

  // There is no one shape here — the protocol has no image field, so every
  // relay invents its own, and one answer often carries the same picture in
  // several places at once. Seen so far (each is a real endpoint, not a guess):
  //   - `images[].image_url.url` (OpenRouter-style, data URL or link)
  //   - `content` with markdown `![](…)` (newAPI serving Gemini image models)
  //   - `content` as a multimodal part array
  //   - `images[].b64_json` + `image_b64_json` + `content` = the same bare
  //     base64 string three times, and an *edit* answered with a bare signed
  //     URL as `content` (hk.chenmoai.com, `[R]gpt-image-2`, 2026-09)
  // Everything found is deduplicated by value, so a picture repeated across
  // fields comes out once; links are downloaded in the order they appeared.
  const message = json.choices?.[0]?.message;
  const found: (GeneratedImage | { link: string })[] = [];
  const seen = new Set<string>();
  const texts: string[] = [];
  const addBase64 = (b64: string, declared?: string) => {
    if (seen.has(b64)) return;
    seen.add(b64);
    found.push(imageFromBase64(b64, declared));
  };
  const addUrl = (u: string) => {
    if (u.startsWith("data:")) {
      const payload = u.slice(u.indexOf(",") + 1);
      if (seen.has(payload)) return;
      seen.add(payload);
      found.push(imageFromDataUrl(u));
    } else if (!seen.has(u)) {
      seen.add(u);
      found.push({ link: u });
    }
  };
  const addText = (text: string) => {
    const bare = classifyBareText(text);
    if (!bare) texts.push(text.trim());
    else if (bare.kind === "link") addUrl(bare.value);
    else addBase64(bare.value);
  };

  for (const entry of message?.images ?? []) {
    if (typeof entry === "string") addUrl(entry);
    else if (entry.b64_json) addBase64(entry.b64_json);
    else {
      const u = entry.image_url?.url ?? entry.url;
      if (u) addUrl(u);
    }
  }
  if (message?.image_b64_json) addBase64(message.image_b64_json);
  if (typeof message?.content === "string") {
    for (const m of message.content.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) addUrl(m[1]);
    // Strip the markdown images so the leftover prose reads as commentary —
    // unless the leftover *is* the picture (bare base64 or a bare link).
    const prose = message.content.replace(/!\[[^\]]*\]\([^)\s]+\)/g, "").trim();
    if (prose) addText(prose);
  } else if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (part.image_url?.url) addUrl(part.image_url.url);
      else if (part.text) addText(part.text);
    }
  }

  const images: GeneratedImage[] = [];
  for (const f of found) images.push("link" in f ? await urlToDataUrl(f.link, req.signal) : f);
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
 * Non-streaming on purpose: the payload is one inlineData blob, so streaming
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
  // Gemini takes framing as a ratio, not pixel dimensions — `size` is
  // meaningless here. The resolution tier ("1K"/"2K"/"4K") lives in the same
  // config object; both are omitted when unset, which is the one request every
  // model revision accepts (gemini-2.5-flash-image has no imageSize at all).
  const imageConfig = {
    ...(req.aspect ? { aspectRatio: req.aspect } : {}),
    ...(req.imageSize ? { imageSize: req.imageSize } : {}),
  };
  const deadline = withDeadline(req.signal, GENERATE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...geminiAuthHeaders(conn.apiKey, conn.authMode) },
      body: JSON.stringify({
        contents,
        generationConfig: {
          // TEXT stays in the list: the image models refuse an IMAGE-only
          // modality set on some revisions, and the text part is useful anyway.
          responseModalities: ["TEXT", "IMAGE"],
          ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
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
        // Typed by the bytes, not the declared mime — see imageFromBase64.
        images.push(imageFromBase64(part.inlineData.data, part.inlineData.mimeType));
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

// ─── DashScope (Qwen / Wan image models, native protocol) ────────────────────
//
// DashScope's compatible-mode serves text models only; its image models speak
// the native `input.messages` / `parameters` shape at /api/v1. Generation and
// editing are the same call — input images are extra content parts — and the
// answer is a short-lived (24 h) https URL, downloaded immediately like every
// other link-returning endpoint here. Wan text-to-image is the one async case:
// submit with `X-DashScope-Async`, then poll /tasks/{id}.
// Protocol facts: docs/api/landscape.md.

/**
 * The native `/api/v1` base for a DashScope provider row.
 *
 * The provider preset stores the compatible-mode base
 * (`https://dashscope.aliyuncs.com/compatible-mode/v1`) because that is what
 * the text side speaks — deriving the native base from it means one provider
 * row and one keyring entry serve both, on the domestic and intl hosts alike.
 * A base that is already native (or a bare host) passes through unchanged.
 */
export function dashscopeNativeBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const host = trimmed.replace(/\/compatible-mode\/v1$/, "").replace(/\/api\/v1$/, "");
  return `${host}/api/v1`;
}

/** `1024x1024` → `1024*1024`; anything that isn't `W×H` (e.g. "2K") passes through. */
function normalizeDashscopeSize(size: string): string {
  const m = size.toLowerCase().match(/^(\d+)\s*[x*×]\s*(\d+)$/);
  return m ? `${m[1]}*${m[2]}` : size;
}

/**
 * The shared request body — sync and async take the same shape. `extraBody`
 * merges into `parameters` rather than the top level: that is DashScope's
 * knob namespace (`negative_prompt`, `watermark`, `seed`, `prompt_extend`…),
 * and the top level has only `model` and `input` beside it.
 */
function dashscopeBody(conn: ImageConn, req: ImageRequest): Record<string, unknown> {
  return {
    model: conn.modelId,
    input: {
      messages: [{
        role: "user",
        content: [
          ...(req.images ?? []).map((image) => ({ image })),
          { text: req.prompt },
        ],
      }],
    },
    parameters: {
      // Always explicit, unlike the other routes: wan2.7's documented default
      // is n = 4 — omitting the field there would draw (and bill) four
      // pictures when the author asked for one.
      n: req.n ?? 1,
      ...(req.size ? { size: normalizeDashscopeSize(req.size) } : {}),
      ...req.extraBody,
    },
  };
}

function dashscopeHeaders(conn: ImageConn): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}),
  };
}

/** Both output shapes: `choices[].message.content[]` (qwen) and `results[].url` (wan tasks). */
interface DashscopeOutput {
  choices?: { message?: { content?: ({ image?: string; text?: string } | string)[] } }[];
  results?: { url?: string }[];
  task_status?: string;
  code?: string;
  message?: string;
}

function parseDashscopeOutput(output: DashscopeOutput | undefined): { urls: string[]; texts: string[] } {
  const urls: string[] = [];
  const texts: string[] = [];
  for (const choice of output?.choices ?? []) {
    const content = choice.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === "string") {
        if (part.trim()) texts.push(part);
      } else if (part.image) {
        urls.push(part.image);
      } else if (part.text) {
        texts.push(part.text);
      }
    }
  }
  for (const r of output?.results ?? []) if (r.url) urls.push(r.url);
  return { urls, texts };
}

/** Download every URL now — DashScope links expire in 24 h — and inline data URLs as-is. */
async function collectDashscopeImages(
  urls: string[],
  texts: string[],
  signal: AbortSignal | undefined,
): Promise<ImageResult> {
  const images: GeneratedImage[] = [];
  for (const u of urls) {
    if (u.startsWith("data:")) images.push({ dataUrl: u, mime: mimeOfDataUrl(u) });
    else images.push(await urlToDataUrl(u, signal));
  }
  if (!images.length) throw new NoImageError(texts.join(" ").slice(0, 200) || undefined);
  // No usage: DashScope reports image counts and dimensions, not tokens —
  // billing goes through pricePerImage like the other per-image endpoints.
  return { images, ...(texts.length ? { text: texts.join("\n\n") } : {}) };
}

/**
 * `POST /services/aigc/multimodal-generation/generation` — the synchronous
 * path, serving qwen-image-3.0*, qwen-image-edit*, z-image-turbo and wan
 * editing.
 */
async function dashscopeImage(conn: ImageConn, req: ImageRequest): Promise<ImageResult> {
  const url = `${dashscopeNativeBase(conn.baseUrl)}/services/aigc/multimodal-generation/generation`;
  const deadline = withDeadline(req.signal, GENERATE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: dashscopeHeaders(conn),
      body: JSON.stringify(dashscopeBody(conn, req)),
      signal: deadline.signal,
    });
  } finally {
    deadline.done();
  }

  if (!res.ok) throw new ImageHttpError("Image API error", res.status, await res.text());
  const json = (await readJson(res, "Image API error")) as { code?: string; output?: DashscopeOutput };
  // Status 200 with `code` set is how DashScope delivers e.g.
  // DataInspectionFailed — an ImageHttpError so the structured code survives.
  if (json.code) throw new ImageHttpError("Image API error", 200, JSON.stringify(json));

  const { urls, texts } = parseDashscopeOutput(json.output);
  return collectDashscopeImages(urls, texts, req.signal);
}

/** Wall-clock cap on one async task, submit through last download. */
const DASHSCOPE_TASK_TIMEOUT_MS = 600_000;
/** Poll cadence: the documented ~3 s at first, easing off for long renders. */
const DASHSCOPE_POLL_MS = 3_000;
const DASHSCOPE_POLL_SLOW_MS = 5_000;

/** Sleep that a deadline or the user's 停止 can cut short. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) return fail();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      fail();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The async task flow (wan text-to-image): submit to
 * `/services/aigc/image-generation/generation` with `X-DashScope-Async`, then
 * poll `/tasks/{id}` until it settles. One deadline spans the whole task —
 * the generation is minutes, not seconds, so the per-call cap would be wrong.
 */
async function dashscopeAsyncImage(conn: ImageConn, req: ImageRequest, log: ImageCallLogger): Promise<ImageResult> {
  const base = dashscopeNativeBase(conn.baseUrl);
  const deadline = withDeadline(req.signal, DASHSCOPE_TASK_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/services/aigc/image-generation/generation`, {
      method: "POST",
      headers: { ...dashscopeHeaders(conn), "X-DashScope-Async": "enable" },
      body: JSON.stringify(dashscopeBody(conn, req)),
      signal: deadline.signal,
    });
    if (!res.ok) throw new ImageHttpError("Image API error", res.status, await res.text());
    const submitted = (await readJson(res, "Image API error")) as {
      code?: string;
      output?: { task_id?: string };
    };
    if (submitted.code) throw new ImageHttpError("Image API error", 200, JSON.stringify(submitted));
    const taskId = submitted.output?.task_id;
    if (!taskId) throw new ImageHttpError("Image API error", 200, JSON.stringify(submitted).slice(0, 400));
    // The one fact a hung poll would otherwise take with it.
    log.note({ taskId });

    let polls = 0;
    let misses = 0;
    const submittedAt = Date.now();
    for (;;) {
      await sleep(polls < 10 ? DASHSCOPE_POLL_MS : DASHSCOPE_POLL_SLOW_MS, deadline.signal);
      polls++;

      let json: { output?: DashscopeOutput };
      try {
        const poll = await fetch(`${base}/tasks/${taskId}`, {
          headers: dashscopeHeaders(conn),
          signal: deadline.signal,
        });
        if (!poll.ok) throw new ImageHttpError("Image task error", poll.status, await poll.text());
        json = (await readJson(poll, "Image task error")) as { output?: DashscopeOutput };
      } catch (e) {
        // The generation is already paid for and a poll is a cheap GET, so a
        // network blip or a 429 is worth riding out — but only a few in a row,
        // after which the error is real.
        if (deadline.signal.aborted || ++misses >= 3) throw e;
        continue;
      }
      misses = 0;

      const status = json.output?.task_status;
      if (status === "PENDING" || status === "RUNNING") {
        req.onProgress?.({
          phase: status === "PENDING" ? "queued" : "running",
          polls,
          elapsedMs: Date.now() - submittedAt,
          timeoutMs: DASHSCOPE_TASK_TIMEOUT_MS,
        });
        continue;
      }
      if (status === "SUCCEEDED") {
        const { urls, texts } = parseDashscopeOutput(json.output);
        return await collectDashscopeImages(urls, texts, deadline.signal);
      }
      // FAILED / CANCELED / anything unrecognized. The failure's code and
      // message live inside `output`, which parseErrorBody reads top-level.
      throw new ImageHttpError("Image task error", 200, JSON.stringify(json.output ?? json));
    }
  } finally {
    deadline.done();
  }
}

// ─── ComfyUI (local instance, imported workflow) ─────────────────────────────
//
// The one route with no model id: the whole "model" is an API-format workflow
// the author exported from ComfyUI and imported in Settings (ImageCaps.comfy).
// This adapter only injects the request's values into the graph's placeholder
// nodes (lib/comfy/workflow.ts) and drives submit → poll → fetch; it never
// constructs nodes itself. Design: docs/feature/comfyui-plan.md §2.

/** Wall-clock cap on one workflow run — local SD on a weak GPU takes minutes. */
const COMFY_TASK_TIMEOUT_MS = 600_000;
/** Constant cadence: a loopback GET is nearly free, so no backoff needed. */
const COMFY_POLL_MS = 1_000;

/**
 * A fresh random seed per submission. ComfyUI caches node outputs by input
 * hash, so resubmitting a byte-identical graph re-executes nothing and can
 * complete without producing a new image — "retry" only means anything if the
 * seed moves. An explicit `extraBody.seed` overrides for reproducible runs.
 */
function randomComfySeed(): number {
  return Math.floor(Math.random() * 0xffff_ffff);
}

interface ComfyHistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
  outputs?: Record<string, { images?: { filename?: string; subfolder?: string; type?: string }[] }>;
}

/**
 * The files a finished run produced. SaveImage nodes emit `type: "output"`,
 * PreviewImage emits `"temp"` — when both exist only the outputs count, so an
 * author's debugging preview nodes don't leak into the result.
 */
function collectComfyFiles(entry: ComfyHistoryEntry): { filename: string; subfolder: string; type: string }[] {
  const all: { filename: string; subfolder: string; type: string }[] = [];
  for (const out of Object.values(entry.outputs ?? {})) {
    for (const img of out.images ?? []) {
      if (img.filename) all.push({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
    }
  }
  const saved = all.filter((f) => f.type === "output");
  return saved.length ? saved : all;
}

/** A failed run's detail, shaped so parseErrorBody surfaces the message. */
function comfyErrorDetail(status: NonNullable<ComfyHistoryEntry["status"]>): string {
  for (const [name, data] of status.messages ?? []) {
    if (name === "execution_error") {
      const nodeType = typeof data.node_type === "string" ? data.node_type : "node";
      const msg = typeof data.exception_message === "string" ? data.exception_message : "execution failed";
      return JSON.stringify({ message: `${nodeType}: ${msg}` });
    }
  }
  return JSON.stringify({ message: status.status_str ?? "the workflow run failed" });
}

/**
 * Best-effort cancel after the author's 停止 (or the deadline): drop the job
 * from the queue, and only if it is confirmed to be the one *running* send an
 * interrupt — a blind /interrupt would kill whatever the author's own ComfyUI
 * tab happens to be rendering.
 */
async function cancelComfyTask(base: string, promptId: string): Promise<void> {
  try {
    await fetch(`${base}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
    });
    const res = await fetch(`${base}/queue`);
    if (!res.ok) return;
    const q = (await res.json()) as { queue_running?: unknown[][] };
    const running = q.queue_running?.some((item) => Array.isArray(item) && item[1] === promptId);
    if (running) await fetch(`${base}/interrupt`, { method: "POST" });
  } catch {
    // The job at worst renders into ComfyUI's own output folder unobserved.
  }
}

/**
 * Upload one input image to ComfyUI's input store, returning the name a
 * LoadImage node's `image` input takes.
 *
 * A fresh random filename per upload, `overwrite` on: reusing a name would be
 * exactly the input-hash collision the seed randomization exists to avoid —
 * a LoadImage whose filename *and* bytes both repeat resolves from cache.
 *
 * **`Content-Type` must not be set here** — same multipart rule as
 * `openaiEdit`: the webview generates the boundary-bearing header only for
 * headers the caller did not declare.
 */
async function uploadComfyImage(base: string, dataUrl: string, signal: AbortSignal): Promise<string> {
  const { bytes, mime } = decodeDataUrl(dataUrl);
  const form = new FormData();
  const name = `aiwriter-${Math.random().toString(36).slice(2, 10)}.${extForMime(mime)}`;
  form.append("image", new Blob([bytes], { type: mime }), name);
  form.append("overwrite", "true");
  const res = await fetch(`${base}/upload/image`, { method: "POST", body: form, signal });
  if (!res.ok) throw new ImageHttpError("ComfyUI upload error", res.status, await res.text());
  const json = (await readJson(res, "ComfyUI upload error")) as { name?: string; subfolder?: string };
  if (!json.name) throw new ImageHttpError("ComfyUI upload error", 200, JSON.stringify(json).slice(0, 400));
  return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
}

async function comfyImage(conn: ImageConn, req: ImageRequest, log: ImageCallLogger): Promise<ImageResult> {
  const raw = conn.comfy?.workflow;
  if (!raw) {
    throw new Error("This model has no ComfyUI workflow imported — import an API-format export in Settings → 供应商与模型.");
  }
  const parsed = parseComfyWorkflow(raw);
  if ("error" in parsed) {
    throw new Error(`The stored ComfyUI workflow no longer parses (${parsed.error}) — re-import it in Settings.`);
  }

  // Input images ride the workflow's own LoadImage nodes — checked before any
  // upload so a mismatch costs nothing. A plain Error on purpose: it stays out
  // of isEditUnsupportedError (which only reads ImageHttpError), so the
  // no-slots case surfaces as configuration advice instead of triggering the
  // degrade-to-regeneration retry against the same graph.
  const inputImages = req.images ?? [];
  const slots = analyzeComfyWorkflow(parsed.graph).loadImageNodes.length;
  if (inputImages.length > slots) {
    throw new Error(
      slots === 0
        ? "This workflow has no LoadImage node, so it cannot take input images — img2img and references need a workflow with one."
        : `This workflow has ${slots} image input(s) (LoadImage) but ${inputImages.length} were supplied — drop some references or export a workflow with more slots.`,
    );
  }

  const base = trimBase(conn.baseUrl);
  const deadline = withDeadline(req.signal, COMFY_TASK_TIMEOUT_MS);
  let promptId: string | undefined;
  try {
    // Uploads share the run's deadline — a stalled 8MB transfer to a hung
    // instance should die with the run, not hold its own timer.
    const explicitSeed = req.extraBody?.seed;
    const size = parseComfySize(req.size);
    const imageNames: string[] = [];
    for (const dataUrl of inputImages) {
      imageNames.push(await uploadComfyImage(base, dataUrl, deadline.signal));
    }
    const graph = injectComfyInputs(parsed.graph, {
      prompt: req.prompt,
      negative: req.negative,
      seed: typeof explicitSeed === "number" ? explicitSeed : randomComfySeed(),
      ...(size ?? {}),
      batch: req.n,
      ...(imageNames.length ? { imageNames } : {}),
    });
    if (!graph) {
      throw new Error(
        "No positive-prompt node could be located in this workflow — in ComfyUI, title a text node \"positive\"（正面） and re-export the API format.",
      );
    }
    const res = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph }),
      signal: deadline.signal,
    });
    // A 400 here carries node_errors — missing custom nodes, renamed
    // checkpoints — which is exactly what the author needs to see verbatim.
    if (!res.ok) throw new ImageHttpError("ComfyUI error", res.status, await res.text());
    const submitted = (await readJson(res, "ComfyUI error")) as { prompt_id?: string };
    if (!submitted.prompt_id) {
      throw new ImageHttpError("ComfyUI error", 200, JSON.stringify(submitted).slice(0, 400));
    }
    promptId = submitted.prompt_id;
    // Same rule as the DashScope task id: the one fact a hung poll would
    // otherwise take with it.
    log.note({ taskId: promptId });

    let misses = 0;
    let polls = 0;
    const submittedAt = Date.now();
    for (;;) {
      await sleep(COMFY_POLL_MS, deadline.signal);
      polls++;

      let entry: ComfyHistoryEntry | undefined;
      try {
        const poll = await fetch(`${base}/history/${promptId}`, { signal: deadline.signal });
        if (!poll.ok) throw new ImageHttpError("ComfyUI task error", poll.status, await poll.text());
        const json = (await readJson(poll, "ComfyUI task error")) as Record<string, ComfyHistoryEntry>;
        entry = json[promptId];
      } catch (e) {
        // A loopback blip is rare but a restarting ComfyUI is not — ride out a
        // few misses before calling it real, like the DashScope poll does.
        if (deadline.signal.aborted || ++misses >= 3) throw e;
        continue;
      }
      misses = 0;

      // History only records finished runs — absent means still queued/running,
      // and there is no way here to tell which, so `phase` is left out.
      if (!entry) {
        req.onProgress?.({
          polls,
          elapsedMs: Date.now() - submittedAt,
          timeoutMs: COMFY_TASK_TIMEOUT_MS,
        });
        continue;
      }
      if (entry.status?.status_str === "error") {
        throw new ImageHttpError("ComfyUI task error", 200, comfyErrorDetail(entry.status));
      }

      const files = collectComfyFiles(entry);
      if (!files.length) {
        throw new NoImageError(
          "the workflow completed without producing an image — does it end in a SaveImage node? (An unchanged graph also re-executes nothing; the app randomizes the seed to avoid this.)",
        );
      }
      const images: GeneratedImage[] = [];
      for (const f of files) {
        const query =
          `filename=${encodeURIComponent(f.filename)}` +
          `&subfolder=${encodeURIComponent(f.subfolder)}` +
          `&type=${encodeURIComponent(f.type)}`;
        images.push(await urlToDataUrl(`${base}/view?${query}`, deadline.signal));
      }
      // No usage and no text: ComfyUI meters nothing, and billing stays on
      // pricePerImage (normally 0 — it is the author's own GPU).
      return { images };
    }
  } catch (e) {
    if (promptId && deadline.signal.aborted) void cancelComfyTask(base, promptId);
    throw e;
  } finally {
    deadline.done();
  }
}
