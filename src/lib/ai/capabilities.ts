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
 *   - {@link UPSTREAM_CAPABILITIES}: on a relay, what each upstream behind it
 *     was measured to do — the same cells, consulted before the relay's own
 *     when the model's upstream is known (`relayUpstream.ts` resolves it).
 *
 * Every asker — the adapters, the 将发送 summary, the drawers, the chat
 * surface — calls {@link capabilityVerdict} or {@link hasCapability} here
 * directly; there are no per-capability wrappers to drift apart (the tables
 * are exported for the tests that walk them). This file never imports
 * `platforms.ts` at runtime, so the two cannot form a cycle.
 */

import { familyOf, type ApiStandard, type ProtocolFamily } from "./types";
import type { ModelType } from "./configDb";
import type { PlatformId } from "./platforms";
import type { ServerToolId } from "./serverTools";
import type { ThinkingCategoryId } from "./reasoning";
import type { RelayUpstreamId } from "./relayUpstream";

/** What can be asked about. A server tool's id is a capability id. */
export type CapabilityId =
  | "pdfInput"
  | "vlHighResolution"
  | "videoInput"
  | "videoFps"
  | "forcedToolChoice"
  | "temperature"
  | "textVerbosity"
  | "instructionsField"
  | "translateFormat"
  | "structuredOutput"
  | "jsonSchema"
  | ServerToolId;

/**
 * How sure the app is.
 *
 *   - `yes`: the platform lists it (measured), or the protocol itself defines
 *     it and nothing says this platform differs.
 *   - `unknown`: plausible but unmeasured — a relay that may or may not pass
 *     the field on, or a model id the platform's list neither names nor
 *     rules out. Offered and sent; the drawer says so.
 *   - `no`: nothing to send. A declaration on the model row is kept and simply
 *     not sent (channel-model-route-plan §7 invariant 4).
 */
type CapabilityStatus = "yes" | "unknown" | "no";

/**
 * Why — a closed set so tests can assert it. The sentences live in the locale
 * files only, as `aiConfig.capReason.<reason>` in both languages (the same
 * split as `ThemeReasonCode`): a test can hold the reason, and the wording can
 * change without touching the logic. `capabilities.test.ts` holds every reason
 * to a sentence in each language.
 *
 *   - `measured`: the platform's table lists it for this family.
 *   - `protocol`: part of the protocol; no platform entry contradicts it.
 *   - `unmeasured`: the protocol defines it, but nobody measured whether this platform passes it on.
 *   - `relay`: a private field on a relay that may front the platform that owns it.
 *   - `platform-absent`: the platform's table says this wire does not take it (or takes and ignores it).
 *   - `platform-unlisted`: a private field, and this platform is not one that was measured taking it.
 *   - `family`: no spelling on this protocol family.
 *   - `model`: the platform runs it, but was measured refusing (or ignoring) it for this model id.
 *   - `model-unlisted`: the platform runs it for some model ids, and this one was never measured.
 *   - `model-type`: the model's type rules it out (a text model reads no frames).
 *   - `requires`: a capability it depends on is unavailable.
 *   - `thinking`: this family refuses it while the model thinks (Anthropic's temperature).
 *   - `upstream`: the relay's upstream behind this model was measured this way — either way,
 *     working or not (UPSTREAM_CAPABILITIES).
 */
