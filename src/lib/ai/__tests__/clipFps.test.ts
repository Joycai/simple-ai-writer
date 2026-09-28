/**
 * A clip's `fps` is this request's decision (docs/feature/video-input.md §4
 * 「片段的 fps 也按请求决定」).
 *
 * The history outlives the model: a clip attached under 智谱 (which ignores
 * the field) carries no `fps`; switch to a DashScope model that declares 0.5
 * and it must go out at 0.5 — not at the endpoint's ≈2, four times the bill —
 * and back without it. The plan decides (`RequestPlan.clipFps`), the request's
 * projection writes it onto a copy of every admitted clip, and the history is
 * never edited. The chip's estimate (`sentVideoFps`), the 将发送 line and the
 * request's own pre-flight estimate read the same frame rate.
 *
 * Everything here runs the real producers: the composer's `buildChatMessage`
 * builds the history as `agentStore` calls it (the attach-time
 * `sentVideoFps`), `connOptions()` builds the request, and the real
 * `streamCompletion` sends it with `fetch` stubbed to capture the body.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async () => "text body"),
  fileExists: vi.fn(async () => true),
}));

import { buildChatMessage } from "../../agent/chatRefs";
import { streamCompletion, type StreamMessage, type StreamOptions } from "../index";
import { connOptions, type ConnOptions } from "../conn";
import { planRequest } from "../capability/plan";
import { __resetLearned } from "../capability/learned";
import { PLATFORM_IDS, platformEndpoints } from "../platforms";
import { standardOf } from "../routes";
import { familyOf, ContextSizeError, type ContentPart } from "../types";
import { canReadVideo, estimateVideoTokens, sentVideoFps } from "../videoInput";
import { estimateMessagesTokens } from "../tokenEstimate";
import type { Model, ModelType, Provider } from "../configDb";
import type { AttachedItem } from "../../lore/aiTask";

const BASE_URL = "https://clip-fps.invalid/v1";
const ROUTES = PLATFORM_IDS.flatMap((platform) =>
  platformEndpoints(platform).map((e) => ({ platform, standard: standardOf({ family: e.family, official: !!e.official }) })),
);
// Weighted: the routes that read a clip — with the knob (百炼) and without it
// (智谱, 火山方舟 Coding Plan) — are a handful among dozens, and every outcome
// this test is about happens only on them.
const CLIP_ROUTES = ROUTES.filter(
  (r) => ["dashscope", "zhipu", "volcengine-plan"].includes(r.platform) && familyOf(r.standard) === "openai",
);
const TYPES: readonly ModelType[] = ["multimodal", "vision", "multimodal", "vision", "text"];
const MODEL_IDS = ["qwen3-vl-plus", "qwen3.8-flash", "glm-5v", "doubao-seed-2.0-mini"];
const FPS = [0.5, 1, 4] as const;
const SIZES = [[640, 480], [1280, 720], [320, 240]] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  __resetLearned();
});

/** Sends through the real `streamCompletion`; returns the body the adapter built, or the error it threw first. */
async function send(opts: Omit<StreamOptions, "onChunk">): Promise<{ body?: string; error?: unknown }> {
  let body: string | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    body = String(init.body);
    throw new Error("captured");
  }));
  try {
    await streamCompletion({ ...opts, onChunk: () => {} });
  } catch (e) {
    if (!(e instanceof Error && e.message === "captured")) return { error: e };
  }
  return { body };
}

/** The request's own pre-flight estimate, read off the refusal under a one-token author window. */
async function preflight(opts: Omit<StreamOptions, "onChunk">): Promise<number> {
  const { error } = await send({ ...opts, contextSize: 1, provenance: { contextSize: "author" } });
  expect(error).toBeInstanceOf(ContextSizeError);
  return (error as ContextSizeError).estimatedTokens;
}

/** A composer attachment, as `AgentChat` hands it over after reading the file. */
function clip(n: number, durationSec: number, [width, height]: readonly [number, number]): AttachedItem {
  return {
    kind: "video",
    file: { name: `c${n}.mp4`, path: `/proj/media/c${n}.mp4`, kind: "media" },
    dataUrl: `data:video/mp4;base64,Q0xJUC${n}AAA`,
    sizeBytes: 3, durationSec, width, height,
  } as unknown as AttachedItem;
}

interface Pair { model: Model; provider: Provider }

