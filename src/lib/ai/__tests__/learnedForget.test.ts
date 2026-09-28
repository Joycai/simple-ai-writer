/**
 * The author's acts that retire what an endpoint taught (LLD §9.13). The key a
 * ceiling sits under is taken from `connOptions` — what requests actually go
 * out under — so the test fails if the two ever stop agreeing. Held: a changed
 * structured-output declaration forgets that route's structured-output
 * ceiling and nothing else; an unchanged one, or a save that switched route,
 * forgets nothing; a probe that reached the endpoint forgets every fact on the
 * route probed, and only there — a cancelled or unanswered one forgets nothing.
 * The probe reports are the real `probeEndpoint`'s, over a stubbed `fetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The probe sends through the app's own fetch wrapper; route it to the stub.
vi.mock("../../http", () => ({
  fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  isLocalUrl: () => false,
}));
import { __resetLearned, learnedCeiling, noteLearned } from "../capability/learned";
import type { Model, Provider } from "../configDb";
import { connOptions } from "../conn";
import { probeEndpoint } from "../endpointProbe";
import { forgetOnDeclarationChange, forgetOnProbe } from "../learnedForget";
import { routeProvider, switchModelRoute } from "../routes";

const channel: Provider = {
  id: "p1", name: "Relay", baseUrl: "https://relay.example/v1", apiStandard: "openai_compat", platform: "newapi",
  host: "https://relay.example",
  endpoints: [{ family: "openai", official: false }, { family: "anthropic", official: false }],
  createdAt: 0,
};
const model: Model = {
  id: "m1", providerId: "p1", modelId: "qwen3.8-max", name: "Q", type: "text",
  priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, structuredOutput: "json_schema",
};

/** The key a request from this row goes out under, as the request builds it. */
const keyOf = (m: Model) => {
  const route = routeProvider(channel, m.activeRoute)!;
  const c = connOptions({ provider: route, model: m, apiKey: "k" });
  return { standard: c.standard, baseUrl: c.baseUrl, modelId: c.modelId };
};

afterEach(() => {
  __resetLearned();
  vi.unstubAllGlobals();
});

/** An endpoint that answers every completion, counting a token per four characters sent. */
function answering() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    const sent = String(init?.body ?? "").length;
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: Math.ceil(sent / 4), completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }));
}
const probe = (signal?: AbortSignal) => {
  const route = routeProvider(channel, "openai")!;
  return probeEndpoint({ baseUrl: route.baseUrl, apiKey: "k", standard: route.apiStandard, modelId: model.modelId, signal });
};

describe("forgetOnDeclarationChange", () => {
  it("forgets the route's structured-output ceiling when the declaration changes, and nothing else", () => {
    const onChat = keyOf(model);
    const onMessages = keyOf({ ...model, activeRoute: "anthropic" });
    noteLearned(onChat, "structuredOutput", "json_object");
    noteLearned(onChat, "forcedToolChoice", false);
    noteLearned(onMessages, "structuredOutput", "off");

    forgetOnDeclarationChange(model, { ...model, structuredOutput: "json_object" }, [channel]);

    expect(learnedCeiling(onChat, "structuredOutput")).toBeUndefined();
    expect(learnedCeiling(onChat, "forcedToolChoice")).toBe(false);
    expect(learnedCeiling(onMessages, "structuredOutput")).toBe("off");
  });

  it("counts clearing the declaration back to auto as a change", () => {
    noteLearned(keyOf(model), "structuredOutput", "json_object");
    forgetOnDeclarationChange(model, { ...model, structuredOutput: undefined }, [channel]);
    expect(learnedCeiling(keyOf(model), "structuredOutput")).toBeUndefined();
  });

  it("forgets nothing when the declaration is unchanged, or the save switched route", () => {
    noteLearned(keyOf(model), "structuredOutput", "json_object");
    forgetOnDeclarationChange(model, { ...model, name: "renamed" }, [channel]);
    expect(learnedCeiling(keyOf(model), "structuredOutput")).toBe("json_object");

    // Switching loads the other route's parked declaration — not one the author just wrote.
    const parked = { ...model, routes: { anthropic: { structuredOutput: "off" as const } } };
    const switched = switchModelRoute(parked, channel, "anthropic");
    noteLearned(keyOf(switched), "structuredOutput", "json_object");
    forgetOnDeclarationChange(parked, switched, [channel]);
    expect(learnedCeiling(keyOf(switched), "structuredOutput")).toBe("json_object");
    expect(learnedCeiling(keyOf(model), "structuredOutput")).toBe("json_object");
  });
});

describe("forgetOnProbe", () => {
  const onChat = () => keyOf(model);
  const onMessages = () => keyOf({ ...model, activeRoute: "anthropic" });
  const learnAll = () => {
    noteLearned(onChat(), "structuredOutput", "off");
    noteLearned(onChat(), "forcedToolChoice", false);
    noteLearned(onMessages(), "forcedToolChoice", false);
  };

  it("forgets every fact on the probed route once the endpoint answered, and only there", async () => {
    learnAll();
    answering();
    forgetOnProbe(routeProvider(channel, "openai")!, model.modelId, await probe());

    expect(learnedCeiling(onChat(), "structuredOutput")).toBeUndefined();
    expect(learnedCeiling(onChat(), "forcedToolChoice")).toBeUndefined();
    expect(learnedCeiling(onMessages(), "forcedToolChoice")).toBe(false);
  });

  it("forgets nothing when the endpoint refused every request", async () => {
    learnAll();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid api key", { status: 401 })));
    forgetOnProbe(routeProvider(channel, "openai")!, model.modelId, await probe());
    expect(learnedCeiling(onChat(), "structuredOutput")).toBe("off");
  });

  it("forgets nothing when the author cancelled the probe", async () => {
    learnAll();
    answering();
    const ctrl = new AbortController();
    ctrl.abort();
    forgetOnProbe(routeProvider(channel, "openai")!, model.modelId, await probe(ctrl.signal));
    expect(learnedCeiling(onChat(), "structuredOutput")).toBe("off");
  });
});
