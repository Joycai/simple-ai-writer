/**
 * Platform profiles — what a *server* accepts beyond its protocol.
 *
 * The protocol family (`ProtocolFamily`) answers "what does a message look
 * like". It does not answer "which extra fields does this server take", and
 * until this table existed that second question was answered by the first:
 * `openai_compat` was silently read as "DashScope", so a DeepSeek, New API,
 * OrcaRouter or Ollama provider with 联网搜索 declared sent DashScope's private
 * `enable_search` / `search_options` / `enable_code_interpreter` — ignored at
 * best (the author believes the model searched; it did not), a 400 at worst.
 * xAI's Responses endpoint refuses `web_extractor` and the two image searches
 * outright: they are DashScope's names (docs/api/landscape.md §7 第十一个样本).
 *
 * So the platform is now a first-class value on the provider row
 * (`Provider.platform`), and everything a platform adds on top of its protocol
 * is looked up here by `(platform, family)`. Plan and reasoning:
 * docs/feature/channel-model-route-plan.md §4. Three rules from there:
 *
 *   1. **Spellings are dispatched on `(platform, family)`, never on `standard`.**
 *      A private field appears only on the platform that measured it.
 *   2. **`custom` is a platform, not an error.** A provider whose host matches
 *      nothing lands there and gets the protocol's own vocabulary only.
 *   3. **This is code, not configuration.** A row stores the id; a new
 *      measurement updates every row that names the platform, with no
 *      migration. An id this build does not know reads as `custom`.
 *
 * What a platform *can do* — server tools, PDF input, a vendor's private knobs —
 * moved to the capability table (`capabilities.ts`); this file keeps where a
 * platform lives (hosts, routes) and what it knows about its own model ids.
 *
 * Every entry should point back at a measurement — the `source` field says
 * which one.
 */

import { familyOf, isCompatStandard, type ApiStandard, type AuthMode, type ProtocolFamily } from "./types";
import type { ThinkingCategoryId } from "./reasoning";

export type PlatformId =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "dashscope"
  | "dashscope-intl"
  | "xai"
  | "minimax"
  | "volcengine"
  | "volcengine-plan"
  | "zhipu"
  | "orcarouter"
  | "newapi"
  | "ollama"
  | "comfyui"
  | "custom";

/** Selectable values, in the order the provider drawer lists them. */
export const PLATFORM_IDS: readonly PlatformId[] = [
  "openai", "anthropic", "google", "deepseek", "dashscope", "dashscope-intl", "xai",
  "minimax", "volcengine", "volcengine-plan", "zhipu", "orcarouter", "newapi", "ollama", "comfyui", "custom",
];

/**
 * One route a platform serves: a protocol family at a path below the platform's
 * host (docs/feature/channel-model-route-plan.md §5.1.1). `path` is what goes
 * between the host and the adapter's own tail (`/chat/completions`,
 * `/v1/messages`, …) — the same thing a provider's base URL always held past
 * its host, so `lib/ai/urls.ts` trims it exactly as before.
 */
interface PlatformEndpoint {
  family: ProtocolFamily;
  path: string;
  /**
   * The vendor's own endpoint: its address is a constant (`defaultBaseFor`),
   * so the route table shows it read-only and a row stores no path for it.
   */
  official?: true;
  /** The header the platform documents for the key, when not the protocol's own. */
  authMode?: AuthMode;
}

/**
 * The conventions every self-hosted relay and generic gateway follows — New
 * API's docs and OrcaRouter's both: the OpenAI halves under `/v1`, Gemini under
 * `/v1beta`, Anthropic at the root (the adapter appends `/v1/messages`).
 */
const GENERIC_ENDPOINTS: readonly PlatformEndpoint[] = [
  { family: "openai", path: "/v1" },
  { family: "responses", path: "/v1" },
  { family: "gemini", path: "/v1beta" },
  { family: "anthropic", path: "" },
];

/**
 * What a platform knows about one of its own model ids — the values a model
 * row should start with when the author adds that id. A prefill, never a
 * runtime default: the model drawer writes these into the form (only into
 * fields the author has not touched) and the row stores them like anything
 * the author typed, so nothing on the wire depends on this table afterwards.
 *
 * It exists because the family default is wrong for a whole platform: on 智谱
 * the ① family's `reasoning_effort` fails silently on every one of eleven
 * models, in three different ways (docs/api/zhipu-plan.md G11).
 */
