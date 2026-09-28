/**
 * Media admission has one answer (capability/media.ts): the request plan's
 * `media`, the composer's attach gates (`canReadVideo`, `readsPdf`) and
 * `admittedMediaOf` must agree for every model on every route — otherwise a
 * part can be attached where it will not go out, or go out where it could not
 * have been attached.
 *
 * A random walk over every platform's routes, model types, declarations, ids
 * and relay upstreams (from the model row and from the channel's prefix
 * table), each asked through the real producers: `connOptions()` →
 * `planRequest`, and the gates as the app calls them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamCompletion } from "../index";
import { wireSummary } from "../modelSummary";
import { admittedMediaOf, connOptions } from "../conn";
import { readsPdf, type Model, type ModelType, type Provider } from "../configDb";
import { canReadVideo, sentVideoFps } from "../videoInput";
import { planRequest } from "../capability/plan";
import { hasCapability } from "../capabilities";
import { PLATFORM_IDS, platformEndpoints, providerWire } from "../platforms";
import { spelledMedia } from "../capability/media";
import { familyOf } from "../types";
import { standardOf } from "../routes";
import { RELAY_UPSTREAMS, capabilityModelOf, isRelayPlatform, relayUpstreamFor, type RelayUpstreamChoice } from "../relayUpstream";

const BASE_URL = "https://media-admission.invalid/v1";
const TYPES: readonly ModelType[] = ["multimodal", "vision", "text", "multimodal", "vision", "image", "video", "asr"];
const MODEL_IDS = ["qwen3.8-flash", "qwen3-vl-plus", "no-such-model", "[特价kiro量]claude-opus-5", "[x]claude-opus-4-6", "[x]gpt-5.6-sol"];
const CHOICES: readonly (RelayUpstreamChoice | undefined)[] = [undefined, "none", ...RELAY_UPSTREAMS];

const ROUTES = PLATFORM_IDS.flatMap((platform) =>
  platformEndpoints(platform).map((e) => ({ platform, standard: standardOf({ family: e.family, official: !!e.official }) })),
);
// Weighted: the upstream cells (a relay's Claude dropping a `file` part) are
// the corner a uniform walk reaches once in a thousand draws.
const RELAY_ROUTES = ROUTES.filter((r) => isRelayPlatform(r.platform));
const RELAY_IDS = ["[x]claude-opus-4-6", "[x]gpt-5.6-sol", "[特价kiro量]claude-opus-5"];

function draw(seed: number): { model: Model; provider: Provider } {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const relay = r() < 0.4;
  const route = pick(relay ? RELAY_ROUTES : ROUTES);
  const provider: Provider = {
    id: "p", name: "p", baseUrl: BASE_URL, apiStandard: route.standard, platform: route.platform, createdAt: 0,
    ...(r() < (relay ? 0.6 : 0.3) ? { upstreamPrefixes: [{ prefix: "[x]", upstream: pick(RELAY_UPSTREAMS) }] } : {}),
  };
  const relayUpstream = pick(CHOICES);
  const model: Model = {
    id: "m", providerId: "p", modelId: pick(relay ? RELAY_IDS : MODEL_IDS), name: "m", type: pick(TYPES),
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true,
    ...(r() < 0.7 ? { videoInput: true } : {}),
    ...(r() < 0.7 ? { pdfInput: true } : {}),
    ...(relayUpstream ? { relayUpstream } : {}),
  };
  // Last, so the draws above stay what they were for every seed.
  const fps = r() < 0.6 ? pick([0.5, 1, 4] as const) : undefined;
  return { model: fps === undefined ? model : { ...model, videoFps: fps }, provider };
}

// Weighted for the fps walk: the routes that read a clip — with and without
// the knob — are a handful among dozens, and the interesting cells are there.
const CLIP_ROUTES = ROUTES.filter((r) => ["dashscope", "zhipu", "volcengine-plan"].includes(r.platform) && familyOf(r.standard) === "openai");

function drawClip(seed: number): { model: Model; provider: Provider } {
  const drawn = draw(seed);
  const r = rng(seed * 7919);
  if (r() < 0.5) return drawn;
  const route = CLIP_ROUTES[Math.floor(r() * CLIP_ROUTES.length)];
  const type = r() < 0.8 ? (r() < 0.5 ? "multimodal" : "vision") : drawn.model.type;
  return { model: { ...drawn.model, type }, provider: { ...drawn.provider, apiStandard: route.standard, platform: route.platform } };
}

describe("media admission", () => {
  it("the plan, admittedMediaOf and the attach gates give one answer", () => {
    const seen = { video: new Set<boolean>(), pdf: new Set<boolean>(), image: new Set<boolean>() };
    let upstreamRefusals = 0;
    for (let seed = 1; seed < 1500; seed++) {
      const { model, provider } = draw(seed);
      const admitted = admittedMediaOf(model, provider);
      const planned = planRequest(connOptions({ model, provider, apiKey: "k" })).media;
      const at = `seed ${seed}: ${provider.platform} ${provider.apiStandard} ${model.type} ${model.modelId}`;

      expect(planned, at).toEqual(admitted);
      expect(canReadVideo(model, provider), at).toBe(admitted.video);
      expect(readsPdf(model, provider), at).toBe(admitted.pdf);

      // An independent reading of the table, as the attach gates asked it
      // before they read the plan: the declaration, then the route's cell for
      // this id behind this upstream (the type, for the video rule's
      // `modelTypes`). Nothing above is compared with this but the result.
      const wire = providerWire(provider);
      const asked = { ...capabilityModelOf({ modelId: model.modelId, relayUpstream: relayUpstreamFor(wire.platform, model, provider) }), type: model.type };
      expect(admitted, at).toEqual({
        image: model.type === "multimodal" || model.type === "vision",
        video: !!model.videoInput && hasCapability("videoInput", wire, asked),
        pdf: !!model.pdfInput && hasCapability("pdfInput", wire, asked),
      });
      // The video gate before it read the plan asked only the type — no id,
      // no upstream. No cell keys `videoInput` on either today, so it agrees;
      // the day one does, this line says the two answers parted on purpose.
      expect(admitted.video, at).toBe(!!model.videoInput && hasCapability("videoInput", wire, { type: model.type }));

      for (const k of ["video", "pdf", "image"] as const) seen[k].add(admitted[k]);
      if (model.pdfInput && !admitted.pdf && hasCapability("pdfInput", wire, { modelId: model.modelId })) upstreamRefusals++;
    }
    // The walk reached both answers for every kind, and the upstream corner.
    expect(upstreamRefusals, "a relay upstream refusing a PDF").toBeGreaterThan(10);
    expect([...seen.video].sort()).toEqual([false, true]);
    expect([...seen.pdf].sort()).toEqual([false, true]);
    expect([...seen.image].sort()).toEqual([false, true]);
  });

  it("the clip's fps: the plan, sentVideoFps and the 将发送 line give one answer", () => {
    const seen = { set: 0, declaredButNone: 0 };
    for (let seed = 1; seed < 1500; seed++) {
      const { model, provider } = drawClip(seed);
      const conn = connOptions({ model, provider, apiKey: "k" });
      const planned = planRequest(conn).clipFps;
      const at = `seed ${seed}: ${provider.platform} ${provider.apiStandard} ${model.type} ${model.modelId} fps=${model.videoFps}`;

      // A row always declares, so the plan never leaves a clip as built.
      expect(planned, at).not.toBe("as-built");
      const fps = typeof planned === "number" ? planned : undefined;
      expect(sentVideoFps(model, provider), at).toBe(fps);
      const line = wireSummary(model, provider.apiStandard, provider.baseUrl, provider.platform, conn.relayUpstream, conn.canonicalModelId)
        .find((i) => i.key === "video_url.fps");
      expect(line?.value, at).toBe(fps === undefined ? undefined : String(fps));

      // Independently: the declared value, where a clip is admitted and the
      // route reads the knob for this model.
      const wire = providerWire(provider);
      const asked = { ...capabilityModelOf({ modelId: model.modelId, relayUpstream: conn.relayUpstream }), type: model.type };
      const expected = model.videoFps !== undefined && canReadVideo(model, provider) && hasCapability("videoFps", wire, asked)
        ? model.videoFps : undefined;
      expect(fps, at).toBe(expected);

      if (fps !== undefined) seen.set++;
      else if (model.videoFps !== undefined && canReadVideo(model, provider)) seen.declaredButNone++;
    }
    // Both outcomes for a clip that goes out: its fps written, and withheld
    // (智谱, 火山方舟 Coding Plan read the clip but not the knob).
    expect(seen.set).toBeGreaterThan(50);
    expect(seen.declaredButNone).toBeGreaterThan(50);
  });

  it("a hand-built bag, which declares nothing, sends what the protocol can spell — a probe measures the platform, not the table", () => {
    for (let seed = 1; seed < 1500; seed++) {
      const { model, provider } = draw(seed);
      const { modelType: _t, videoInput: _v, pdfInput: _p, videoFps: _f, ...bag } = connOptions({ model, provider, apiKey: "k" });
      const family = familyOf(bag.standard);
      const plan = planRequest(bag);
      expect(plan.media, `seed ${seed}`).toEqual({
        image: true,
        video: family === "openai",
        pdf: family !== "dashscope",
      });
      // …and its clips as it built them: a probe measuring whether a platform
      // reads `fps` must be able to send one the table does not list.
      expect(plan.clipFps, `seed ${seed}`).toBe("as-built");
    }
  });

  it("no platform cell admits a kind the route's adapter cannot spell", () => {
    // Otherwise the cell would be silently overruled by the protocol layer.
    for (const platform of PLATFORM_IDS) for (const e of platformEndpoints(platform)) {
      const wire = { platform, standard: standardOf({ family: e.family, official: !!e.official }) };
      const spelled = spelledMedia(wire);
      for (const modelId of [...MODEL_IDS, ...RELAY_IDS]) for (const relayUpstream of CHOICES) {
        // Through the upstream cells too, as a request asks them.
        const asked = capabilityModelOf({ modelId, relayUpstream });
        const at = `${platform} ${e.family} ${modelId} ${relayUpstream ?? "(inferred)"}`;
        if (hasCapability("videoInput", wire, { ...asked, type: "multimodal" })) expect(spelled.video, at).toBe(true);
        if (hasCapability("pdfInput", wire, asked)) expect(spelled.pdf, at).toBe(true);
      }
    }
  });
});

describe("the plan carries the model's type", () => {
  // The one request this changes on the wire (B17): a row that does not see,
  // still holding `vlHighResolution`, stops sending DashScope's hi-res knob —
  // the rule's `modelTypes` was always there, the plan just could not ask it.
  afterEach(() => vi.unstubAllGlobals());
  const provider: Provider = {
    id: "bailian", name: "百炼", baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1",
    apiStandard: "openai_compat", platform: "dashscope", createdAt: 0,
  };
  const row = (type: ModelType): Model => ({
    id: "m", providerId: "bailian", modelId: "qwen3.8-flash", name: "m", type,
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, vlHighResolution: true,
  });
  async function body(model: Model): Promise<string> {
    let sent = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      throw new Error("captured");
    }));
    // Only the stub's own error is expected: anything thrown before fetch
    // would leave `sent` empty and make the "not sent" assertion vacuous.
    await expect(
      streamCompletion({ ...connOptions({ model, provider, apiKey: "k" }), messages: [{ role: "user", content: "hi" }], onChunk: () => {} }),
    ).rejects.toThrow("captured");
    expect(sent).toContain('"model":"qwen3.8-flash"');
    return sent;
  }
  const summarises = (model: Model) =>
    wireSummary(model, provider.apiStandard, provider.baseUrl, provider.platform).some((i) => i.key === "vl_high_resolution_images");

  it("sends vl_high_resolution_images for a model that sees, and not for one that does not", async () => {
    expect(await body(row("multimodal"))).toContain('"vl_high_resolution_images":true');
    expect(summarises(row("multimodal"))).toBe(true);
    expect(await body(row("text"))).not.toContain("vl_high_resolution_images");
    expect(summarises(row("text"))).toBe(false);
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
