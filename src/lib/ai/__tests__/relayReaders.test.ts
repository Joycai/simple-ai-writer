/**
 * The readers that *promise* a capability without building a request — the
 * PDF subagent's eligibility (`readsPdf`) and the search subagent's
 * (`serverToolsSent`) — resolve a relay model's upstream from the channel's
 * table, as `connOptions()` does for the request itself. If either went back
 * to reading the id alone, a subagent picker would disagree with what the
 * request sends (capability-gating-plan §8.11).
 */
import { describe, expect, it } from "vitest";
import { pdfRouteFor, readsPdf, type Model, type Provider } from "../configDb";
import { serverToolsSent } from "../serverTools";
import { upstreamDropping } from "../relayUpstream";
import { normalizeChannel, routeProvider } from "../routes";

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

// The subagent texts say *which* reason: the upstream, or the platform / route.
describe("upstreamDropping", () => {
  it("names the upstream only when it is the reason", () => {
    const anth = relay("anthropic_compat", [...TABLE, { prefix: "[anti量]", upstream: "anti" }]);
    expect(upstreamDropping("web_search", model("[正向AWSb量]claude-opus-4-6"), anth)).toBe("bedrock");
    expect(upstreamDropping("web_search", model("[CC量]claude-opus-5"), anth)).toBeUndefined();
    expect(upstreamDropping("pdfInput", model("[anti量]claude-opus-4-6"), relay("openai_compat", [{ prefix: "[anti量]", upstream: "anti" }])))
      .toBe("anti");
    // On Anthropic the protocol rule already refuses anti's PDF: not the upstream's doing.
    expect(upstreamDropping("pdfInput", model("[anti量]claude-opus-4-6"), anth)).toBeUndefined();
    expect(upstreamDropping("web_search", model("[正向AWSb量]claude-opus-4-6", { relayUpstream: "none" }), anth)).toBeUndefined();
  });
});

// The PDF hint's "move the model to another route" names one that would carry
// the file — on a relay, a route with a PDF spelling can still lose it upstream.
describe("pdfRouteFor", () => {
  const twoRoutes = normalizeChannel({
    ...relay("anthropic_compat", TABLE),
    endpoints: [{ family: "anthropic", official: false }, { family: "openai", official: false }],
  });
  const onAnth = routeProvider(twoRoutes, "anthropic")!;

  it("names a route of the channel where the model's PDF would be sent", () => {
    expect(readsPdf({ ...model("claude-opus-5"), pdfInput: true }, onAnth)).toBe(false);
    expect(pdfRouteFor({ ...model("claude-opus-5"), pdfInput: true }, onAnth)).toBe("openai");
  });

  it("names none when the upstream behind the other route drops the file too", () => {
    expect(pdfRouteFor({ ...model("kiro-claude-opus-4-6"), pdfInput: true }, onAnth)).toBeUndefined();
    expect(pdfRouteFor({ ...model("claude-opus-5"), pdfInput: true }, relay("anthropic_compat"))).toBeUndefined();
  });
});
