/**
 * The seam these tests guard is `docs/provider-layering.md` §6 偏离一: the L2×L3
 * → request flattening used to be hand-written at sixteen call sites, and every
 * field involved is optional — so a forgotten one is not a type error, it is a
 * silent behaviour difference on one screen.
 *
 * Centralising it into `connOptions` fixes fifteen of those, but leaves one
 * hand-written field list beside another: `connOptions` builds the object and
 * `pickConnOptions` narrows it back down. TypeScript cannot catch a mismatch
 * between them, because an omitted *optional* field type-checks fine. That is
 * what the round-trip test below is for.
 */

import { describe, expect, it } from "vitest";
import { connOptions, pickConnOptions, resolveConn, type AiConn } from "../ai/conn";
import type { Model, Provider } from "../ai/configDb";

const provider: Provider = {
  id: "p1",
  name: "Relay",
  baseUrl: "https://relay.example/v1",
  apiStandard: "openai_compat",
  safetySettings: { harassment: "BLOCK_NONE" } as Provider["safetySettings"],
  authMode: "bearer",
  createdAt: 0,
};

const model: Model = {
  id: "m1",
  providerId: "p1",
  modelId: "some-model",
  name: "Some Model",
  type: "text",
  priceIn: 1,
  priceCachedIn: 0.1,
  priceOut: 2,
  enabled: true,
  prefix: "always answer in Chinese",
  contextSize: 128_000,
  maxOutput: 8_192,
  reasoningEffort: "high",
  thinkingDialect: "adaptive",
  serverTools: ["web_search"],
};

const conn: AiConn = { provider, model, apiKey: "sk-test" };

describe("connOptions", () => {
  it("carries every configured field from both layers", () => {
    expect(connOptions(conn)).toEqual({
      baseUrl: "https://relay.example/v1",
      apiKey: "sk-test",
      standard: "openai_compat",
      safetySettings: { harassment: "BLOCK_NONE" },
      authMode: "bearer",
      modelId: "some-model",
      prefix: "always answer in Chinese",
      contextSize: 128_000,
      maxOutput: 8_192,
      reasoningEffort: "high",
      thinkingDialect: "adaptive",
      serverTools: ["web_search"],
    });
  });

  it("passes an empty baseUrl through instead of substituting a default", () => {
    // An empty base means "use this protocol's own default", and only the
    // adapter knows which one that is — substituting api.openai.com here would
    // point a Gemini or Anthropic provider at it.
    const empty = connOptions({ ...conn, provider: { ...provider, baseUrl: "" } });
    expect(empty.baseUrl).toBe("");
  });

  it("round-trips through pickConnOptions without dropping a field", () => {
    // Fails the day someone adds a field to ConnOptions + connOptions and
    // forgets pickConnOptions — which no type error would catch, because every
    // added field will be optional.
    const built = connOptions(conn);
    expect(pickConnOptions(built)).toEqual(built);
  });

  it("narrows an extended argument bag down to the transport fields", () => {
    const wide = { ...connOptions(conn), systemPrompt: "…", onText: () => {} };
    expect(Object.keys(pickConnOptions(wide)).sort()).toEqual([
      "apiKey", "authMode", "baseUrl", "contextSize", "maxOutput",
      "modelId", "prefix", "reasoningEffort", "safetySettings", "serverTools",
      "standard", "temperature", "thinkingDialect",
    ]);
  });
});

describe("resolveConn", () => {
  it("pairs a model with the endpoint that serves it", () => {
    const r = resolveConn([model], [provider], "m1");
    expect(r).toEqual({ ok: true, model, provider });
  });

  it("tells the three failures apart", () => {
    // One call site used to report all three as "no model selected", which sends
    // the author to the wrong screen for two of them.
    const none = resolveConn([model], [provider], null);
    const gone = resolveConn([model], [provider], "deleted");
    const orphan = resolveConn([{ ...model, providerId: "p-gone" }], [provider], "m1");

    for (const r of [none, gone, orphan]) expect(r.ok).toBe(false);
    const messages = [none, gone, orphan].map((r) => (r.ok ? "" : r.error));
    expect(new Set(messages).size).toBe(3);
  });
});