export interface ModelCalibration {
  thinkingCategory?: ThinkingCategoryId;
  contextSize?: number;
  maxOutput?: number;
  /** Absent = the drawer's own default (`text`). */
  type?: "multimodal";
  pdfInput?: true;
}

interface PlatformProfile {
  /** `scheme://host` of the platform's own server; absent = the author types it (New API, custom). */
  origin?: string;
  /**
   * The routes this platform serves, in the order a new channel lists them —
   * the first is the channel's primary route. Every path is one a sample in
   * landscape.md reached, or the preset it replaces had.
   */
  endpoints: readonly PlatformEndpoint[];
  /**
   * Hosts that identify the platform when a row carries no `platform` yet
   * (every row saved before the column existed). Lower-case, `host[:port]`,
   * optionally followed by a path prefix (`host/api/plan`) for two platforms
   * that share one host and differ by path — the longest match wins, so the
   * prefixed entry beats the bare host it sits under.
   */
  hosts: readonly string[];
  /**
   * Per-model prefills, keyed by the exact lower-case model id the platform
   * serves ({@link ModelCalibration}). Only ids a sample measured.
   */
  models?: Readonly<Record<string, ModelCalibration>>;
  /**
   * `include` entries the Responses route must ask for. Only for what a
   * platform withholds unless asked: xAI returns a reasoning item's
   * `encrypted_content` only on request, and the echo without it still 200s —
   * the next turn just silently starts its reasoning over (landscape.md §7
   * 第十一个样本). Absent = send no `include`, which is what the relays that
   * attach it unasked were measured with (responses.md §2.4).
   */
  responsesInclude?: readonly string[];
  /** Where the entries above were measured. */
  source: string;
}

/**
 * 智谱's eleven chat models, all measured 2026-09-19 (landscape.md §7 第十四个样本
 * 「逐模型校准」). Three thinking controls: the 5.3 generation cannot stop and
 * takes low/high/max (`glm`); 5.2 stops only via the switch and has two real
 * levels (`glm-effort`); everything older ignores reasoning_effort (`glm-switch`).
 * Output caps are the measured `max_tokens` bounds, except glm-4.5 — it
 * accepts 131,072 but its documented cap is 96K, and the lower number never 400s.
 */
const GLM_1M = 1_048_576;
const GLM_200K = 204_800;
const GLM_128K = 131_072;
const ZHIPU_MODELS: Record<string, ModelCalibration> = {
  "glm-5.3": { thinkingCategory: "glm", contextSize: GLM_1M, maxOutput: 131_072 },
  "glm-5.3-flash": { thinkingCategory: "glm", contextSize: GLM_1M, maxOutput: 131_072, type: "multimodal", pdfInput: true },
  "glm-5.3-flashx": { thinkingCategory: "glm", contextSize: GLM_1M, maxOutput: 131_072, type: "multimodal", pdfInput: true },
  "glm-5.2": { thinkingCategory: "glm-effort", contextSize: GLM_1M, maxOutput: 131_072 },
  "glm-5.1": { thinkingCategory: "glm-switch", contextSize: GLM_200K, maxOutput: 131_072 },
  "glm-5": { thinkingCategory: "glm-switch", contextSize: GLM_200K, maxOutput: 131_072 },
  "glm-5-turbo": { thinkingCategory: "glm-switch", contextSize: GLM_200K, maxOutput: 131_072 },
  "glm-4.7": { thinkingCategory: "glm-switch", contextSize: GLM_200K, maxOutput: 131_072 },
  "glm-4.6": { thinkingCategory: "glm-switch", contextSize: GLM_200K, maxOutput: 131_072 },
  "glm-4.5": { thinkingCategory: "glm-switch", contextSize: GLM_128K, maxOutput: 98_304 },
  "glm-4.5-air": { thinkingCategory: "glm-switch", contextSize: GLM_128K, maxOutput: 98_304 },
};

/**
 * DeepSeek's two listed models (landscape.md §2.1, `/models` 2026-09-17). The
 * `deepseek` category is the point: the family default spells off as
 * `reasoning_effort:"none"`, which DeepSeek does not read as off — its off is
 * the `thinking:{type:"disabled"}` switch (qianwen-compat-plan.md P1). Without
 * this a hand-added row thought on after the author pressed 关.
 */