function drawPair(r: () => number): Pair {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const route = r() < 0.7 ? pick(CLIP_ROUTES) : pick(ROUTES);
  const provider: Provider = { id: "p", name: "p", baseUrl: BASE_URL, apiStandard: route.standard, platform: route.platform, createdAt: 0 };
  const model: Model = {
    id: "m", providerId: "p", modelId: pick(MODEL_IDS), name: "m", type: pick(TYPES),
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true,
    ...(r() < 0.8 ? { videoInput: true } : {}),
    ...(r() < 0.7 ? { videoFps: pick(FPS) } : {}),
  };
  return { model, provider };
}

/** The wire's clip parts, in order. Only Chat Completions spells one. */
function wireClips(body: string): ContentPart[] {
  const parsed = JSON.parse(body) as { messages?: { content?: unknown }[] };
  return (parsed.messages ?? []).flatMap((m) =>
    Array.isArray(m.content) ? (m.content as ContentPart[]).filter((p) => p.type === "video_url") : []);
}

/** `messages` with every clip part taken out — what the pre-flight counts without them. */
function withoutClips(messages: readonly StreamMessage[]): StreamMessage[] {
  return messages.map((m) => Array.isArray(m.content)
    ? ({ ...m, content: (m.content as ContentPart[]).filter((p) => p.type !== "video_url") } as StreamMessage)
    : m);
}

/**
 * A history built turn by turn by the composer, each turn attached under one
 * of two models (the author switched in between), then a request to a third
 * state — one of them again, or another.
 */
async function draw(seed: number) {
  const r = rng(seed);
  const attachers = [drawPair(r), drawPair(r)];
  const target = r() < 0.4 ? attachers[Math.floor(r() * 2)] : drawPair(r);
  const messages: StreamMessage[] = [];
  const clips: { durationSec: number; width: number; height: number }[] = [];
  const turns = 1 + Math.floor(r() * 3);
  for (let t = 0; t < turns; t++) {
    const { model, provider } = attachers[Math.floor(r() * 2)];
    const withClip = r() < 0.75;
    const durationSec = 2 + Math.floor(r() * 59);
    const size = SIZES[Math.floor(r() * SIZES.length)];
    const allowVideo = canReadVideo(model, provider);
    // As agentStore calls it.
    const built = await buildChatMessage(`w${seed}x${t}`, undefined, withClip ? [clip(seed * 10 + t, durationSec, size)] : [], {
      allowVideo, videoFps: sentVideoFps(model, provider),
    });
    messages.push({ role: "user", content: built.content });
    if (withClip && allowVideo) clips.push({ durationSec, width: size[0], height: size[1] });
    if (t < turns - 1) messages.push({ role: "assistant", content: `reply ${t}` });
  }
  // Mostly as the app builds a request; now and then a hand-built bag that
  // declares nothing — a probe, whose clips go out as it built them.
  const conn = connOptions({ ...target, apiKey: "k" });
  const handBuilt = r() < 0.15;
  const { modelType: _t, videoInput: _v, pdfInput: _p, videoFps: _f, ...bare } = conn;
  const transport: ConnOptions = handBuilt ? bare : conn;
  return { target, transport, handBuilt, messages, clips };
}

