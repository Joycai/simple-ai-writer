/**
 * Media in the history goes out only where this request admits it
 * (docs/feature/video-input.md §「历史里的媒体按请求放行」).
 *
 * The history outlives the model: a clip attached under a Chat-route model
 * stays in `chats[key].history` when the author switches to the native route,
 * to Gemini, to Anthropic, or to a model that does not see. Every request
 * projects it through the plan's `media`, so the adapters' named throws are
 * never reached, and the history itself is never edited — switch back and the
 * clip goes out again.
 *
 * Everything here runs the real `streamCompletion` with `fetch` stubbed to
 * capture the body the adapter built.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamCompletion, type StreamMessage, type StreamOptions } from "../index";
import { connOptions, type ConnOptions } from "../conn";
import { planRequest } from "../capability/plan";
import { __resetLearned } from "../capability/learned";
import { PLATFORM_IDS, platformEndpoints } from "../platforms";
import { standardOf } from "../routes";
import type { Model, ModelType, Provider } from "../configDb";
import type { ContentPart } from "../types";
import type { MediaKind } from "../mediaParts";

// Base64 payloads that survive every adapter's spelling (Gemini and Anthropic
// split the data URL; the payload itself goes out verbatim), so "did this kind
// reach the wire" is a substring test on the body.
const PAYLOAD: Record<MediaKind, string> = { image: "SU1BR0VQQVlMT0FE", video: "VklERU9QQVlMT0FE", pdf: "UERGUEFZTE9BRA" };
const PART: Record<MediaKind, ContentPart> = {
  image: { type: "image_url", image_url: { url: `data:image/png;base64,${PAYLOAD.image}` } },
  video: { type: "video_url", video_url: { url: `data:video/mp4;base64,${PAYLOAD.video}` } },
  pdf: { type: "file", file: { file_data: `data:application/pdf;base64,${PAYLOAD.pdf}`, filename: "brief.pdf" } },
};
const NOTE: Record<MediaKind, string> = { image: "[picture not sent", video: "[video clip not sent", pdf: "[PDF not sent" };
const KINDS: readonly MediaKind[] = ["image", "video", "pdf"];

const BASE_URL = "https://media-history.invalid/v1";
const ROUTES = PLATFORM_IDS.flatMap((platform) =>
  platformEndpoints(platform).map((e) => ({ platform, standard: standardOf({ family: e.family, official: !!e.official }) })),
);
const TYPES: readonly ModelType[] = ["multimodal", "vision", "multimodal", "vision", "text"];
const MODEL_IDS = ["qwen3.8-flash", "qwen3-vl-plus", "gemini-3-flash", "claude-sonnet-5", "[特价kiro量]claude-opus-5"];

afterEach(() => {
  vi.unstubAllGlobals();
  __resetLearned();
});

/** Sends through the real `streamCompletion`; returns the body the adapter built, or the error it threw first. */
async function send(opts: Omit<StreamOptions, "onChunk">): Promise<{ body?: string; error?: string }> {
  let body: string | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    body = String(init.body);
    throw new Error("captured");
  }));
  try {
    await streamCompletion({ ...opts, onChunk: () => {} });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message !== "captured") return { error: message };
  }
  return { body };
}

/** A chat history: turns with words, some carrying media, one tool round now and then. */
function history(r: () => number, seed: number): { messages: StreamMessage[]; words: string[]; kinds: Set<MediaKind> } {
  const messages: StreamMessage[] = [];
  const words: string[] = [];
  const kinds = new Set<MediaKind>();
  const turns = 1 + Math.floor(r() * 4);
  for (let t = 0; t < turns; t++) {
    const word = `w${seed}x${t}`;
    words.push(word);
    const parts: ContentPart[] = [{ type: "text", text: word }];
    for (const k of KINDS) {
      // Weighted toward clips and PDFs: those are the kinds most routes refuse.
      if (r() < (k === "image" ? 0.35 : 0.5)) {
        parts.push(PART[k]);
        kinds.add(k);
      }
    }
    messages.push({ role: "user", content: parts.length > 1 ? parts : word });
    if (t < turns - 1) {
      if (r() < 0.3) {
        const id = `call_${seed}_${t}`;
        messages.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "look", arguments: "{}" } }] });
        messages.push({ role: "tool", tool_call_id: id, content: `tool result ${word}` });
      }
      messages.push({ role: "assistant", content: `reply ${word}` });
    }
  }
  return { messages, words, kinds };
}

