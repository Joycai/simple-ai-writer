/**
 * Value facts and their sources (docs/api/capability-resolution-lld.md §3.3,
 * §3.9, P6): the thinking category, the output cap and the context window a
 * row leaves unset are answered by the tables, each answer says where it came
 * from, and each consumer acts only on the sources it trusts.
 *
 * Held here, all through the real producers (`connOptions`, `planRequest`,
 * `streamCompletion`):
 *
 *   - the order — author, platform row, catalog, family default, app default;
 *   - a blank row resolves to exactly what the drawer would have prefilled, so
 *     a row saved before a platform's rows existed behaves like a new one (D1);
 *   - the Anthropic `max_tokens` sends the author's cap and nothing else (B1,
 *     D2), while the planner takes every source;
 *   - the pre-send window gate refuses only against the author's window.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => ({ appDefaultMaxOutput: "" }));
vi.mock("../../prefs", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../prefs")>();
  return {
    ...real,
    readPref: (key: string) => (key === "app:defaultMaxOutput" ? prefs.appDefaultMaxOutput || null : real.readPref(key)),
  };
});

import { modelValue, PLATFORM_CELLS, platformModelCalibration, thinkingCategoryOf } from "../capabilities";
import { planRequest } from "../capability/plan";
import type { Model, Provider } from "../configDb";
import { connOptions, plannedLimits } from "../conn";
import { streamCompletion } from "../index";
import { PLATFORM_IDS, platformEndpoints, platformOrigin, type PlatformId } from "../platforms";
import { fitsFamily, THINKING_CATEGORIES } from "../reasoning";
import { routeProvider, standardOf, type Endpoint } from "../routes";
import { ContextSizeError, type ProtocolFamily, type StreamOptions } from "../types";

afterEach(() => {
  prefs.appDefaultMaxOutput = "";
  vi.unstubAllGlobals();
});

function channelOf(platform: PlatformId): Provider {
  const origin = platformOrigin(platform) || "https://relay.example.invalid";
  const endpoints: Endpoint[] = platformEndpoints(platform).map((e) => ({
    family: e.family, official: e.official === true, ...(e.authMode ? { authMode: e.authMode } : {}),
  }));
  return {
    id: "p", name: platform, baseUrl: origin, host: origin, apiStandard: standardOf(endpoints[0]),
    platform, endpoints, createdAt: 0,
  };
}

function modelOf(modelId: string, extra: Partial<Model> = {}): Model {
  return {
    id: "m", providerId: "p", modelId, name: modelId, type: "text",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, ...extra,
  };
}

/** The channel as a request on `family` sees it. */
function routeOf(platform: PlatformId, family: ProtocolFamily): Provider {
  const provider = routeProvider(channelOf(platform), family);
  if (!provider) throw new Error(`${platform} has no ${family} route`);
  return provider;
}

/** The body `streamCompletion` would POST for this row. */
async function bodyOf(opts: StreamOptions): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    throw new Error("captured");
  }));
  await streamCompletion(opts).catch(() => {});
  return body;
}

const request = (provider: Provider, model: Model): StreamOptions => ({
  ...connOptions({ provider, model, apiKey: "k" }),
  messages: [{ role: "user", content: "hi" }], onChunk: () => {},
});

describe("the chain", () => {
  it("answers a cap from the author, then the platform's row, the catalog, the app default", () => {
    const zhipu = { standard: "openai_compat" as const, platform: "zhipu" as const };
    prefs.appDefaultMaxOutput = "50000";
    expect(modelValue("maxOutput", { modelId: "glm-5.3", maxOutput: 4000 }, zhipu)).toEqual({ value: 4000, source: "author" });
    expect(modelValue("maxOutput", { modelId: "glm-4.5-air" }, zhipu)).toEqual({ value: 98_304, source: "platform" });
    // No zhipu row for it: the catalog's documented cap.
    expect(modelValue("maxOutput", { modelId: "gpt-4o" }, zhipu)).toEqual({ value: 16_384, source: "catalog" });
    expect(modelValue("maxOutput", { modelId: "mystery-model" }, zhipu)).toEqual({ value: 50_000, source: "default" });
    prefs.appDefaultMaxOutput = "";
    // Not 0: undefined is "no cap known", and each protocol then does its own thing.
    expect(modelValue("maxOutput", { modelId: "mystery-model" }, zhipu)).toBeUndefined();
  });

  it("knows a window only from the author or a platform's row — no catalog row, no app default", () => {
    const zhipu = { standard: "openai_compat" as const, platform: "zhipu" as const };
    expect(modelValue("contextSize", { modelId: "glm-5.3" }, zhipu)?.source).toBe("platform");
    expect(modelValue("contextSize", { modelId: "glm-5.3" }, { standard: "openai_compat" })).toBeUndefined();
  });

  it("answers a category from the author, a legacy dialect, the platform's row, the family default", () => {
    const at = { standard: "openai_compat" as const, platform: "zhipu" as const };
    expect(thinkingCategoryOf({ thinkingCategory: "deepseek", modelId: "glm-5.3" }, at))
      .toEqual({ value: THINKING_CATEGORIES.deepseek, source: "author" });
    expect(thinkingCategoryOf({ thinkingDialect: "switch", modelId: "glm-5.3" }, at).source).toBe("author");
    expect(thinkingCategoryOf({ modelId: "glm-5.3" }, at)).toEqual({ value: THINKING_CATEGORIES.glm, source: "platform" });
    expect(thinkingCategoryOf({ modelId: "mystery-model" }, at))
      .toEqual({ value: THINKING_CATEGORIES["openai-generic"], source: "protocol" });
  });

  it("never takes a platform's category the route cannot spell", () => {
    // 火山方舟 Plan: `doubao` is written for every route, `doubao-switch` for the Messages one.
    const id = "doubao-seed-2.1-turbo";
    expect(thinkingCategoryOf({ modelId: id }, { standard: "openai_compat", platform: "volcengine-plan" }).value.id).toBe("doubao");
    expect(thinkingCategoryOf({ modelId: id }, { standard: "anthropic_compat", platform: "volcengine-plan" }).value.id).toBe("doubao-switch");
    expect(thinkingCategoryOf({ modelId: id }, { standard: "openai_responses_compat", platform: "volcengine-plan" }))
      .toEqual({ value: THINKING_CATEGORIES["responses-effort"], source: "protocol" });
  });
});