const DEEPSEEK_MODELS: Record<string, ModelCalibration> = {
  "deepseek-flash": { thinkingCategory: "deepseek", contextSize: 1_048_576, maxOutput: 393_216, type: "multimodal" },
  "deepseek-v4-pro": { thinkingCategory: "deepseek", contextSize: 1_048_576, maxOutput: 393_216 },
};

const PROFILES: Record<PlatformId, PlatformProfile> = {
  openai: {
    origin: "https://api.openai.com",
    endpoints: [{ family: "openai", path: "", official: true }, { family: "responses", path: "", official: true }],
    hosts: ["api.openai.com"],
    source: "docs/api/responses.md §10 (GPT-5.6, 2026-09-14)",
  },
  anthropic: {
    origin: "https://api.anthropic.com",
    endpoints: [{ family: "anthropic", path: "", official: true }],
    hosts: ["api.anthropic.com"],
    source: "Anthropic's own versioned web_search tool",
  },
  google: {
    origin: "https://generativelanguage.googleapis.com",
    endpoints: [{ family: "gemini", path: "", official: true }],
    hosts: ["generativelanguage.googleapis.com"],
    source: "no server tool spelled on the Gemini wire (the only family this platform serves)",
  },
  deepseek: {
    origin: "https://api.deepseek.com",
    endpoints: [
      { family: "openai", path: "" },
      // `/responses` and `/v1/responses` both answer (landscape.md §2.1).
      { family: "responses", path: "" },
      { family: "anthropic", path: "/anthropic" },
    ],
    hosts: ["api.deepseek.com"],
    models: DEEPSEEK_MODELS,
    source: "landscape.md §2.1 — no server tools on Chat Completions; the Anthropic-shaped path is unmeasured",
  },
  dashscope: {
    origin: "https://dashscope.aliyuncs.com",
    endpoints: [
      { family: "openai", path: "/compatible-mode/v1" },
      // Same path; the adapter appends /responses below it.
      { family: "responses", path: "/compatible-mode/v1" },
      // The root — the platform's FAQ warns against a trailing /v1.
      { family: "anthropic", path: "/apps/anthropic" },
    ],
    hosts: ["dashscope.aliyuncs.com"],
    source: "landscape.md §7 第六个样本 (联网搜索与网页抓取 2026-09-14 · 代码解释器 2026-09-17)",
  },
  "dashscope-intl": {
    origin: "https://dashscope-intl.aliyuncs.com",
    endpoints: [
      { family: "openai", path: "/compatible-mode/v1" },
      { family: "responses", path: "/compatible-mode/v1" },
      // Whether this host serves /apps/anthropic is unverified — not offered.
    ],
    hosts: ["dashscope-intl.aliyuncs.com"],
    source: "landscape.md §7 第六个样本, same surfaces as the domestic host",
  },
  xai: {
    origin: "https://api.x.ai",
    endpoints: [
      // Chat Completions is marked deprecated; Responses is the recommended wire.
      { family: "responses", path: "/v1" },
      { family: "openai", path: "/v1" },
    ],
    hosts: ["api.x.ai"],
    responsesInclude: ["reasoning.encrypted_content"],
    // web_search measured on grok-4.3; web_extractor and the image searches
    // are DashScope's names and are refused.
    source: "landscape.md §7 第十一个样本 (2026-09-14)",
  },
  minimax: {
    origin: "https://api.minimaxi.com",
    endpoints: [
      // Chat Completions lives under `/v1`: the bare root is nginx's 404 page
      // (no-key probe 2026-09-19 — root 404 text/html, `/v1/chat/completions`
      // 401 JSON). The adapter appends `/chat/completions` and nothing else.
      { family: "openai", path: "/v1" },
      { family: "anthropic", path: "/anthropic" },
    ],
    hosts: ["api.minimaxi.com", "api.minimax.io"],
    source: "landscape.md §7 第四个样本",
  },
  // 火山方舟. Two platforms on one host, told apart by path, because the key
  // decides the path: a pay-as-you-go key answers only under `/api/v3`, a
  // subscription (Agent / Coding Plan) key only under `/api/plan` — each is a
  // 401 on the other's path (landscape.md §7 第十二个样本). Same key, same
  // host, different product; one platform with both would offer routes the
  // key can never reach.
  volcengine: {
    origin: "https://ark.cn-beijing.volces.com",
    endpoints: [
      // Both from the vendor's own curl examples (文本生成 / 文档理解); the
      // plan key of the sample cannot reach this path, so unmeasured here.
      { family: "openai", path: "/api/v3" },
      { family: "responses", path: "/api/v3" },
    ],
    hosts: ["ark.cn-beijing.volces.com"],
    // No private search field on Chat Completions; Responses' own web_search
    // stays at "unknown" via the protocol-native list — on this key a bare
    // `{type:"web_search"}` may land on the separately-activated 联网内容插件
    // rather than 豆包搜索, which nobody has measured. The vendor also serves
    // Messages to these keys, but at a path a plan key cannot find (auth runs
    // before routing: every path is a 401), so no Anthropic route is listed.
    source: "Ark docs (文本生成 · 图片理解 · 文档理解, 2026-09-08); pay-as-you-go wire unmeasured",
  },
  "volcengine-plan": {
    origin: "https://ark.cn-beijing.volces.com",
    endpoints: [
      { family: "openai", path: "/api/plan/v3" },
      { family: "responses", path: "/api/plan/v3" },
      // The adapter appends /v1/messages. No /models on this prefix (404).
      { family: "anthropic", path: "/api/plan" },
    ],
    hosts: ["ark.cn-beijing.volces.com/api/plan"],
    // The vendor's 联网搜索 page names only Responses and Messages. Both ran
    // on all three sampled models; on a plan key the bare Responses
    // `{type:"web_search"}` bills to the `doubao` source (豆包搜索 Custom,
    // plan-covered) with no `sources` field. Chat Completions has no field.
    // A base64 `document` block was read (the secret word came back) — the
    // one Anthropic-shaped wire measured to do so.
    source: "landscape.md §7 第十二个样本 (2026-09-18)",
  },
  // 智谱 BigModel. One key reaches four prefixes on this host; the path, not
  // the key, decides whether a call bills the balance or a GLM Coding Plan —
  // and the plan's terms confine it to named tools this app is not among. So
  // only the pay-as-you-go standard endpoint is listed (docs/api/zhipu-plan.md
  // P1, P3 for the plan's routes).
  zhipu: {
    origin: "https://open.bigmodel.cn",
    endpoints: [{ family: "openai", path: "/api/paas/v4" }],
    // The standard path, not the bare host: a hand-made channel on the Coding
    // Plan's `/api/coding/paas` or `/api/anthropic` is another bill and other
    // terms, and must not be read as this platform (zhipu-plan.md G9).
    hosts: ["open.bigmodel.cn/api/paas"],
    // Its search is a `tools[]` entry, not the top-level field this app spells
    // for DashScope — and it answers "searched" without searching unless intent
    // detection is turned off. Not offered until it is wired (plan P2).
    // Documented `auto` only; measured: 5.3-flash / 4.7 ignore forcing, 4.7
    // refuses a named one while thinking with a bare 1210.
    models: ZHIPU_MODELS,
    source: "landscape.md §7 第十四个样本 (2026-09-19)",
  },
  orcarouter: {
    origin: "https://api.orcarouter.ai",
    endpoints: [
      { family: "openai", path: "/v1" },
      { family: "responses", path: "/v1" },
      // Bearer on every path is the one header its docs promise for both a
      // completion and /v1/models (landscape.md §7 第七个样本).
      { family: "anthropic", path: "", authMode: "bearer" },
      { family: "gemini", path: "/v1beta", authMode: "bearer" },
    ],
    hosts: ["api.orcarouter.ai"],
    source: "landscape.md §7 第七个样本 — relay; protocol-native tools unmeasured",
  },
  newapi: {
    endpoints: GENERIC_ENDPOINTS,
    hosts: [],
    source: "landscape.md §7 New API 样本 — relay; protocol-native tools depend on the upstream; Claude's capabilities follow the relay upstream behind each model (relayUpstream.ts, 第十五、十六个样本)",
  },
  ollama: {
    origin: "http://localhost:11434",
    endpoints: [{ family: "openai", path: "/v1" }],
    hosts: ["localhost:11434", "127.0.0.1:11434"],
    // A local server runs no tools of its own on any wire — say so rather
    // than inherit the protocol-native search at "unknown".
    source: "local server; no server tools",
  },
  comfyui: {
    origin: "http://127.0.0.1:8188",
    endpoints: [{ family: "openai", path: "" }],
    hosts: ["localhost:8188", "127.0.0.1:8188"],
    source: "local render server; reached through caps.route, not a chat wire",
  },
  custom: {
    endpoints: GENERIC_ENDPOINTS,
    hosts: [],
    source: "protocol vocabulary only; Claude's capabilities follow the relay upstream, as on newapi (relayUpstream.ts, 第十五、十六个样本)",
  },
};

