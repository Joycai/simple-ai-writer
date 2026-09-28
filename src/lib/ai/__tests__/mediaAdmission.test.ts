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
import { describe, expect, it } from "vitest";
import { admittedMediaOf, connOptions } from "../conn";
import { canSeeImages, readsPdf, type Model, type ModelType, type Provider } from "../configDb";
import { canReadVideo } from "../videoInput";
import { planRequest } from "../capability/plan";
import { hasCapability } from "../capabilities";
import { PLATFORM_IDS, platformEndpoints, wireOf } from "../platforms";
import { standardOf } from "../routes";
import { RELAY_UPSTREAMS, capabilityModelOf, type RelayUpstreamChoice } from "../relayUpstream";

const BASE_URL = "https://media-admission.invalid/v1";
const TYPES: readonly ModelType[] = ["multimodal", "vision", "text", "multimodal", "vision", "image", "video", "asr"];
const MODEL_IDS = ["qwen3.8-flash", "qwen3-vl-plus", "no-such-model", "[特价kiro量]claude-opus-5", "[x]claude-opus-4-6", "[x]gpt-5.6-sol"];
const CHOICES: readonly (RelayUpstreamChoice | undefined)[] = [undefined, "none", ...RELAY_UPSTREAMS];

const ROUTES = PLATFORM_IDS.flatMap((platform) =>
  platformEndpoints(platform).map((e) => ({ platform, standard: standardOf({ family: e.family, official: !!e.official }) })),
);

function draw(seed: number): { model: Model; provider: Provider } {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const route = pick(ROUTES);
  const provider: Provider = {
    id: "p", name: "p", baseUrl: BASE_URL, apiStandard: route.standard, platform: route.platform, createdAt: 0,
    ...(r() < 0.3 ? { upstreamPrefixes: [{ prefix: "[x]", upstream: pick(RELAY_UPSTREAMS) }] } : {}),
  };
  const relayUpstream = pick(CHOICES);
  const model: Model = {
    id: "m", providerId: "p", modelId: pick(MODEL_IDS), name: "m", type: pick(TYPES),
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
    for (let seed = 1; seed < 1500; seed++) {
      const { model, provider } = draw(seed);
      const admitted = admittedMediaOf(model, provider);
      const planned = planRequest(connOptions({ model, provider, apiKey: "k" })).media;
      const at = `seed ${seed}: ${provider.platform} ${provider.apiStandard} ${model.type} ${model.modelId}`;

      expect(planned, at).toEqual(admitted);
      expect(canReadVideo(model, provider), at).toBe(admitted.video);
      expect(readsPdf(model, provider), at).toBe(admitted.pdf);

      // The model half: its type, and its declarations, bound every kind.
      expect(admitted.image, at).toBe(canSeeImages(model));
      if (admitted.video) expect(!!model.videoInput && canSeeImages(model), at).toBe(true);
      if (admitted.pdf) expect(!!model.pdfInput, at).toBe(true);

      for (const k of ["video", "pdf", "image"] as const) seen[k].add(admitted[k]);
    }
    // The walk reached both answers for every kind.
    expect([...seen.video].sort()).toEqual([false, true]);
    expect([...seen.pdf].sort()).toEqual([false, true]);
    expect([...seen.image].sort()).toEqual([false, true]);
  });

  it("a hand-built bag, which declares nothing, is bound by the route alone", () => {
    for (let seed = 1; seed < 400; seed++) {
      const { model, provider } = draw(seed);
      const { modelType: _t, videoInput: _v, pdfInput: _p, ...bag } = connOptions({ model, provider, apiKey: "k" });
      const plan = planRequest(bag);
      const wire = wireOf(bag);
      const untyped = capabilityModelOf(bag);
      expect(plan.media, `seed ${seed}`).toEqual({
        image: true,
        video: hasCapability("videoInput", wire, untyped),
        pdf: hasCapability("pdfInput", wire, untyped),
      });
    }
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
