/**
 * Capability gating — one table, one verdict.
 *
 * "Can this model do X on this wire" used to be answered once per asker (the
 * model drawer, the adapter, the 将发送 summary, the chat surface), each with
 * its own function and its own idea of which layer decides. A platform's
 * private field gated by protocol family — DashScope's
 * `vl_high_resolution_images` showing up on 智谱 — is what that shape
 * produces. Plan and reasoning: docs/api/capability-gating-plan.md.
 *
 * Two tables, both data:
 *
 *   - {@link CAPABILITY_RULES}: what the *protocol* says about a capability —
 *     which families spell it at all, and what to assume of a platform that
 *     has said nothing.
 *   - {@link PLATFORM_CAPABILITIES}: what each *platform* was measured to do,
 *     keyed platform × family × capability, with an optional model-id matcher
 *     as the third axis. Endpoint-run tools live here too: which tool a wire
 *     runs is a fact about the platform and the model id, like any other.
 *
 * {@link familyVerdict} is the only reader in the app (the tables are exported
 * for the tests that walk them). This file never imports `platforms.ts` at
 * runtime — that file delegates here — so the two cannot form a cycle.
 */

import { familyOf, type ApiStandard, type ProtocolFamily } from "./types";
import type { ModelType } from "./configDb";
import type { PlatformId } from "./platforms";
import type { ServerToolId } from "./serverTools";

/** What can be asked about. A server tool's id is a capability id. */
export type CapabilityId =
  | "pdfInput"
  | "vlHighResolution"
  | "videoInput"
  | "videoFps"
  | "forcedToolChoice"
  | ServerToolId;

/**
 * How sure the app is.
 *
 *   - `yes`: the platform lists it (measured), or the protocol itself defines
 *     it and nothing says this platform differs.
 *   - `unknown`: plausible but unmeasured — a relay that may or may not pass
 *     the field on. Offered and sent; the drawer says so.
 *   - `no`: nothing to send. A declaration on the model row is kept and simply
 *     not sent (channel-model-route-plan §7 invariant 4).
 */
export type CapabilityStatus = "yes" | "unknown" | "no";

/** Why — a closed set so tests can assert it; the sentences live in the locale files. */
type CapabilityReason =
  /** The platform's table lists it for this family. */
  | "measured"
  /** Part of the protocol; no platform entry contradicts it. */
  | "protocol"
  /** The protocol defines it, but nobody measured whether this platform passes it on. */
  | "unmeasured"
  /** A private field on a relay that may front the platform that owns it. */
  | "relay"
  /** The platform's table says this wire does not take it (or takes and ignores it). */
  | "platform-absent"
  /** A private field, and this platform is not one that was measured taking it. */
  | "platform-unlisted"
  /** No spelling on this protocol family. */
  | "family"
  /** The platform runs it, but not for this model id. */
  | "model"
  /** The model's type rules it out (a text model reads no frames). */
  | "model-type"
  /** A capability it depends on is unavailable. */
  | "requires";

interface CapabilityVerdict {
  status: CapabilityStatus;
  reason: CapabilityReason;
}

interface CapabilityRule {
  /**
   * Families where the rule's own default applies: for a `native` capability,
   * where the protocol defines it; for a `private` one, where a relay may be
   * passing it on. A platform cell can name a family beyond these (DashScope's
   * `enable_search` on Chat Completions, 火山方舟 Plan's Anthropic `document`
   * block) — a cell is a measurement and always wins.
   */
  families: readonly ProtocolFamily[];
  /**
   * `native`: part of the protocol — a platform that says nothing gets
   * `assumed`. `private`: one vendor's own field — a platform that says
   * nothing gets `no`, so a new private field cannot leak to a platform
   * nobody measured it on. That default is the point of this table.
   */
  origin: "native" | "private";
  /** `native` only: the status on a platform with no entry. Absent = `yes`. */
  assumed?: "yes" | "unknown";
  /**
   * `private` only: what a relay (a platform with no host of its own, which
   * may front the owner) gets. Absent = `no`.
   */
  relay?: "unknown";
  /** Model types that can have it at all; absent = any. */
  modelTypes?: readonly ModelType[];
  /** Capabilities that must not be `no` on the same wire. */
  requires?: readonly CapabilityId[];
}

const SEES_IMAGES: readonly ModelType[] = ["multimodal", "vision"];

/**
 * The protocol's side. `Record<CapabilityId, …>` on purpose: a new capability
 * id does not compile until it has a row here.
 */
