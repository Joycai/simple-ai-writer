/**
 * Every request body the app would send, byte for byte, across the platform ×
 * route × model × declaration grid — the proof the capability-resolution
 * refactor rests on (docs/api/capability-resolution-lld.md §6, P0).
 *
 * Each phase of that refactor moves where a decision is made, never what the
 * wire carries. So these files are taken once, before the first move, and a
 * phase that changes one without its line in the behaviour-change ledger (LLD
 * §5) is a bug. A phase that *means* to change the wire updates them, and the
 * diff — which platform, which route, which model, which field — is what gets
 * reviewed, the same way `capability-matrix.md` shows which cells moved.
 *
 * Everything goes through the real producers: rows become a request through
 * `connOptions()` (thinking category, output cap, relay upstream), structured
 * requests through `jsonModeShaping()`, and the request through
 * `streamCompletion()`, whose `fetch` is the only thing stubbed — it records
 * the URL and body and fails the call. The 将发送 summary is taken beside each
 * row from `wireSummary()`, so the day the two are made to agree (LLD B10) the
 * diff says exactly where they did not.
 *
 * One file per platform under `__snapshots__/requestGolden/`. The messages are
 * the same in every request and are left out; `instructions` stays, because
 * whether the system prompt rides there is a capability (`instructionsField`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connOptions } from "../conn";
import type { Model, Provider } from "../configDb";
import { streamCompletion } from "../index";
import { __resetJsonModeMemo, jsonModeShaping } from "../jsonMode";
import { wireSummary } from "../modelSummary";
import { PLATFORM_IDS, platformEndpoints, platformOrigin, type PlatformId } from "../platforms";
import { RELAY_UPSTREAMS, isRelayPlatform, type RelayUpstreamChoice } from "../relayUpstream";
import { routeProvider, standardOf, type Endpoint } from "../routes";
import { SERVER_TOOL_IDS } from "../serverTools";
import { __resetForcedToolChoiceMemo } from "../toolChoice";
import type { StreamOptions, ToolDefinition } from "../types";

/**
 * Model ids that some table singles out, one or two per table: DashScope's
 * code-interpreter lists (both wires, Responses only, neither), a relay's Kiro
 * Claude, OpenAI's and OrcaRouter's GPT ids with effort cells, and one id from
 * each per-platform calibration and each model-id prefix list.
 */
const MODEL_IDS = [
  "qwen3.5-plus", "qwen3.8-flash", "no-such-model", "[特价kiro量]claude-opus-5",
  "gpt-5.6-sol", "openai/gpt-5.6-sol", "openai/gpt-6-astra",
  "claude-sonnet-5", "gemini-3.8-flash", "glm-5.3", "deepseek-v4-pro",
];

/** On a relay only: every upstream, with a model its measurements cover and one they do not. */
const UPSTREAM_CASES: readonly { modelId: string; relayUpstream: RelayUpstreamChoice }[] = RELAY_UPSTREAMS.flatMap(
  (relayUpstream) => ["[x]claude-opus-4-6", "[x]gpt-5.6-sol"].map((modelId) => ({ modelId, relayUpstream })),
);

/** What the model row declares, beyond its id. */
const PRESETS: Record<string, Partial<Model>> = {
  bare: {},
  declared: {
    serverTools: [...SERVER_TOOL_IDS], vlHighResolution: true, textVerbosity: "low", temperature: 0.4,
    videoInput: true, videoFps: 1, pdfInput: true,
  },
  structured: { structuredOutput: "json_schema", thinkingCategory: "off" },
  effortHigh: { reasoningEffort: "high", thinkingBudget: 8000 },
  effortOff: { reasoningEffort: "off" },
  effortMax: { reasoningEffort: "max" },
};

const FUNCTION_TOOL: ToolDefinition = {
  type: "function",
  function: { name: "pick", description: "Pick one.", parameters: { type: "object", properties: { id: { type: "string" } } } },
};
const SCHEMA = { name: "answer", parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } };

/** The request each preset is sent as. A forced tool only where effort and forcing interact. */
const REQUESTS: readonly { preset: string; tools: boolean }[] = [
  ...Object.keys(PRESETS).map((preset) => ({ preset, tools: false })),
  ...["bare", "effortHigh", "effortOff"].map((preset) => ({ preset, tools: true })),
];

