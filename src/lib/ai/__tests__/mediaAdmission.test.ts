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
import { canReadVideo } from "../videoInput";
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
  return { model, provider };
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

  it("a hand-built bag, which declares nothing, sends what the protocol can spell — a probe measures the platform, not the table", () => {
    for (let seed = 1; seed < 1500; seed++) {
      const { model, provider } = draw(seed);
      const { modelType: _t, videoInput: _v, pdfInput: _p, ...bag } = connOptions({ model, provider, apiKey: "k" });
      const family = familyOf(bag.standard);
      expect(planRequest(bag).media, `seed ${seed}`).toEqual({
        image: true,
        video: family === "openai",
        pdf: family !== "dashscope",
      });
    }
  });

  it("no platform cell admits a kind the route's adapter cannot spell", () => {
    // Otherwise the cell would be silently overruled by the protocol layer.
    for (const platform of PLATFORM_IDS) for (const e of platformEndpoints(platform)) {
      const wire = { platform, standard: standardOf({ family: e.family, official: !!e.official }) };
      const spelled = spelledMedia(wire);
      for (const modelId of MODEL_IDS) {
        const at = `${platform} ${e.family} ${modelId}`;
        if (hasCapability("videoInput", wire, { modelId, type: "multimodal" })) expect(spelled.video, at).toBe(true);
        if (hasCapability("pdfInput", wire, { modelId })) expect(spelled.pdf, at).toBe(true);
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
    await streamCompletion({ ...connOptions({ model, provider, apiKey: "k" }), messages: [{ role: "user", content: "hi" }], onChunk: () => {} })
      .catch(() => {});
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