function draw(seed: number) {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const route = pick(ROUTES);
  const provider: Provider = { id: "p", name: "p", baseUrl: BASE_URL, apiStandard: route.standard, platform: route.platform, createdAt: 0 };
  const model: Model = {
    id: "m", providerId: "p", modelId: pick(MODEL_IDS), name: "m", type: pick(TYPES),
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true,
    ...(r() < 0.6 ? { videoInput: true } : {}),
    ...(r() < 0.6 ? { pdfInput: true } : {}),
  };
  // Mostly as the app builds a request; now and then a hand-built bag that
  // declares nothing, which only the route binds.
  const conn = connOptions({ model, provider, apiKey: "k" });
  const handBuilt = r() < 0.2;
  const { modelType: _t, videoInput: _v, pdfInput: _p, ...bare } = conn;
  const transport: ConnOptions = handBuilt ? bare : conn;
  return { transport, ...history(r, seed) };
}

describe("history media on every route", () => {
  it("goes out where admitted, as a note where not — never a throw, never an edit, never a lost word", async () => {
    const refusedSeen: Record<MediaKind, number> = { image: 0, video: 0, pdf: 0 };
    const sentSeen: Record<MediaKind, number> = { image: 0, video: 0, pdf: 0 };
    for (let seed = 1; seed < 1500; seed++) {
      const { transport, messages, words, kinds } = draw(seed);
      const before = structuredClone(messages);
      const media = planRequest({ ...transport, messages }).media;
      const at = `seed ${seed}: ${transport.platform} ${transport.standard} ${transport.modelType ?? "(bag)"} ${transport.modelId}`;

      const { body, error } = await send({ ...transport, messages });

      expect(error, at).toBeUndefined();
      expect(body, at).toBeDefined();
      expect(messages, `${at}: the history was edited`).toEqual(before);
      for (const w of words) expect(body, `${at}: lost "${w}"`).toContain(w);
      for (const k of KINDS) {
        const inHistory = kinds.has(k);
        expect(body!.includes(PAYLOAD[k]), `${at}: ${k} on the wire`).toBe(inHistory && media[k]);
        expect(body!.includes(NOTE[k]), `${at}: ${k} note`).toBe(inHistory && !media[k]);
        if (inHistory) (media[k] ? sentSeen : refusedSeen)[k]++;
      }
    }
    // The walk reached both outcomes for every kind, often.
    for (const k of KINDS) {
      expect(refusedSeen[k], `${k} refused`).toBeGreaterThan(50);
      expect(sentSeen[k], `${k} sent`).toBeGreaterThan(50);
    }
  });
});

describe("switching the model under a history", () => {
  const dashscope = (apiStandard: Provider["apiStandard"], path: string): Provider => ({
    id: "bailian", name: "百炼", baseUrl: `https://maas.qianwenaiapi.com${path}`, apiStandard, platform: "dashscope", createdAt: 0,
  });
  const chatRoute = dashscope("openai_compat", "/compatible-mode/v1");
  const nativeRoute = dashscope("dashscope_compat", "/api/v1");
  const reader: Model = {
    id: "m", providerId: "bailian", modelId: "qwen3.8-flash", name: "m", type: "multimodal",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, videoInput: true,
  };
  const clipTurn = (): StreamMessage[] => [
    { role: "user", content: [{ type: "text", text: "这段视频里发生了什么？" }, PART.video] },
    { role: "assistant", content: "一位旅人走进了灯塔。" },
    { role: "user", content: "然后呢？" },
  ];

  it("a clip goes out on the Chat route, becomes a note on the native one, and goes out again after switching back", async () => {
    const messages = clipTurn();
    const onChat = await send({ ...connOptions({ model: reader, provider: chatRoute, apiKey: "k" }), messages });
    expect(onChat.body).toContain(PAYLOAD.video);

    const onNative = await send({ ...connOptions({ model: reader, provider: nativeRoute, apiKey: "k" }), messages });
    expect(onNative.error).toBeUndefined();
    expect(onNative.body).not.toContain(PAYLOAD.video);
    expect(onNative.body).toContain(NOTE.video);
    expect(onNative.body).toContain("这段视频里发生了什么？");

    const back = await send({ ...connOptions({ model: reader, provider: chatRoute, apiKey: "k" }), messages });
    expect(back.body).toContain(PAYLOAD.video);
    expect(messages).toEqual(clipTurn());
  });

  it("a picture in the history reaches a model that does not see as a note, not an image part", async () => {
    const messages: StreamMessage[] = [
      { role: "user", content: [{ type: "text", text: "看看这张草图" }, PART.image] },
      { role: "assistant", content: "是一座灯塔。" },
      { role: "user", content: "继续写" },
    ];
    const writer: Model = { ...reader, type: "text", videoInput: undefined };
    const { body } = await send({ ...connOptions({ model: writer, provider: chatRoute, apiKey: "k" }), messages });
    expect(body).not.toContain(PAYLOAD.image);
    expect(body).not.toContain("image_url");
    expect(body).toContain(NOTE.image);
    expect(body).toContain("看看这张草图");
  });
});

/** A small deterministic PRNG, so a failing seed can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
