/**
 * What each platform was measured to do, keyed platform × protocol family ×
 * capability, with an optional model-id matcher as the third axis. Where each
 * entry comes from is the platform's `source` line in `platforms.ts`.
 */

import type { ProtocolFamily } from "../../types";
import type { PlatformId } from "../../platforms";
import type { CapabilityId } from "../facts";

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
export type CapabilityCell = boolean | ModelMatcher;

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
  // `effortWithTools`: from GPT-5.4 on (OpenAI's own words, reached through
  // OrcaRouter's verbatim route — 第十八个样本「GPT 全家补测」; responses.md §7).
  openai: {
    families: {
      all: { jsonSchema: true },
      openai: { web_search: false, effortWithTools: { refuses: [/^gpt-5\.[4-9](?:[.-]|$)/] } },
      // `temperature`: gpt-5.6-sol's Responses refuses it outright (`Unsupported
      // parameter: 'temperature' is not supported with this model.`) — the same
      // OpenAI body OrcaRouter hands back verbatim (GPT 全家补测).
      responses: { web_search: true, temperature: { refuses: [/^gpt-5\.6-sol$/] } },
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
  // The first platform whose Anthropic `document` block was seen reaching the
  // model (landscape.md §7 第十二个样本); Anthropic's own and OrcaRouter's
  // verbatim route followed (第十八个样本「再补测」).
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
  // ③'s three built-in tools, beside function tools, forced calls and a
  // response schema alike (再补测). The GPT ids (GPT 全家补测): gpt-5.6-sol is
  // served by OpenAI's own Chat Completions and refuses tools beside any effort
  // (gpt-5.6-luna is rerouted and was not); gpt-6-astra refuses `none` on both;
  // gpt-5.6-sol's Responses refuses any temperature (its Chat takes one), and
  // its Chat refuses `max` and `minimal` (its Responses takes `max`).
  // gpt-5.6-luna's temperature is rerouted to the translating layer and echoed.
  orcarouter: {
    families: {
      openai: {
        jsonSchema: true,
        effortWithTools: { refuses: [/^openai\/gpt-5\.6-sol$/] },
        reasoningOff: { refuses: [/^openai\/gpt-6-astra$/] },
        effortMax: { refuses: [/^openai\/gpt-5\.6-sol$/] },
        effortMinimal: { refuses: [/^openai\/gpt-5\.6-sol$/] },
      },
      responses: {
        jsonSchema: true,
        web_search: true,
        reasoningOff: { refuses: [/^openai\/gpt-6-astra$/] },
        temperature: { refuses: [/^openai\/gpt-5\.6-sol$/] },
      },
      gemini: { jsonSchema: true, pdfInput: true, web_search: true, web_extractor: true, code_interpreter: true },
      anthropic: { web_search: true, jsonSchema: true, pdfInput: true },
    },
  },
  newapi: RELAY,
  ollama: LOCAL,
  comfyui: LOCAL,
  custom: RELAY,
};