const MESSAGES: StreamOptions["messages"] = [
  { role: "system", content: "Be brief. Answer in JSON." },
  { role: "user", content: "hi" },
];
/** The same in every request — left out so each body is the part that varies. */
const OMIT = new Set(["messages", "input", "contents", "system"]);

/** A channel with every route its platform serves, the way a new one is created. */
function channelOf(platform: PlatformId): Provider {
  const origin = platformOrigin(platform) || "https://relay.example.invalid";
  const endpoints: Endpoint[] = platformEndpoints(platform).map((e) => ({
    family: e.family,
    official: e.official === true,
    ...(e.authMode ? { authMode: e.authMode } : {}),
  }));
  return {
    id: "p", name: platform, baseUrl: origin, host: origin, apiStandard: standardOf(endpoints[0]),
    platform, endpoints, createdAt: 0,
  };
}

function modelOf(modelId: string, extra: Partial<Model>, relayUpstream?: RelayUpstreamChoice): Model {
  return {
    id: "m", providerId: "p", modelId, name: modelId, type: "multimodal",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true,
    ...(relayUpstream ? { relayUpstream } : {}),
    ...extra,
  };
}

/** Keys sorted at every level, so a reordering that changes nothing on the wire changes nothing here. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

function bodyLine(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const body = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([k]) => !OMIT.has(k)));
  return JSON.stringify(canonical(body));
}

/** Every request `streamCompletion` makes for one call — URL and body — until `fetch` fails it. */
async function capture(opts: StreamOptions): Promise<string[]> {
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    sent.push(`POST ${String(url).replace(/[?&]key=[^&]*/, "")}\n${bodyLine(String(init.body))}`);
    throw new Error("captured");
  }));
  await streamCompletion(opts).catch(() => {});
  return sent;
}

async function platformGolden(platform: PlatformId): Promise<string> {
  const channel = channelOf(platform);
  const cases = [
    ...MODEL_IDS.map((modelId) => ({ modelId, relayUpstream: undefined as RelayUpstreamChoice | undefined })),
    ...(isRelayPlatform(platform) ? UPSTREAM_CASES : []),
  ];
  const out: string[] = [`# ${platform}`];
  for (const endpoint of channel.endpoints ?? []) {
    const route = routeProvider(channel, endpoint.family);
    if (!route) continue;
    out.push("", `## ${endpoint.family} · ${route.apiStandard}`);
    for (const { modelId, relayUpstream } of cases) {
      const label = `${modelId}${relayUpstream ? ` @${relayUpstream}` : ""}`;
      for (const [preset, extra] of Object.entries(PRESETS)) {
        const model = modelOf(modelId, extra, relayUpstream);
        const conn = connOptions({ provider: route, model, apiKey: "k" });
        const summary = wireSummary(model, conn.standard, conn.baseUrl, conn.platform, conn.relayUpstream)
          .map((i) => `${i.scope ? `${i.scope}:` : ""}${i.key}=${i.value}`).join(" ");
        out.push("", `### ${label} · ${preset}`, `summary: ${summary || "—"}`);
        for (const req of REQUESTS.filter((r) => r.preset === preset)) {
          const shaping = preset === "structured"
            ? jsonModeShaping(conn, MESSAGES.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"), SCHEMA)
            : undefined;
          const sent = await capture({
            ...conn,
            messages: MESSAGES,
            onChunk: () => {},
            ...(req.tools ? { tools: [FUNCTION_TOOL], toolChoice: "required" as const } : {}),
            ...(shaping?.extraBody ? { extraBody: shaping.extraBody } : {}),
          });
          out.push(
            `- ${req.tools ? "tools+required" : "plain"}${shaping ? ` (json ${shaping.mode}${shaping.cue ? " +cue" : ""})` : ""}`,
            ...sent,
          );
        }
      }
    }
  }
  return `${out.join("\n")}\n`;
}

beforeEach(() => {
  __resetForcedToolChoiceMemo();
  __resetJsonModeMemo();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request bodies across the platform × route × model × declaration grid", () => {
  it.each(PLATFORM_IDS)("%s", async (platform) => {
    await expect(await platformGolden(platform)).toMatchFileSnapshot(`./__snapshots__/requestGolden/${platform}.txt`);
  });
});