export const CAPABILITY_RULES: Record<CapabilityId, CapabilityRule> = {
  // Chat Completions' `file` part and Responses' `input_file`. Anthropic's
  // `document` block is left out on purpose: most Anthropic-shaped relays swap
  // it for a placeholder and answer 200 (landscape.md §2.1), so that family is
  // a platform cell, written only after a sample saw it reach the model.
  pdfInput: { families: ["openai", "responses"], origin: "native" },
  // DashScope's body field `vl_high_resolution_images` and a clip part's `fps`.
  // 智谱 takes both with a 200 and bills the same tokens either way
  // (landscape.md §7 第十四个样本). A relay may front DashScope.
  vlHighResolution: { families: ["openai"], origin: "private", relay: "unknown", modelTypes: SEES_IMAGES },
  // A `video_url` part: Chat Completions only (lib/ai/videoInput). Still
  // family-wide — per-platform gating is shelved until measured (plan C4).
  videoInput: { families: ["openai"], origin: "native", modelTypes: SEES_IMAGES },
  videoFps: { families: ["openai"], origin: "private", relay: "unknown", modelTypes: SEES_IMAGES, requires: ["videoInput"] },
  // `tool_choice: required | {function}` being honoured.
  forcedToolChoice: { families: ["openai", "responses", "gemini", "anthropic"], origin: "native" },
  // Anthropic's versioned `web_search_*` tool and the Responses built-in
  // `{type:"web_search"}` are the protocol's own; whether a relay passes them
  // on is unmeasured until a platform cell says so. Chat Completions has no
  // native server tool — every one there is a platform's private body field.
  web_search: { families: ["responses", "anthropic"], origin: "native", assumed: "unknown" },
  // DashScope's names. Refused outright elsewhere (xAI, 第十一个样本), and a
  // relay that fronts DashScope is set to that platform explicitly.
  web_extractor: { families: ["openai", "responses"], origin: "private" },
  web_search_image: { families: ["responses"], origin: "private" },
  image_search: { families: ["responses"], origin: "private" },
  code_interpreter: { families: ["openai", "responses"], origin: "private" },
};

/**
 * Every id, in the order the generated matrix lists them. Spelled out rather
 * than read off the object's keys so that tidying the table above cannot
 * reshuffle docs/api/capability-matrix.md and bury the one cell that moved;
 * `capabilities.test.ts` holds it complete.
 */
export const CAPABILITY_IDS: readonly CapabilityId[] = [
  "pdfInput", "vlHighResolution", "videoInput", "videoFps", "forcedToolChoice",
  "web_search", "web_extractor", "web_search_image", "image_search", "code_interpreter",
];

/**
 * The ids that are endpoint-run tools. A `Record` so that a new
 * `ServerToolId` does not compile until it is listed — `wireHasServerTools`
 * walks this, and an id it skipped would fold the drawer's section shut.
 */
const SERVER_TOOL_FLAGS: Record<ServerToolId, true> = {
  web_search: true, web_extractor: true, web_search_image: true, image_search: true, code_interpreter: true,
};
export const SERVER_TOOL_CAPABILITIES = Object.keys(SERVER_TOOL_FLAGS) as ServerToolId[];

/** A model-id axis entry: the platform runs it for ids matching any pattern. */
type ModelMatcher = readonly RegExp[];

/**
 * One cell: `true` = measured working for every model on this wire, `false` =
 * measured absent (refused, or accepted and ignored), a matcher = working for
 * the model ids it names.
 */
type CapabilityCell = boolean | ModelMatcher;

type FamilyCapabilities = Partial<Record<CapabilityId, CapabilityCell>>;