/** Narrow a stored platform id; anything this build does not know is `custom` (rule 3). */
export function parsePlatform(raw: unknown): PlatformId | undefined {
  return typeof raw === "string" && (PLATFORM_IDS as readonly string[]).includes(raw)
    ? (raw as PlatformId)
    : raw == null || raw === "" ? undefined : "custom";
}

/**
 * The platform a row that never stored one belongs to, from its address.
 *
 * An official standard stores no base URL (the vendor's address is a constant),
 * so it is named by the standard. A compat one is named by its host; a host
 * that matches nothing is `custom` — which is also where a New API relay lands,
 * since a self-hosted relay has no host to recognise. Picking New API
 * explicitly changes nothing on the wire today (both have the protocol's
 * vocabulary only); it is a label the author may set.
 */
export function inferPlatform(baseUrl: string, standard: ApiStandard): PlatformId {
  if (!isCompatStandard(standard)) {
    switch (familyOf(standard)) {
      case "gemini": return "google";
      case "anthropic": return "anthropic";
      default: return "openai";
    }
  }
  const addr = addressOf(baseUrl);
  if (!addr) return "custom";
  let best: PlatformId = "custom";
  let bestLen = 0;
  for (const id of PLATFORM_IDS) {
    for (const h of PROFILES[id].hosts) {
      // `URL.host` already drops a scheme's default port, so an explicit `:443`
      // compares equal to the bare host. A path prefix matches on a segment
      // boundary only (`/api/plan` is not `/api/planner`).
      const hit = addr === h || addr.startsWith(`${h}/`);
      if (hit && h.length > bestLen) { best = id; bestLen = h.length; }
    }
  }
  return best;
}

