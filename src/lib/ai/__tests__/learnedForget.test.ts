/**
 * The author's acts that retire what an endpoint taught (LLD §9.13). The key a
 * ceiling sits under is taken from `connOptions` — what requests actually go
 * out under — so the test fails if the two ever stop agreeing. Held: a changed
 * structured-output declaration forgets that route's structured-output
 * ceiling and nothing else; an unchanged one, or a save that switched route,
 * forgets nothing; a probe forgets every fact on the route probed, and only
 * there.
 */
import { afterEach, describe, expect, it } from "vitest";
import { __resetLearned, learnedCeiling, noteLearned } from "../capability/learned";
import type { Model, Provider } from "../configDb";
import { connOptions } from "../conn";
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

afterEach(() => __resetLearned());

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
  it("forgets every fact on the probed route, and only there", () => {
    const onChat = keyOf(model);
    const onMessages = keyOf({ ...model, activeRoute: "anthropic" });
    noteLearned(onChat, "structuredOutput", "off");
    noteLearned(onChat, "forcedToolChoice", false);
    noteLearned(onMessages, "forcedToolChoice", false);

    forgetOnProbe(routeProvider(channel, "openai")!, model.modelId);

    expect(learnedCeiling(onChat, "structuredOutput")).toBeUndefined();
    expect(learnedCeiling(onChat, "forcedToolChoice")).toBeUndefined();
    expect(learnedCeiling(onMessages, "forcedToolChoice")).toBe(false);
  });
});