export const CAPABILITY_REASONS = [
  "measured", "protocol", "unmeasured", "relay", "platform-absent", "platform-unlisted",
  "family", "model", "model-unlisted", "model-type", "requires", "thinking", "upstream",
] as const;
type CapabilityReason = (typeof CAPABILITY_REASONS)[number];

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
  /**
   * Families where it exists only while thinking is off — `no / thinking`
   * for any category but `off`. An absent category counts as thinking: every
   * family's default category thinks (`defaultCategoryId`), so a caller that
   * forgot to resolve it gets the safe answer, not a field the endpoint
   * refuses. Only an explicit `off` opens it.
   */
  thinkingOff?: readonly ProtocolFamily[];
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
  // Sampling temperature: every family spells it, but the Messages API accepts
  // `temperature: 1` and nothing else while extended thinking is on, and an
  // Anthropic model thinks unless the author declares otherwise. Clamping the
  // author's 0.2 up to the one legal value would send the opposite of what
  // they asked for under the name of honouring it, so the adapter omits it —
  // and the drawer, asking the same cell, never renders a control that does
  // nothing.
  temperature: { families: ["openai", "responses", "gemini", "anthropic"], origin: "native", thinkingOff: ["anthropic"] },
  // `text.verbosity` exists on the Responses family only.
  textVerbosity: { families: ["responses"], origin: "native" },
  // The system prompt as the top-level `instructions` field. Where the wire
  // does not take it, the adapter sends the same text as a leading `developer`
  // message instead. Not a declaration: no model row turns it on or off. A
  // relay upstream that appends its own text to `instructions` — the guarded
  // gateway behind one relay's `[Azure]` tier, which then refuses fiction
  // (landscape.md §7 第十七个样本) — is where this is `false`. The opposite
  // failure is why it defaults to `yes`: a Codex upstream that finds no
  // `instructions` injects 4.4K tokens of its own (第八个样本).
  instructionsField: { families: ["responses"], origin: "native" },
  // The Sakura translation engine (lib/translate) runs a Chat Completions
  // request with a fixed prompt; a text model only — a seeing model declared
  // translate-only would silently leave the vision subagent's candidates.
  translateFormat: { families: ["openai"], origin: "native", modelTypes: ["text"] },
  // A JSON mode at all (`response_format` / `text.format` /
  // `generationConfig.response*` / `output_config.format`). How strong is
  // jsonMode.ts's business; the Messages API has the schema tier and nothing
  // weaker, so an Anthropic model resolves to strict or off, never json_object.
  structuredOutput: { families: ["openai", "responses", "gemini", "anthropic"], origin: "native" },
  // The strict tier of it (`response_format.json_schema` / `text.format`
  // json_schema / `responseJsonSchema`). The protocol defines it, but a
  // platform may take it with a 200 and ignore it — 智谱 answers with prose in a
  // code fence (landscape.md §7 第十四个样本) — so a platform nobody measured is
  // `unknown`: an author's declaration is sent, the auto tier never lifts to
  // it (jsonMode.ts). A capability of the wire, not the model id: DashScope
  // serves GLM with json_schema working, 智谱 serves the same GLM ignoring it.
  jsonSchema: { families: ["openai", "responses", "gemini", "anthropic"], origin: "native", assumed: "unknown", requires: ["structuredOutput"] },
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
  "temperature", "textVerbosity", "instructionsField", "translateFormat", "structuredOutput", "jsonSchema",
  "web_search", "web_extractor", "web_search_image", "image_search", "code_interpreter",
];

/**
 * The ids that are endpoint-run tools. A `Record` so that a new
 * `ServerToolId` does not compile until it is listed — {@link hasAnyServerTool}
 * walks this, and an id it skipped would fold the drawer's section shut.
 */
const SERVER_TOOL_FLAGS: Record<ServerToolId, true> = {
  web_search: true, web_extractor: true, web_search_image: true, image_search: true, code_interpreter: true,
};
export const SERVER_TOOL_CAPABILITIES = Object.keys(SERVER_TOOL_FLAGS) as ServerToolId[];

/**
 * A model-id axis entry. `runs`: measured working for ids matching any
 * pattern. `refuses`: measured refused, or accepted and silently ignored — it
 * wins over `runs`. An id matching neither is `unknown / model-unlisted`:
 * offered and sent, the drawer saying it is unmeasured (capability-gating-plan
 * §8.7 — the platform has the tool, so a model the list hasn't caught up with
 * gets the switch rather than losing it).
 *
 * Without `runs` the matcher only singles ids out: an id `refuses` names is
 * `no / model`, and every other id — or a blank one — gets whatever the rule
 * gives this platform, as if the cell were absent — for a platform where one
 * family of ids was measured and the rest were not, which must not drag every
 * other model down to `model-unlisted` (§8.10). The relay's Kiro cells were
 * its first use; they moved to {@link UPSTREAM_CAPABILITIES} (§8.11), and no
 * cell uses the shape today. Kept for the next per-id finding on a platform.
 */
interface ModelMatcher {
  runs?: readonly RegExp[];
  refuses?: readonly RegExp[];
}

/**
 * One cell: `true` = measured working for every model on this wire, `false` =
 * measured absent (refused, or accepted and ignored), a matcher = per model id.
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
 * `runs` is deliberately anchored: `qwen3.5-omni-plus`, `qwen3-vl-plus`,
 * `qwen3.8-livetranslate-flash-realtime` share a prefix and are not in it.
 * `refuses` holds only what a sample saw fail — a 400, `Unsupported model`, or
 * (Chat Completions) a silent ignore. Everything else, including a generation
 * after 3.8, is `unknown`: the switch is offered and says it is unmeasured.
 * `runs` grows when the vendor's page adds a model to its list (plan §8.7);
 * where that page and a sample disagree, the sample wins.
 */