/**
 * The platform a row actually talks to: the stored one, or — for a row saved
 * before the column existed — the inferred one.
 *
 * An official standard overrides whatever is stored. Its address is the
 * vendor's constant (`defaultBaseFor`), so the vendor *is* the platform; a
 * stale `dashscope` left on a row later switched to official OpenAI must not
 * put DashScope's fields on api.openai.com.
 */
export function resolvePlatform(stored: PlatformId | undefined, baseUrl: string, standard: ApiStandard): PlatformId {
  if (!isCompatStandard(standard)) return inferPlatform(baseUrl, standard);
  return stored ?? inferPlatform(baseUrl, standard);
}

/**
 * Whether a platform is identified by its host. The drawer uses it when the
 * author edits the address: moving off a host-identified platform's host
 * leaves that platform (to `custom`), while New API / custom — which no host
 * names — keep what the author picked.
 */
export function platformHasHosts(id: PlatformId): boolean {
  return PROFILES[id].hosts.length > 0;
}

/**
 * The platform the provider drawer shows after the author edits the address
 * or the standard.
 *
 * A host that names a platform wins — pasting DashScope's address means
 * DashScope. A host that names nothing leaves a *host-identified* platform
 * (the old address was that platform's; this one isn't) for `custom`, but
 * keeps New API / custom, which the author picked precisely because no host
 * names them.
 */
