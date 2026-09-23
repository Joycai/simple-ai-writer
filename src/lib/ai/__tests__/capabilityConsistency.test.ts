/**
 * Every asker agrees with the table (docs/api/capability-gating-plan.md §3,
 * gate 2).
 *
 * The matrix test pins what the table *says*; this pins that the app *does*
 * it. For every platform, each of its routes, every capability and a few model
 * ids, each place that acts on the capability — the adapter's request body,
 * the 将发送 summary, the chat surface's video gate — is asked the same thing
 * the table is, and the answers must match: declared and `hasCapability` ⇒
 * it reaches the request; declared and not ⇒ nothing changes.
 *
 * "Reaches the request" is observed, not re-derived: the body (or summary)
 * built with the declaration is compared against the one built without it.
 * So an asker that grows its own condition — the family check that let
 * DashScope's field onto 智谱 — shows up here as a cell that disagrees, and a
 * platform cell written for a family whose adapter never reads it shows up
 * too.
 *
 * `PROBES` is a `Record<CapabilityId, …>`: a new capability does not compile
 * until it says who acts on it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY_IDS, hasCapability, type CapabilityId } from "../capabilities";
import { PLATFORM_IDS, platformEndpoints, type PlatformId } from "../platforms";
import { readsPdf } from "../configDb";
import { wireSummary, type WireInput } from "../modelSummary";
import { canReadVideo, sentVideoFps } from "../videoInput";
import { standardOf } from "../routes";
import { streamAnthropic } from "../anthropic";
import { streamGemini } from "../gemini";
import { streamOpenAI } from "../openai";
import { streamResponses } from "../responses";
import { resolveThinkingCategory } from "../reasoning";
import { familyOf, type ApiStandard, type ProtocolFamily, type StreamOptions } from "../types";
import type { ServerToolId } from "../serverTools";
import { capabilityModelOf, type RelayUpstreamChoice } from "../relayUpstream";

const BASE_URL = "https://capability-consistency.invalid/v1";
/**
 * One id that runs DashScope's code interpreter on both wires, one on Responses
 * only, one nobody names, and a relay's Kiro-served Claude — its upstream
 * inferred from the id, as every hand-built request does.
 */
const MODEL_IDS = ["qwen3.5-plus", "qwen3.8-flash", "no-such-model", "[特价kiro量]claude-opus-5"];
/**
 * A relay's Claude under an id that names no upstream, with the upstream as
 * `connOptions()` resolves it from the channel's table — so an asker that drops
 * `relayUpstream` on the way to the table disagrees here — and a Kiro id
 * resolved to none, which must not be inferred back.
 */
const UPSTREAM_CASES: readonly { modelId: string; relayUpstream: RelayUpstreamChoice }[] = [
  ...(["kiro", "cc", "anti", "bedrock", "official"] as const).map((relayUpstream) => ({ modelId: "[x]claude-opus-4-6", relayUpstream })),
  { modelId: "[特价kiro量]claude-opus-5", relayUpstream: "none" },
];
const CASES: readonly { modelId: string; relayUpstream?: RelayUpstreamChoice }[] = [
  ...MODEL_IDS.map((modelId) => ({ modelId })),
  ...UPSTREAM_CASES,
];
const TYPE = "multimodal" as const;

const ADAPTERS: Record<ProtocolFamily, (o: StreamOptions) => Promise<void>> = {
  openai: streamOpenAI, responses: streamResponses, anthropic: streamAnthropic, gemini: streamGemini,
};

interface Ctx {
  platform: PlatformId;
  standard: ApiStandard;
  modelId: string;
  relayUpstream?: RelayUpstreamChoice;
}

/** The body the adapter would POST — captured at `fetch`, which then fails the request. */
async function bodyOf(ctx: Ctx, extra: Partial<StreamOptions>): Promise<string> {
  let body = "";
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    body = String(init.body);
    throw new Error("captured");
  }));
  await ADAPTERS[familyOf(ctx.standard)]({
    baseUrl: BASE_URL, apiKey: "k", standard: ctx.standard, platform: ctx.platform, modelId: ctx.modelId,
    relayUpstream: ctx.relayUpstream,
    messages: [{ role: "user", content: "hi" }], onChunk: () => {}, ...extra,
  }).catch(() => {});
  return body;
}

async function adapterSends(ctx: Ctx, without: Partial<StreamOptions>, withIt: Partial<StreamOptions>): Promise<boolean> {
  return (await bodyOf(ctx, without)) !== (await bodyOf(ctx, withIt));
}

function summarySends(ctx: Ctx, without: Partial<WireInput>, withIt: Partial<WireInput>): boolean {
  const row = (m: Partial<WireInput>) =>
    JSON.stringify(wireSummary({ type: TYPE, modelId: ctx.modelId, ...m }, ctx.standard, BASE_URL, ctx.platform, ctx.relayUpstream));
  return row(without) !== row(withIt);
}

