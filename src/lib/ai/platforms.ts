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

import { familyOf, isCompatStandard, type ApiStandard, type ProtocolFamily } from "./types";
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
  | "orcarouter"
  | "newapi"
  | "ollama"
  | "comfyui"
  | "custom";

/** Selectable values, in the order the provider drawer lists them. */
export const PLATFORM_IDS: readonly PlatformId[] = [
  "openai", "anthropic", "google", "deepseek", "dashscope", "dashscope-intl", "xai",
  "minimax", "orcarouter", "newapi", "ollama", "comfyui", "custom",
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

interface PlatformProfile {
  /**
   * Hosts that identify the platform when a row carries no `platform` yet
   * (every row saved before the column existed). Lower-case, `host[:port]`.
   */
  hosts: readonly string[];
  /**
   * Server tools this platform spells, per family. A family listed here
   * *replaces* the protocol-native list for it (so a platform can also narrow
   * one); a family not listed falls back to {@link NATIVE_SERVER_TOOLS} at
   * `unknown`.
   */
  serverTools?: Partial<Record<ProtocolFamily, readonly ServerToolSpelling[]>>;
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
    hosts: ["api.openai.com"],
    // Chat Completions: none (official rejects unknown top-level fields).
    serverTools: { openai: [], responses: [{ id: "web_search" }] },
    source: "docs/api/responses.md §10 (GPT-5.6, 2026-09-14)",
  },
  anthropic: {
    hosts: ["api.anthropic.com"],
    serverTools: { anthropic: [{ id: "web_search" }] },
    source: "Anthropic's own versioned web_search tool",
  },
  google: {
    hosts: ["generativelanguage.googleapis.com"],
    source: "no server tool spelled on the Gemini wire",
  },
  deepseek: {
    hosts: ["api.deepseek.com"],
    source: "landscape.md §2.1 — no server tools on the official endpoint",
  },
  dashscope: {
    hosts: ["dashscope.aliyuncs.com"],
    serverTools: DASHSCOPE_SERVER_TOOLS,
    source: "landscape.md §7 第六个样本 (联网搜索与网页抓取 2026-09-14 · 代码解释器 2026-09-17)",
  },
  "dashscope-intl": {
    hosts: ["dashscope-intl.aliyuncs.com"],
    serverTools: DASHSCOPE_SERVER_TOOLS,
    source: "landscape.md §7 第六个样本, same surfaces as the domestic host",
  },
  xai: {
    hosts: ["api.x.ai"],
    // web_search measured on grok-4.3; web_extractor and the image searches
    // are DashScope's names and are refused.
    serverTools: { responses: [{ id: "web_search" }] },
    source: "landscape.md §7 第十一个样本 (2026-09-14)",
  },
  minimax: {
    hosts: ["api.minimaxi.com", "api.minimax.io"],
    serverTools: { anthropic: [{ id: "web_search" }] },
    source: "landscape.md §7 第四个样本",
  },
  orcarouter: {
    hosts: ["api.orcarouter.ai"],
    source: "landscape.md §7 第七个样本 — relay; protocol-native tools unmeasured",
  },
  newapi: {
    hosts: [],
    source: "landscape.md §7 New API 样本 — relay; protocol-native tools depend on the upstream",
  },
  ollama: {
    hosts: ["localhost:11434", "127.0.0.1:11434"],
    source: "local server; no server tools",
  },
  comfyui: {
    hosts: ["localhost:8188", "127.0.0.1:8188"],
    source: "local render server; reached through caps.route, not a chat wire",
  },
  custom: {
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
  const host = hostOf(baseUrl);
  if (!host) return "custom";
  for (const id of PLATFORM_IDS) {
    // `URL.host` already drops a scheme's default port, so an explicit `:443`
    // compares equal to the bare host.
    if (PROFILES[id].hosts.includes(host)) return id;
  }
  return "custom";
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
  if (!isCompatStandard(standard) || inferred !== "custom") return inferred;
  return platformHasHosts(current) ? "custom" : current;
}

/** Lower-case `host[:port]` of a URL, or "" when it doesn't parse. */
function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host.toLowerCase();
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

/** Where a platform's entries were measured — for tests and the drawer's tooltip. */
export function platformSource(id: PlatformId): string {
  return PROFILES[id].source;
}
