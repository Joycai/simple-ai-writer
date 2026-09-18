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
 * Every entry should point back at a measurement — the `source` field says
 * which one.
 */

import { familyOf, isCompatStandard, type ApiStandard, type AuthMode, type ProtocolFamily } from "./types";
import type { ServerToolId } from "./serverTools";

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
  | "orcarouter"
  | "newapi"
  | "ollama"
  | "comfyui"
  | "custom";

/** Selectable values, in the order the provider drawer lists them. */
export const PLATFORM_IDS: readonly PlatformId[] = [
  "openai", "anthropic", "google", "deepseek", "dashscope", "dashscope-intl", "xai",
  "minimax", "volcengine", "volcengine-plan", "orcarouter", "newapi", "ollama", "comfyui", "custom",
];

/**
 * How sure the app is that a server tool works on one platform's wire.
 *
 *   - `yes`: the platform lists it — measured, or the vendor's own tool on its
 *     own endpoint.
 *   - `unknown`: the protocol defines it and the platform relays that protocol,
 *     but nobody measured whether the relay passes it on. Offered (the author
 *     may take the risk — the same behaviour the Anthropic family has always
 *     had on relays), and said so in the drawer.
 *   - `no`: nothing to send. The declaration is kept on the model and simply
 *     not sent (plan §7 invariant 4).
 */
type ServerToolStatus = "yes" | "unknown" | "no";

interface ServerToolSpelling {
  id: ServerToolId;
  /** Model-id gate; absent = every model on this wire. */
  gate?: (modelId: string) => boolean;
}

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
   * Server tools this platform spells, per family. A family listed here
   * *replaces* the protocol-native list for it (so a platform can also narrow
   * one); a family not listed falls back to {@link NATIVE_SERVER_TOOLS} at
   * `unknown`.
   */
  serverTools?: Partial<Record<ProtocolFamily, readonly ServerToolSpelling[]>>;
  /**
   * Families whose wire reads a whole PDF (`readsPdf`), when not the default
   * Chat Completions + Responses. A platform lists the Anthropic family here
   * only after a sample showed its `document` block actually reaching the
   * model — most Anthropic-shaped relays swap it for a placeholder and answer
   * 200 (DeepSeek, landscape.md §2.1), which is the silent failure this gate
   * exists to keep the PDF subagent out of.
   */
  pdfFamilies?: readonly ProtocolFamily[];
  /** Where the entries above were measured. */
  source: string;
}

/**
 * What each protocol itself defines as an endpoint-run tool, independent of who
 * serves it: Anthropic's versioned `web_search_*` tool and the Responses
 * built-in `{type:"web_search"}`. Chat Completions and Gemini have none this
 * app spells — every server tool on Chat Completions is a platform's private
 * body field.
 */
const NATIVE_SERVER_TOOLS: Partial<Record<ProtocolFamily, readonly ServerToolSpelling[]>> = {
  anthropic: [{ id: "web_search" }],
  responses: [{ id: "web_search" }],
};

/** A released id's tail: nothing, a date stamp, a four-digit snapshot, or `-preview`. */
const SNAPSHOT = String.raw`(?:-(?:\d{4}-\d{2}-\d{2}|\d{4}|preview))?`;

/**
 * Which model ids run DashScope's code interpreter, per wire — the vendor's
 * list (developer-guides/tool-calling/code-interpreter) as id patterns,
 * corrected by a sweep over the live model list on 2026-09-17 (landscape.md §7
 * 第六个样本「代码解释器」).
 *
 *   - **Both wires**: `qwen3-max` and its dated snapshots (not
 *     `qwen3-max-preview` — refused on Responses, silently ignored on Chat
 *     Completions); the 3.5 / 3.6 / 3.7 generation's plus / max / flash; the
 *     3.5 open-weight models (`qwen3.5-397b-a17b`, `qwen3.5-27b`).
 *   - **Responses only**: the 3.8 generation (Chat Completions answers
 *     `does not support the code_interpreter tool` for qwen3.8-flash / -max /
 *     -27b), the 3.6 open-weight models except `qwen3.6-27b` (`Unsupported
 *     model`), and DeepSeek V4 as DashScope serves it.
 *
 * Deliberately anchored: `qwen3.5-omni-plus`, `qwen3-vl-plus`,
 * `qwen3.8-livetranslate-flash-realtime` share a prefix and none of them
 * takes the tool. A generation after 3.8 is not guessed at — a new family
 * earns its line here the way these did, by a measurement.
 */