const provider = (ctx: Ctx) => ({ platform: ctx.platform, baseUrl: BASE_URL, apiStandard: ctx.standard });

type Probe = (ctx: Ctx) => Promise<Record<string, boolean>>;

/** An endpoint-run tool: declared alone, or beside the search it rides on (normalizeServerTools). */
const serverTool = (id: ServerToolId): Probe => async (ctx) => {
  const base: ServerToolId[] = id === "web_extractor" ? ["web_search"] : [];
  return {
    adapter: await adapterSends(ctx, { serverTools: base }, { serverTools: [...base, id] }),
    summary: summarySends(ctx, { serverTools: base }, { serverTools: [...base, id] }),
  };
};

const FUNCTION_TOOL = { type: "function" as const, function: { name: "pick", description: "", parameters: { type: "object", properties: {} } } };

const PROBES: Record<CapabilityId, Probe> = {
  // The PDF subagent's eligibility and the delegation gate both ask readsPdf.
  pdfInput: async (ctx) => ({
    readsPdf: readsPdf({ pdfInput: true, modelId: ctx.modelId, relayUpstream: ctx.relayUpstream }, provider(ctx)),
  }),
  vlHighResolution: async (ctx) => ({
    adapter: await adapterSends(ctx, {}, { vlHighResolution: true }),
    summary: summarySends(ctx, {}, { vlHighResolution: true }),
  }),
  // The clip part is built by the caller, so the chat surface's gate is the asker.
  videoInput: async (ctx) => ({ canReadVideo: canReadVideo({ type: TYPE, videoInput: true }, provider(ctx)) }),
  videoFps: async (ctx) => ({
    sentVideoFps: sentVideoFps({ videoFps: 1 }, provider(ctx)) !== undefined,
    summary: summarySends(ctx, { videoInput: true }, { videoInput: true, videoFps: 1 }),
  }),
  forcedToolChoice: async (ctx) => ({
    adapter: await adapterSends(ctx, { tools: [FUNCTION_TOOL], toolChoice: "auto" }, { tools: [FUNCTION_TOOL], toolChoice: "required" }),
  }),
  // The adapter and the summary both run with the row's (unset) category, so
  // an Anthropic model thinks and the table says no — see `expected` below.
  temperature: async (ctx) => ({
    adapter: await adapterSends(ctx, {}, { temperature: 0.5 }),
    summary: summarySends(ctx, {}, { temperature: 0.5 }),
  }),
  textVerbosity: async (ctx) => ({
    adapter: await adapterSends(ctx, {}, { textVerbosity: "low" }),
    summary: summarySends(ctx, {}, { textVerbosity: "low" }),
  }),
  // The one capability no request reads: the declaration takes the model out
  // of every picker and hands it to lib/translate, and the drawer is what
  // keeps it off a wire without the capability (cleared on save). Nothing
  // here can observe that, so the probe names no asker — on purpose, not by
  // omission.
  translateFormat: async () => ({}),
  // Strength is jsonMode.ts's (whitelisted body shaping); whether there is a
  // JSON mode at all must match the table on the one surface that shows it.
  structuredOutput: async (ctx) => ({
    summary: summarySends(ctx, { structuredOutput: "off" }, { structuredOutput: "json_object" }),
  }),
  // A declared strict tier reaches the request exactly where the table allows
  // it — a platform measured to ignore it is sent json_object instead.
  jsonSchema: async (ctx) => ({
    summary: summarySends(ctx, { structuredOutput: "json_object" }, { structuredOutput: "json_schema" }),
  }),
  web_search: serverTool("web_search"),
  web_extractor: serverTool("web_extractor"),
  web_search_image: serverTool("web_search_image"),
  image_search: serverTool("image_search"),
  code_interpreter: serverTool("code_interpreter"),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("every asker agrees with the capability table", () => {
  it.each(CAPABILITY_IDS)("%s", async (id) => {
    const disagreements: string[] = [];
    for (const platform of PLATFORM_IDS) for (const endpoint of platformEndpoints(platform)) {
      const standard = standardOf({ family: endpoint.family, official: !!endpoint.official });
      for (const { modelId, relayUpstream } of CASES) {
        const ctx = { platform, standard, modelId, relayUpstream };
        // The model as the probes build it: no category declared, so the family default.
        const thinkingCategory = resolveThinkingCategory({}, standard).id;
        const model = { ...capabilityModelOf({ modelId, relayUpstream }), type: TYPE, thinkingCategory };
        const expected = hasCapability(id, { platform, standard }, model);
        const label = `${platform}/${standard}/${modelId}${relayUpstream ? `@${relayUpstream}` : ""}`;
        for (const [asker, sent] of Object.entries(await PROBES[id](ctx))) {
          if (sent !== expected) disagreements.push(`${label} ${asker}: sends ${sent}, table ${expected}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});
