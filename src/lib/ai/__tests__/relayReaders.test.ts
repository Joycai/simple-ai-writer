/**
 * The readers that *promise* a capability without building a request — the
 * PDF subagent's eligibility (`readsPdf`) and the search subagent's
 * (`serverToolsSent`) — resolve a relay model's upstream from the channel's
 * table, as `connOptions()` does for the request itself. If either went back
 * to reading the id alone, a subagent picker would disagree with what the
 * request sends (capability-gating-plan §8.11).
 */
import { describe, expect, it } from "vitest";
import { readsPdf, type Model, type Provider } from "../configDb";
import { serverToolsSent } from "../serverTools";

const relay = (endpointStandard: Provider["apiStandard"], upstreamPrefixes?: Provider["upstreamPrefixes"]): Provider => ({
  id: "r", name: "Relay", baseUrl: "https://relay.example", apiStandard: endpointStandard, platform: "newapi",
  upstreamPrefixes, createdAt: 0,
});
const TABLE = [{ prefix: "[CC量]", upstream: "cc" as const }, { prefix: "[正向AWSb量]", upstream: "bedrock" as const }];

const model = (modelId: string, extra: Partial<Model> = {}): Model => ({
  id: "m", providerId: "r", modelId, name: modelId, type: "text", priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, ...extra,
});

describe("readsPdf on a relay", () => {
  it("follows the channel's table: CC reads the Anthropic document block, an unmapped id does not", () => {
    const anth = relay("anthropic_compat", TABLE);
    expect(readsPdf({ ...model("[CC量]claude-opus-5"), pdfInput: true }, anth)).toBe(true);
    expect(readsPdf({ ...model("[anti量]claude-opus-5"), pdfInput: true }, anth)).toBe(false);
    // Without the table, the same id names no upstream: the relay's default for that block.
    expect(readsPdf({ ...model("[CC量]claude-opus-5"), pdfInput: true }, relay("anthropic_compat"))).toBe(false);
  });

  it("lets the model's own choice win over the table", () => {
    const chat = relay("openai_compat", TABLE);
    expect(readsPdf({ ...model("[CC量]claude-opus-5"), pdfInput: true }, chat)).toBe(true);
    expect(readsPdf({ ...model("[CC量]claude-opus-5", { relayUpstream: "anti" }), pdfInput: true }, chat)).toBe(false);
  });
});

describe("serverToolsSent on a relay", () => {
  const declared = { serverTools: ["web_search" as const] };

  it("follows the channel's table", () => {
    const providers = [relay("anthropic_compat", TABLE)];
    expect(serverToolsSent(model("[CC量]claude-opus-5", declared), providers)).toEqual(["web_search"]);
    expect(serverToolsSent(model("[正向AWSb量]claude-opus-4-6", declared), providers)).toBeUndefined();
    // No table: the relay's own answer for the protocol tool (unmeasured, so sent).
    expect(serverToolsSent(model("[正向AWSb量]claude-opus-4-6", declared), [relay("anthropic_compat")])).toEqual(["web_search"]);
  });

  it("lets the model's own choice win over the table", () => {
    const providers = [relay("anthropic_compat", TABLE)];
    expect(serverToolsSent(model("[CC量]claude-opus-5", { ...declared, relayUpstream: "anti" }), providers)).toBeUndefined();
    expect(serverToolsSent(model("[正向AWSb量]claude-opus-4-6", { ...declared, relayUpstream: "none" }), providers))
      .toEqual(["web_search"]);
  });
});