const DASHSCOPE_CODE_INTERPRETER: Record<"openai" | "responses", ModelMatcher> = {
  openai: {
    runs: [
      /^qwen3-max(?:-\d{4}-\d{2}-\d{2})?$/,
      new RegExp(`^qwen3\\.[5-7]-(?:plus|max|flash)${SNAPSHOT}$`),
      /^qwen3\.5-\d+b(?:-a\d+b)?$/,
    ],
    refuses: [
      // Silently ignored — the reason this wire is gated by id at all.
      /^qwen3-max-preview$/, /^qwen-max$/, /^qwen3\.5-omni-plus$/,
      // `does not support the code_interpreter tool` for flash, max and 27b alike.
      /^qwen3\.8-/,
    ],
  },
  responses: {
    runs: [
      /^qwen3-max(?:-\d{4}-\d{2}-\d{2})?$/,
      new RegExp(`^qwen3\\.[5-8]-(?:plus|max|flash)${SNAPSHOT}$`),
      /^qwen3\.(?:5|8)-[\d.]+[bt](?:-a\d+b)?$/,
      /^qwen3\.6-(?!27b$)\d+b(?:-a\d+b)?$/,
      /^deepseek-v4(?:\.\d+)?-(?:pro|flash)(?:-\d{4})?$/,
    ],
    refuses: [
      /^qwen3-max-preview$/, /^qwen3\.6-27b$/, /^qwen-plus$/, /^qwen3\.5-omni-plus$/,
      /^qwen3-vl-plus$/, /^qwen3-235b-a22b-thinking-2507$/,
    ],
  },
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
      // The platform's own list (Qwen 3.7 / 3.8), and GLM / DeepSeek / Kimi
      // strict on this host too (qianwen-compat-plan.md P7).
      jsonSchema: true,
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

/**
 * What an upstream behind a relay applies to, and what it was measured doing.
 * A relay has no host of its own and fronts several upstreams at once; the
 * same model id — `claude-opus-4-6` — behaves differently behind each, and the
 * upstream shows only in a prefix the relay's owner made up (`[CC量]`). So the
 * upstream is resolved from the author's data (`relayUpstream.ts`), and these
 * are the built-in facts about each one (capability-gating-plan §8.11).
 */
interface UpstreamCapabilities {
  /** The models the measurements cover. Any other id is treated as having no upstream. */
  models: RegExp;
  /**
   * Those models' family name as the drawer says it to the author ("only
   * measured with …"). A product name, the same in every language; held to
   * `models` by a test so the two cannot drift.
   */
  modelsLabel: string;
  /**
   * Plain `true` / `false` only: the upstream already narrows the models, and
   * a per-id matcher inside it would be a third axis nothing has measured.
   */
  families: Partial<Record<ProtocolFamily | "all", Partial<Record<CapabilityId, boolean>>>>;
}

/** The Kiro / CC / anti / Bedrock / official measurements are Claude's (第十五、十六个样本). */
const CLAUDE = /claude/;
/**
 * The Codex and gateway measurements are GPT-5.6's (第十七个样本) — widened to
 * every GPT on the same reasoning as Sonnet under Kiro: the gaps are between
 * the relay and the upstream, and the earlier samples on 5.4 / 5.5
 * (第八、十个样本) agree with them.
 */
const GPT = /gpt/;

/**
 * Each upstream's cells, measured on one New API relay (landscape.md §7
 * 第十五 and 第十六个样本, 2026-09-23, for Claude; 第十七个样本, 2026-09-24, for
 * GPT). Claude's are Chat Completions and Messages only — the relay serves it
 * on no other route (500 `convert_request_failed`); GPT's are Chat Completions
 * and Responses.
 * An absent cell falls to the relay's own cell and the rule, as it would
 * with no upstream — write only what a sample saw.
 */
export const UPSTREAM_CAPABILITIES: Record<RelayUpstreamId, UpstreamCapabilities> = {
  /**
   * Kiro (AWS's IDE backend, translated by the relay). Named by the upstream's
   * product, so relays spell it alike — `[特价kiro量]claude-opus-5`,
   * `特价kiro | claude-opus-4-6` — and an id containing it is inferred to be
   * Kiro. Measured on opus-4-6 and opus-5; Sonnet by inference, the gaps being
   * the translation layer's.
   *
   *   - Chat `file` part: dropped, the model answers that it sees no document.
   *   - A forced `tool_choice`, both wires: honoured on the relay's non-streamed
   *     path only. Streamed — the only way this app calls — the model answers
   *     in prose (Anth 1 call in 32, Chat 0 in 4; with thinking, 0 in 9 on the
   *     retest).
   *   - Chat `response_format`: ignored, prose with a fenced JSON block. Not
   *     Kiro's own: every upstream on that relay loses it in the relay's
   *     Chat→Messages conversion (第十六个样本). Kept here because it is what
   *     the Kiro rule decided before upstreams existed; it moves to the relay
   *     once a second New API sample says the conversion is the platform's.
   *   - Anthropic `web_search_*`: the relay answers it itself. As the request's
   *     only tool it hijacks the request — the first user message is searched
   *     verbatim and a canned result list comes back, no model run. This app
   *     sends the tool on tool-less requests too, so it stays off.
   */
  kiro: {
    models: CLAUDE, modelsLabel: "Claude",
    families: {
      openai: { pdfInput: false, forcedToolChoice: false, structuredOutput: false },
      anthropic: { forcedToolChoice: false, web_search: false },
    },
  },
  /**
   * A reverse proxy the closest to the official API (the relay's `[CC…]`;
   * presumably Claude Code's channel, unconfirmed). PDF on both wires, a real
   * web search (`server_tool_use` with a result block) that a writing request
   * does not trigger, a forced tool honoured without thinking. With adaptive
   * thinking a forced tool is called about half the time (3 in 8, 4 in 8) —
   * left to the rule on both wires, not `false`: the structured task's
   * fallback covers a missed call, and `false` would lose the calls that do
   * happen. Chat was probed without thinking only, so it says no more than
   * Messages does.
   */
  cc: {
    models: CLAUDE, modelsLabel: "Claude",
    families: {
      openai: { pdfInput: true },
      anthropic: { pdfInput: true, web_search: true },
    },
  },
  /**
   * A reverse proxy that drops most of the request (the relay's `[anti…]`;
   * presumably Antigravity, unconfirmed). A forced tool is never called on
   * either wire, streamed or not (1 in 21); the PDF and even a plain-text
   * `document` are dropped; a lone web search is dropped and the model answers
   * from memory. It also never thinks — no parameter turns it on — which is a
   * thinking-category fact, not a cell.
   */
  anti: {
    models: CLAUDE, modelsLabel: "Claude",
    families: {
      openai: { pdfInput: false, forcedToolChoice: false },
      anthropic: { forcedToolChoice: false, web_search: false },
    },
  },
  /**
   * AWS Bedrock, forwarded (message ids `msg_bdrk_…`). Validates like the
   * official API; PDF read on both wires, forced tools honoured with thinking
   * too. Bedrock has no Anthropic server tools at all: `web_search_*` is a 400
   * that fails the whole request, not just the tool.
   */
  bedrock: {
    models: CLAUDE, modelsLabel: "Claude",
    families: {
      openai: { pdfInput: true, forcedToolChoice: true },
      anthropic: { pdfInput: true, forcedToolChoice: true, web_search: false },
    },
  },
  /**
   * The official API behind a relay. Unmeasured — the relay's tier answered
   * 502 on every request the day the others were probed — so no cell: picking
   * it records that the prefix is classified and changes no verdict.
   */
  official: { models: CLAUDE, modelsLabel: "Claude", families: {} },
  /**
   * ChatGPT accounts behind a relay — the Codex backend (the relay's `[Plus]`,
   * `[Pro]`, `[特价Pro]` tiers on the 第十七个样本 relay; 第八、十个样本 are the
   * same kind). A real `web_search` (one search, a `url_citation`, 6–10 s),
   * verbosity honoured, PDF read, forced tools honoured on both wires. On
   * Responses a temperature is accepted and echoed back as 1 — ignored, so
   * `false`; Chat Completions shows no echo, so no cell there.
   *
   * No JSON-mode cell: the `[Pro]` tier dropped `text.format` and
   * `response_format` every time while `[Plus]` and `[特价Pro]` executed the
   * schema — one kind of upstream, two results, so the rule decides and the
   * drawer's note says it. Not measured as cells but told in the note: the
   * output cap is ignored, effort `none` still thinks, no image generation or
   * code interpreter.
   */
  codex: {
    models: GPT, modelsLabel: "GPT",
    families: {
      openai: { pdfInput: true, forcedToolChoice: true },
      responses: {
        pdfInput: true, forcedToolChoice: true, textVerbosity: true, web_search: true, temperature: false,
        // Measured both ways: with it, only the author's text; without it, 4.4K
        // tokens of Codex prompt injected (第八、十七个样本).
        instructionsField: true,
      },
    },
  },
  /**
   * A gateway the relay calls `[Azure]` (第十七个样本, measured on
   * gpt-5.6-terra: the tier had no line for sol). Parameters the closest to
   * the official API — the output cap holds, JSON schema executed on both
   * wires — but no web search (dropped silently), a temperature other than 1 a
   * 500 on Responses, a named `tool_choice` a 500 on Chat Completions (`required`
   * works, but the cell cannot split the two: the handoff forces a named tool,
   * so `false`, and a `required` request goes out as `auto` too). And it appends a guard to `instructions` telling the model to
   * refuse anything not about OpenAI, fiction included; without the field
   * there is no guard, so the system prompt goes as a `developer` message.
   */
  azure: {
    models: GPT, modelsLabel: "GPT",
    families: {
      openai: { pdfInput: true, forcedToolChoice: false, structuredOutput: true, jsonSchema: true },
      responses: {
        pdfInput: true, forcedToolChoice: true, textVerbosity: true, structuredOutput: true, jsonSchema: true,
        web_search: false, temperature: false, instructionsField: false,
      },
    },
  },
};

/**
 * `newapi` and `custom` alike: a New API relay lands on `custom` unless the
 * author picks New API. What differs is the upstream behind each model, which
 * {@link UPSTREAM_CAPABILITIES} answers. A cell here would hold for every
 * upstream; the relay's Chat→Messages conversion has two such gaps
 * (`response_format` dropped, `reasoning_effort: "max"` = no thinking), but one
 * New API was sampled, so they wait for a second
 * (docs/issues/relay-claude-channel-gating.md).
 */
const RELAY: PlatformCapabilities = { relay: true };

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
  openai: {
    families: {
      all: { jsonSchema: true },
      openai: { web_search: false },
      responses: { web_search: true },
    },
  },
  // `output_config.format`: GA per Anthropic; held a contradicted enum on five
  // Claude models behind OrcaRouter's verbatim Anthropic route (第十八个样本，补测).
  // `document` block: read end to end on sonnet-5 and opus-5.5 behind that same
  // verbatim route (第十八个样本「再补测」) — the reading is the model's, and the
  // vendor documents the block.
  anthropic: { families: { anthropic: { web_search: true, jsonSchema: true, pdfInput: true } } },
  // `responseJsonSchema`, Gemini 2.5 on (structured-output-plan.md).
  google: { families: { gemini: { jsonSchema: true } } },
  // Chat Completions: none. Its Anthropic-shaped path stays at the protocol's
  // `unknown` — unmeasured, not known absent.
  deepseek: { families: { openai: { web_search: false } } },
  dashscope: DASHSCOPE,
  "dashscope-intl": DASHSCOPE,
  // json_schema with `strict:true`: 200, output matches (第十一个样本).
  xai: { families: { responses: { web_search: true, jsonSchema: true } } },
  minimax: { families: { anthropic: { web_search: true } } },
  volcengine: {},
  // The one platform whose Anthropic `document` block was seen reaching the
  // model (landscape.md §7 第十二个样本).
  // json_schema: an enum the prompt contradicts held on 2.1-turbo — ① with
  // `strict:true`, ② on this app's `text.format` without it. The wire takes
  // it; 2.0-lite does not (both routes answered past the schema), which is
  // why `KNOWN_JSON_SCHEMA` lists 2.1 only (第十二个样本, 2026-09-23).
  "volcengine-plan": {
    families: {
      openai: { jsonSchema: true },
      responses: { web_search: true, jsonSchema: true },
      anthropic: { web_search: true, pdfInput: true },
    },
  },
  // Takes `tool_choice: "auto"` only: forcing is ignored on some models and
  // refused on others with an error that never names the parameter (第十四个样本).
  // json_schema: a 200 that ignores it — prose in a code fence, Chinese keys.
  zhipu: { families: { all: { forcedToolChoice: false, jsonSchema: false } } },
  // Every cell measured on paid models (landscape.md §7 第十八个样本): a strict
  // schema held against a prompt that contradicted its enum on ①②③④, and the
  // Responses built-in and Anthropic's versioned `web_search` both searched.
  // PDF: a one-page file's passphrase read back on all four; ①② need no cell.
  // Not the official `google` cell: ③ here is Vertex AI, not AI Studio.
  orcarouter: {
    families: {
      openai: { jsonSchema: true },
      responses: { jsonSchema: true, web_search: true },
      gemini: { jsonSchema: true, pdfInput: true },
      anthropic: { web_search: true, jsonSchema: true, pdfInput: true },
    },
  },
  newapi: RELAY,
  ollama: LOCAL,
  comfyui: LOCAL,
  custom: RELAY,
};