const CODE_INTERPRETER_MODELS: Record<"openai" | "responses", readonly RegExp[]> = {
  openai: [
    /^qwen3-max(?:-\d{4}-\d{2}-\d{2})?$/,
    new RegExp(`^qwen3\\.[5-7]-(?:plus|max|flash)${SNAPSHOT}$`),
    /^qwen3\.5-\d+b(?:-a\d+b)?$/,
  ],
  responses: [
    /^qwen3-max(?:-\d{4}-\d{2}-\d{2})?$/,
    new RegExp(`^qwen3\\.[5-8]-(?:plus|max|flash)${SNAPSHOT}$`),
    /^qwen3\.(?:5|8)-[\d.]+[bt](?:-a\d+b)?$/,
    /^qwen3\.6-(?!27b$)\d+b(?:-a\d+b)?$/,
    /^deepseek-v4(?:\.\d+)?-(?:pro|flash)(?:-\d{4})?$/,
  ],
};

/** Whether `modelId` runs DashScope's code interpreter on this family's wire (see the table above). */
export function dashscopeRunsCodeInterpreter(family: ProtocolFamily, modelId: string): boolean {
  if (family !== "openai" && family !== "responses") return false;
  const id = modelId.trim().toLowerCase();
  return CODE_INTERPRETER_MODELS[family].some((re) => re.test(id));
}

/**
 * DashScope's private vocabulary, shared by the domestic and international
 * deployments. Measured on the domestic host; the international host serves the
 * same compatible-mode and `/responses` surfaces, and treating it the same is
 * what every row pointed at it has done so far — so this keeps behaviour.
 */
const DASHSCOPE_SERVER_TOOLS: Partial<Record<ProtocolFamily, readonly ServerToolSpelling[]>> = {
  // `enable_search` (+ `search_options.search_strategy: agent_max` for page
  // reading) and `enable_code_interpreter` — top-level body fields.
  openai: [
    { id: "web_search" },
    { id: "web_extractor" },
    { id: "code_interpreter", gate: (m) => dashscopeRunsCodeInterpreter("openai", m) },
  ],
  // Built-in `tools[]` entries; the two image searches exist on this wire only.
  responses: [
    { id: "web_search" },
    { id: "web_extractor" },
    { id: "web_search_image" },
    { id: "image_search" },
    { id: "code_interpreter", gate: (m) => dashscopeRunsCodeInterpreter("responses", m) },
  ],
};