/**
 * D1's promise: a row the author left blank acts exactly like one the drawer
 * prefilled. Every exact-id row of every platform, on every route the
 * platform serves.
 */
describe("a blank row and a prefilled one", () => {
  const ids = (platform: PlatformId): string[] => Object.values(PLATFORM_CELLS[platform]?.families ?? {})
    .flatMap((block) => block?.models ?? [])
    .flatMap((row) => ("eq" in row.match ? [row.match.eq] : []));

  it("resolve to the same values", () => {
    const differ: string[] = [];
    for (const platform of PLATFORM_IDS) for (const endpoint of platformEndpoints(platform)) {
      const provider = routeOf(platform, endpoint.family);
      for (const id of ids(platform)) {
        const cal = { ...platformModelCalibration(platform, id), ...platformModelCalibration(platform, id, endpoint.family) };
        const category = cal.thinkingCategory && fitsFamily(THINKING_CATEGORIES[cal.thinkingCategory], endpoint.family)
          ? cal.thinkingCategory : undefined;
        const prefilled = connOptions({
          provider, apiKey: "k",
          model: modelOf(id, { thinkingCategory: category, contextSize: cal.contextSize, maxOutput: cal.maxOutput }),
        });
        const blank = connOptions({ provider, apiKey: "k", model: modelOf(id) });
        for (const k of ["thinkingCategory", "contextSize", "maxOutput"] as const) {
          if (prefilled[k] !== undefined && blank[k] !== prefilled[k]) {
            differ.push(`${platform}/${endpoint.family}/${id} ${k}: blank ${blank[k]}, prefilled ${prefilled[k]}`);
          }
        }
      }
    }
    expect(differ).toEqual([]);
  });
});

describe("who trusts what", () => {
  it("sends the author's cap as max_tokens, and neither a table's nor the app default (B1)", async () => {
    const anthropic = routeOf("anthropic", "anthropic");
    prefs.appDefaultMaxOutput = "64000";
    expect((await bodyOf(request(anthropic, modelOf("claude-sonnet-5", { maxOutput: 20_000 })))).max_tokens).toBe(20_000);
    const unset = request(anthropic, modelOf("claude-sonnet-5"));
    expect(unset.maxOutput).toBe(64_000);
    expect((await bodyOf(unset)).max_tokens).toBe(32_768);
    // A catalog cap on a non-Claude id behind a Messages route (DeepSeek's).
    const ds = request(routeOf("deepseek", "anthropic"), modelOf("deepseek-v4-pro"));
    expect(ds.provenance?.maxOutput).toBe("platform");
    expect((await bodyOf(ds)).max_tokens).toBe(32_768);
  });

  it("plans with every source, and plans what the request carries", () => {
    const provider = routeOf("zhipu", "openai");
    const model = modelOf("glm-5.3");
    const conn = connOptions({ provider, model, apiKey: "k" });
    expect(plannedLimits({ model, provider })).toEqual({ contextSize: conn.contextSize, maxOutput: conn.maxOutput });
    expect(conn.provenance).toEqual({ contextSize: "platform", maxOutput: "platform" });
  });

  it("refuses a prompt before sending only against the author's window", async () => {
    const opts: StreamOptions = {
      standard: "openai_compat", baseUrl: "https://x.invalid/v1", apiKey: "k", modelId: "m", contextSize: 10,
      messages: [{ role: "user", content: "a prompt comfortably longer than ten tokens, many times over and then some" }],
      onChunk: () => {},
    };
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("sent"); }));
    await expect(streamCompletion(opts)).rejects.toBeInstanceOf(ContextSizeError);
    await expect(streamCompletion({ ...opts, provenance: { contextSize: "platform" } })).rejects.toThrow("sent");
  });

  it("is what the plan reads — a hand-built bag's own cap is the caller's", () => {
    const base = { standard: "anthropic" as const, baseUrl: "", modelId: "claude-sonnet-5" };
    expect(planRequest({ ...base, maxOutput: 9000 }).maxTokensOnWire).toBe(9000);
    expect(planRequest({ ...base, maxOutput: 9000, provenance: { maxOutput: "catalog" } }).maxTokensOnWire).toBe(32_768);
  });
});