/** The wire a question is about — the same pair `platforms.ts` calls `ServerToolWire`. */
export interface CapabilityWire {
  platform: PlatformId;
  standard: ApiStandard;
}

/** What is known of the model. Every field optional: an absent one is not consulted. */
interface CapabilityModel {
  modelId?: string;
  type?: ModelType;
  /**
   * The *resolved* category (`resolveThinkingCategory`). Consulted only by a
   * `thinkingOff` rule, where absent reads as the family default — thinking.
   */
  thinkingCategory?: ThinkingCategoryId;
  /**
   * The relay upstream behind the model, already resolved
   * (`relayUpstream.ts` → `capabilityModelOf` / `resolveRelayUpstream`).
   * Consulted only on a relay platform, and only for the models its
   * measurements cover. Absent = no upstream.
   */
  upstream?: RelayUpstreamId;
}

const verdict = (status: CapabilityStatus, reason: CapabilityReason): CapabilityVerdict => ({ status, reason });

function cellFor(platform: PlatformId, family: ProtocolFamily, id: CapabilityId): CapabilityCell | undefined {
  const families = PLATFORM_CAPABILITIES[platform]?.families;
  return families?.[family]?.[id] ?? families?.all?.[id];
}

/** Whether an upstream's measurements cover this model id. A blank id is covered by none. */
export function upstreamApplies(upstream: RelayUpstreamId, modelId: string | undefined): boolean {
  const mid = modelId?.trim().toLowerCase();
  return !!mid && UPSTREAM_CAPABILITIES[upstream].models.test(mid);
}

