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
import type { ApiStandard } from "./types";

/** The provider coordinates every image call needs. */
export interface ImageConn {
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  modelId: string;
  safetySettings?: GeminiSafetySettings;
}

export interface ImageRequest {
  prompt: string;
  /**
   * Input images as base64 data URLs. Non-empty turns the call into an edit.
   * PR1 generates only — the field exists so adapters can be extended without
   * reshaping the interface, and `generateImage` rejects it for now.
   */
  images?: string[];
  /** How many images to return. Providers cap this; the caller should too. */
  n?: number;
  /** e.g. "1024x1024". Omitted when the model declares no supported sizes. */
  size?: string;
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
  if (req.images?.length) {
    // Guard rather than silently dropping the images and returning an
    // unrelated fresh generation, which would read as the model ignoring the
    // edit. Lifted in PR2 when the edit paths land.
    throw new Error("Image editing is not implemented yet (PR2).");
  }
  return conn.standard === "gemini" ? geminiImage(conn, req) : openaiImage(conn, req);
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function dataUrlOf(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
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

  const json = (await res.json()) as {
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
      // asked otherwise, and the caller never asks in PR1.
      images.push({ dataUrl: dataUrlOf("image/png", entry.b64_json), mime: "image/png" });
    } else if (entry.url) {
      images.push(await urlToDataUrl(entry.url, req.signal));
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