interface PlatformCapabilities {
  /**
   * No host of its own — the author types the address, and whatever is behind
   * it may be any of the platforms above. Private fields marked `relay` are
   * offered at `unknown` here.
   */
  relay?: true;
  /** `all` applies to every family and is overridden by a family's own entry. */
  families?: Partial<Record<ProtocolFamily | "all", FamilyCapabilities>>;
}

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
const DASHSCOPE_CODE_INTERPRETER: Record<"openai" | "responses", ModelMatcher> = {
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

/**
 * DashScope's private vocabulary, shared by the domestic and international
 * deployments. Measured on the domestic host; the international host serves the
 * same compatible-mode and `/responses` surfaces.
 */
const DASHSCOPE: PlatformCapabilities = {
  families: {
    // `enable_search` (+ `search_options.search_strategy: agent_max` for page
    // reading) and `enable_code_interpreter` — top-level body fields.
    openai: {
      web_search: true,
      web_extractor: true,
      code_interpreter: DASHSCOPE_CODE_INTERPRETER.openai,
      vlHighResolution: true,
      videoFps: true,
    },
    // Built-in `tools[]` entries; the two image searches exist on this wire only.
    responses: {
      web_search: true,
      web_extractor: true,
      web_search_image: true,
      image_search: true,
      code_interpreter: DASHSCOPE_CODE_INTERPRETER.responses,
    },
  },
};

/** A local server: the protocol's own tools are known absent, not unmeasured. */
const LOCAL: PlatformCapabilities = {
  families: { all: { web_search: false } },
};

/**
 * The platforms' side — only what a sample measured. Where each entry comes
 * from is the platform's `source` line in `platforms.ts`.
 *
 * An absent cell is not "no": it falls to {@link CAPABILITY_RULES} (protocol
 * default for a native capability, `no` for a private one). Write `false` only
 * for something measured absent.
 */
export const PLATFORM_CAPABILITIES: Record<PlatformId, PlatformCapabilities> = {
  // Chat Completions: no server tool (official rejects unknown top-level fields).
  openai: { families: { openai: { web_search: false }, responses: { web_search: true } } },
  anthropic: { families: { anthropic: { web_search: true } } },
  google: {},
  // Chat Completions: none. Its Anthropic-shaped path stays at the protocol's
  // `unknown` — unmeasured, not known absent.
  deepseek: { families: { openai: { web_search: false } } },
  dashscope: DASHSCOPE,
  "dashscope-intl": DASHSCOPE,
  xai: { families: { responses: { web_search: true } } },
  minimax: { families: { anthropic: { web_search: true } } },
  volcengine: {},
  // The one platform whose Anthropic `document` block was seen reaching the
  // model (landscape.md §7 第十二个样本).
  "volcengine-plan": {
    families: {
      responses: { web_search: true },
      anthropic: { web_search: true, pdfInput: true },
    },
  },
  // Takes `tool_choice: "auto"` only: forcing is ignored on some models and
  // refused on others with an error that never names the parameter (第十四个样本).
  zhipu: { families: { all: { forcedToolChoice: false } } },
  orcarouter: {},
  newapi: { relay: true },
  ollama: LOCAL,
  comfyui: LOCAL,
  custom: { relay: true },
};

/** The wire a question is about — the same pair `platforms.ts` calls `ServerToolWire`. */
interface CapabilityWire {
  platform: PlatformId;
  standard: ApiStandard;
}

/** What is known of the model. Every field optional: an absent one is not consulted. */
interface CapabilityModel {
  modelId?: string;
  type?: ModelType;
}

const verdict = (status: CapabilityStatus, reason: CapabilityReason): CapabilityVerdict => ({ status, reason });

function cellFor(platform: PlatformId, family: ProtocolFamily, id: CapabilityId): CapabilityCell | undefined {
  const families = PLATFORM_CAPABILITIES[platform]?.families;
  return families?.[family]?.[id] ?? families?.all?.[id];
}

/**
 * The one answer. Order is fixed: model type → what it requires → the
 * platform's cell (a measurement wins) → the rule's families → its default.
 */
export function capabilityVerdict(id: CapabilityId, wire: CapabilityWire, model: CapabilityModel = {}): CapabilityVerdict {
  return familyVerdict(id, wire.platform, familyOf(wire.standard), model);
}

/** {@link capabilityVerdict} for a caller that already holds the family. */
export function familyVerdict(id: CapabilityId, platform: PlatformId, family: ProtocolFamily, model: CapabilityModel = {}): CapabilityVerdict {
  const rule = CAPABILITY_RULES[id];
  if (model.type && rule.modelTypes && !rule.modelTypes.includes(model.type)) return verdict("no", "model-type");
  for (const dep of rule.requires ?? []) {
    if (familyVerdict(dep, platform, family, model).status === "no") return verdict("no", "requires");
  }

  const cell = cellFor(platform, family, id);
  if (cell === false) return verdict("no", "platform-absent");
  if (cell === true) return verdict("yes", "measured");
  if (cell) {
    if (model.modelId === undefined) return verdict("yes", "measured");
    const mid = model.modelId.trim().toLowerCase();
    return cell.some((re) => re.test(mid)) ? verdict("yes", "measured") : verdict("no", "model");
  }

  if (!rule.families.includes(family)) return verdict("no", "family");
  if (rule.origin === "private") {
    return rule.relay && PLATFORM_CAPABILITIES[platform]?.relay
      ? verdict(rule.relay, "relay")
      : verdict("no", "platform-unlisted");
  }
  return rule.assumed === "unknown" ? verdict("unknown", "unmeasured") : verdict("yes", "protocol");
}

/** Whether the wire has it — `unknown` counts: it is offered and sent. */
export function hasCapability(id: CapabilityId, wire: CapabilityWire, model?: CapabilityModel): boolean {
  return capabilityVerdict(id, wire, model).status !== "no";
}