function upstreamCellFor(
  platform: PlatformId, family: ProtocolFamily, id: CapabilityId, model: CapabilityModel,
): boolean | undefined {
  if (!model.upstream || !PLATFORM_CAPABILITIES[platform]?.relay) return undefined;
  if (!upstreamApplies(model.upstream, model.modelId)) return undefined;
  const families = UPSTREAM_CAPABILITIES[model.upstream].families;
  return families[family]?.[id] ?? families.all?.[id];
}

/**
 * The one answer. Order is fixed: model type → what it requires → thinking →
 * the relay upstream's cell → the platform's cell (a measurement wins) → the
 * rule's families → its default.
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
  if (rule.thinkingOff?.includes(family) && model.thinkingCategory !== "off") {
    return verdict("no", "thinking");
  }

  // Behind a relay the upstream is the more specific measurement: the relay's
  // own cells hold for whatever upstream a model has, these for one.
  const up = upstreamCellFor(platform, family, id, model);
  if (up === false) return verdict("no", "upstream");
  if (up === true) return verdict("yes", "upstream");

  const cell = cellFor(platform, family, id);
  if (cell === false) return verdict("no", "platform-absent");
  if (cell === true) return verdict("yes", "measured");
  if (cell) {
    // Blank = nothing typed yet: the axis is not consulted.
    const mid = model.modelId?.trim().toLowerCase();
    if (mid && cell.refuses?.some((re) => re.test(mid))) return verdict("no", "model");
    if (cell.runs) {
      if (!mid) return verdict("yes", "measured");
      return cell.runs.some((re) => re.test(mid)) ? verdict("yes", "measured") : verdict("unknown", "model-unlisted");
    }
    // A refuses-only matcher: the ids it does not name fall to the rule below.
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

/**
 * Whether this wire has any endpoint-run tool at all — the drawer's section gate.
 *
 * Asked of the **platform and family**, never of the standard alone. The
 * standard used to be the whole answer, and `openai_compat` quietly meant
 * "DashScope": every DeepSeek, New API, OrcaRouter or Ollama row could declare
 * 联网搜索 and sent DashScope's private `enable_search` to a server that had
 * never heard of it (docs/feature/channel-model-route-plan.md §1). Offering
 * the setting where the adapter would drop it is the failure this guards
 * against — a control that does nothing is worse than no control.
 */
export function hasAnyServerTool(wire: CapabilityWire): boolean {
  return SERVER_TOOL_CAPABILITIES.some((id) => hasCapability(id, wire));
}