describe("a clip's fps on the wire", () => {
  it("is the request's answer — the chip's — whatever the clip was attached with; the history is never edited", async () => {
    const seen = { written: 0, stripped: 0, kept: 0, asBuilt: 0, estimated: 0 };
    for (let seed = 1; seed < 1500; seed++) {
      const { target, transport, handBuilt, messages, clips } = await draw(seed);
      const before = structuredClone(messages);
      const historyClips = messages.flatMap((m) =>
        Array.isArray(m.content) ? (m.content as ContentPart[]).filter((p) => p.type === "video_url") : []);
      const plan = planRequest({ ...transport, messages });
      const at = `seed ${seed}: ${transport.platform} ${transport.standard} ${target.model.type} ${target.model.modelId}`
        + ` fps=${target.model.videoFps} ${handBuilt ? "(bag)" : ""}`;

      const { body, error } = await send({ ...transport, messages });
      expect(error, at).toBeUndefined();
      expect(messages, `${at}: the history was edited`).toEqual(before);

      const onWire = wireClips(body!);
      expect(onWire.length, at).toBe(plan.media.video ? historyClips.length : 0);
      // What the composer's chip estimates at for this model — the author's answer.
      const chip = sentVideoFps(target.model, target.provider);
      onWire.forEach((part, i) => {
        const was = historyClips[i] as { fps?: number };
        const sent = (part as { fps?: number }).fps;
        if (handBuilt) {
          expect(sent, `${at}: clip ${i} as built`).toBe(was.fps);
          seen.asBuilt++;
          return;
        }
        expect(sent, `${at}: clip ${i}`).toBe(chip);
        if (sent === was.fps) seen.kept++;
        else if (sent === undefined) seen.stripped++;
        else seen.written++;
      });

      // The pre-flight counts each clip at the fps it goes out with.
      if (onWire.length) {
        const all = await preflight({ ...transport, messages });
        const bare = await preflight({ ...transport, messages: withoutClips(messages) });
        const expected = clips.reduce(
          (sum, c, i) => sum + estimateVideoTokens({ ...c, fps: (onWire[i] as { fps?: number }).fps })!, 0);
        expect(all - bare, `${at}: pre-flight`).toBe(expected);
        seen.estimated++;
      }
    }
    // Every outcome, often: a clip given the fps it lacked or a different one,
    // one stripped of an fps this route ignores, one already right, a probe's.
    expect(seen.written, "written").toBeGreaterThan(50);
    expect(seen.stripped, "stripped").toBeGreaterThan(50);
    expect(seen.kept, "kept").toBeGreaterThan(50);
    expect(seen.asBuilt, "as built").toBeGreaterThan(20);
    expect(seen.estimated, "estimated").toBeGreaterThan(200);
  });
});

describe("switching the model under a clip", () => {
  const zhipu: Provider = {
    id: "zhipu", name: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiStandard: "openai_compat", platform: "zhipu", createdAt: 0,
  };
  const bailian: Provider = {
    id: "bailian", name: "百炼", baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1", apiStandard: "openai_compat",
    platform: "dashscope", createdAt: 0,
  };
  const row = (providerId: string, modelId: string, videoFps?: number): Model => ({
    id: providerId, providerId, modelId, name: modelId, type: "vision",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, videoInput: true,
    ...(videoFps !== undefined ? { videoFps } : {}),
  });
  const glm = row("zhipu", "glm-5v", 0.5);
  const qwen = row("bailian", "qwen3-vl-plus", 0.5);
  /** A 60 s 720p clip: ≈35.6k at the default, ≈8.9k at 0.5. */
  async function historyFrom(model: Model, provider: Provider): Promise<StreamMessage[]> {
    const built = await buildChatMessage("这段视频里发生了什么？", undefined, [clip(1, 60, [1280, 720])], {
      allowVideo: canReadVideo(model, provider), videoFps: sentVideoFps(model, provider),
    });
    return [{ role: "user", content: built.content }, { role: "assistant", content: "一位旅人走进了灯塔。" }, { role: "user", content: "然后呢？" }];
  }
  const fpsOn = (body: string) => (wireClips(body)[0] as { fps?: number }).fps;

  it("a clip attached on 智谱 goes out at 百炼's 0.5, and back on 智谱 without it", async () => {
    const messages = await historyFrom(glm, zhipu);
    const before = structuredClone(messages);
    expect(fpsOn((await send({ ...connOptions({ model: glm, provider: zhipu, apiKey: "k" }), messages })).body!)).toBeUndefined();
    expect(fpsOn((await send({ ...connOptions({ model: qwen, provider: bailian, apiKey: "k" }), messages })).body!)).toBe(0.5);
    expect(fpsOn((await send({ ...connOptions({ model: glm, provider: zhipu, apiKey: "k" }), messages })).body!)).toBeUndefined();
    expect(messages).toEqual(before);
  });

  it("the author's window judges the clip at the fps it goes out with", async () => {
    // Between ≈8.9k and ≈35.6k: fits at 0.5, not at the default.
    const window = { contextSize: 20_000, provenance: { contextSize: "author" as const } };
    const fromZhipu = await historyFrom(glm, zhipu);
    expect((await send({ ...connOptions({ model: qwen, provider: bailian, apiKey: "k" }), ...window, messages: fromZhipu })).error).toBeUndefined();
    // Attached at 0.5, but 智谱 bills the default: refused before sending.
    const fromBailian = await historyFrom(qwen, bailian);
    expect(estimateMessagesTokens(fromBailian)).toBeLessThan(20_000);
    const onZhipu = await send({ ...connOptions({ model: glm, provider: zhipu, apiKey: "k" }), ...window, messages: fromBailian });
    expect(onZhipu.error).toBeInstanceOf(ContextSizeError);
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