export function platformForAddress(current: PlatformId, baseUrl: string, standard: ApiStandard): PlatformId {
  const inferred = inferPlatform(baseUrl, standard);
  if (!isCompatStandard(standard)) return inferred;
  // The drawer's host field holds a bare host. Two platforms on one host
  // (火山方舟 按量 / Plan) differ only by path, so a bare host that is also the
  // current platform's host says nothing against the current pick. And a bare
  // host no platform names whole still belongs to the one that sits on it:
  // 智谱 names only its `/api/paas` path (so a full Coding Plan URL stays
  // custom), but this field never carries a path to tell them apart.
  if (sharesBareHost(current, baseUrl)) return current;
  if (inferred !== "custom") return inferred;
  const onHost = PLATFORM_IDS.find((id) => sharesBareHost(id, baseUrl));
  if (onHost) return onHost;
  return platformHasHosts(current) ? "custom" : current;
}

/** Whether `url` is a bare host (no path) that one of `id`'s `hosts` entries sits on. */
function sharesBareHost(id: PlatformId, url: string): boolean {
  const addr = addressOf(url);
  if (!addr || addr.includes("/")) return false;
  return PROFILES[id].hosts.some((h) => h.split("/")[0] === addr);
}

/**
 * Lower-case `host[:port]` of a URL followed by its path without a trailing
 * slash (`api.x.ai/v1`), or "" when it doesn't parse — what `hosts` entries
 * are matched against.
 */
function addressOf(url: string): string {
  try {
    const u = new URL(url.trim());
    return (u.host + u.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return "";
  }
}

/** The one wire question server tools depend on. */
export interface ServerToolWire {
  platform: PlatformId;
  standard: ApiStandard;
}

/**
 * The wire of a request or a provider row. `platform` may be absent — a
 * hand-built option bag, a row from before the column — and then it is
 * inferred exactly as `listProviders` would, so no path sends differently for
 * having skipped `connOptions()`.
 */
export function wireOf(o: { platform?: PlatformId; baseUrl: string; standard: ApiStandard }): ServerToolWire {
  return { platform: resolvePlatform(o.platform, o.baseUrl, o.standard), standard: o.standard };
}

/** {@link wireOf} for a provider row (`apiStandard` rather than `standard`). */
export function providerWire(p: { platform?: PlatformId; baseUrl: string; apiStandard: ApiStandard }): ServerToolWire {
  return wireOf({ platform: p.platform, baseUrl: p.baseUrl, standard: p.apiStandard });
}

/**
 * What a row stores for its platform: nothing when the address already says
 * it, so the row keeps following this table (a host added in a later build
 * reaches it with no migration, §4 rule 3); the value only when the author
 * chose something the address doesn't name (New API, a DashScope-shaped proxy).
 */
export function platformToStore(p: { platform?: PlatformId; baseUrl: string; apiStandard: ApiStandard }): PlatformId | undefined {
  if (!p.platform || !isCompatStandard(p.apiStandard)) return undefined;
  return p.platform === inferPlatform(p.baseUrl, p.apiStandard) ? undefined : p.platform;
}

/** What this platform knows about one of its model ids, or undefined — see {@link ModelCalibration}. */
export function platformModelCalibration(id: PlatformId, modelId: string): ModelCalibration | undefined {
  return PROFILES[id]?.models?.[modelId.trim().toLowerCase()];
}

/** Where a platform's entries were measured — for tests and the drawer's tooltip. */
export function platformSource(id: PlatformId): string {
  return PROFILES[id].source;
}

/** `include` entries a platform's Responses route must send — see {@link PlatformProfile.responsesInclude}. */
export function platformResponsesInclude(id: PlatformId): readonly string[] {
  return PROFILES[id]?.responsesInclude ?? [];
}

/** The routes a platform serves, primary first. */
export function platformEndpoints(id: PlatformId): readonly PlatformEndpoint[] {
  return PROFILES[id]?.endpoints ?? GENERIC_ENDPOINTS;
}

/** `scheme://host` of a platform's own server, or "" when the author types it. */
export function platformOrigin(id: PlatformId): string {
  return PROFILES[id]?.origin ?? "";
}

/**
 * The path a route takes when its row stores none (§5.1.1: `NULL` follows the
 * platform's convention). A family the platform does not list falls back to the
 * generic relay convention — a route an author added by hand on a platform that
 * never measured it.
 */
export function platformDefaultPath(id: PlatformId, family: ProtocolFamily): string {
  const own = platformEndpoints(id).find((e) => e.family === family);
  return (own ?? GENERIC_ENDPOINTS.find((e) => e.family === family))?.path ?? "";
}