const PROFILES: Record<PlatformId, PlatformProfile> = {
  openai: {
    origin: "https://api.openai.com",
    endpoints: [{ family: "openai", path: "", official: true }, { family: "responses", path: "", official: true }],
    hosts: ["api.openai.com"],
    // Chat Completions: none (official rejects unknown top-level fields).
    serverTools: { openai: [], responses: [{ id: "web_search" }] },
    source: "docs/api/responses.md §10 (GPT-5.6, 2026-09-14)",
  },
  anthropic: {
    origin: "https://api.anthropic.com",
    endpoints: [{ family: "anthropic", path: "", official: true }],
    hosts: ["api.anthropic.com"],
    serverTools: { anthropic: [{ id: "web_search" }] },
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
    // Chat Completions: none (no native tool, no private field). Its
    // Anthropic-shaped path falls back to the protocol's own web_search at
    // "unknown" — unmeasured, not known absent.
    serverTools: { openai: [] },
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
    serverTools: DASHSCOPE_SERVER_TOOLS,
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
    serverTools: DASHSCOPE_SERVER_TOOLS,
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
    // web_search measured on grok-4.3; web_extractor and the image searches
    // are DashScope's names and are refused.
    serverTools: { responses: [{ id: "web_search" }] },
    source: "landscape.md §7 第十一个样本 (2026-09-14)",
  },
  minimax: {
    origin: "https://api.minimaxi.com",
    endpoints: [
      { family: "openai", path: "" },
      { family: "anthropic", path: "/anthropic" },
    ],
    hosts: ["api.minimaxi.com", "api.minimax.io"],
    serverTools: { anthropic: [{ id: "web_search" }] },
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
    serverTools: { openai: [] },
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
    serverTools: { openai: [], responses: [{ id: "web_search" }], anthropic: [{ id: "web_search" }] },
    // A base64 `document` block was read (the secret word came back) — the
    // one Anthropic-shaped wire measured to do so.
    pdfFamilies: ["openai", "responses", "anthropic"],
    source: "landscape.md §7 第十二个样本 (2026-09-18)",
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
    source: "landscape.md §7 New API 样本 — relay; protocol-native tools depend on the upstream",
  },
  ollama: {
    origin: "http://localhost:11434",
    endpoints: [{ family: "openai", path: "/v1" }],
    hosts: ["localhost:11434", "127.0.0.1:11434"],
    // A local server runs no tools of its own on any wire — say so rather
    // than inherit the protocol-native search at "unknown".
    serverTools: { openai: [], responses: [], anthropic: [] },
    source: "local server; no server tools",
  },
  comfyui: {
    origin: "http://127.0.0.1:8188",
    endpoints: [{ family: "openai", path: "" }],
    hosts: ["localhost:8188", "127.0.0.1:8188"],
    serverTools: { openai: [], responses: [], anthropic: [] },
    source: "local render server; reached through caps.route, not a chat wire",
  },
  custom: {
    endpoints: GENERIC_ENDPOINTS,
    hosts: [],
    source: "protocol vocabulary only",
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
  // current platform's host says nothing against the current pick.
  if (inferred !== "custom") return sharesBareHost(current, baseUrl) ? current : inferred;
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

/** The spellings one wire has, before any model gate. */
function spellings(wire: ServerToolWire): readonly ServerToolSpelling[] {
  const family = familyOf(wire.standard);
  return PROFILES[wire.platform]?.serverTools?.[family] ?? NATIVE_SERVER_TOOLS[family] ?? [];
}

/**
 * Whether one id can be said on this wire — and, given a model id, whether
 * that model takes it. Omitting `modelId` answers for the wire alone (the
 * gate is not consulted).
 */
export function serverToolStatus(wire: ServerToolWire, id: ServerToolId, modelId?: string): ServerToolStatus {
  const family = familyOf(wire.standard);
  const listed = PROFILES[wire.platform]?.serverTools?.[family];
  const spelling = (listed ?? NATIVE_SERVER_TOOLS[family] ?? []).find((s) => s.id === id);
  if (!spelling) return "no";
  if (modelId !== undefined && spelling.gate && !spelling.gate(modelId)) return "no";
  return listed ? "yes" : "unknown";
}

/** Whether this wire has any server tool at all — the drawer's section gate. */
export function wireHasServerTools(wire: ServerToolWire): boolean {
  return spellings(wire).length > 0;
}

const PDF_FAMILIES: readonly ProtocolFamily[] = ["openai", "responses"];

/**
 * Whether this wire hands a whole PDF to the model: Chat Completions' `file`
 * part and Responses' `input_file` everywhere, plus the families a platform
 * measured beyond that (`pdfFamilies`).
 */
export function wireReadsPdf(wire: ServerToolWire): boolean {
  return (PROFILES[wire.platform]?.pdfFamilies ?? PDF_FAMILIES).includes(familyOf(wire.standard));
}

/** Where a platform's entries were measured — for tests and the drawer's tooltip. */
export function platformSource(id: PlatformId): string {
  return PROFILES[id].source;
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
