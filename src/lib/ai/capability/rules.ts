/**
 * The protocol's side of every capability: which families spell it at all,
 * and what to assume of a platform that has said nothing. Measurements per
 * platform are in `cells/platform.ts`, per relay upstream in `cells/upstream.ts`.
 */

import type { ProtocolFamily } from "../types";
import type { ModelType } from "../configDb";
import type { CapabilityId } from "./facts";
import type { Condition } from "./conditions";

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
   * Conditions of the request under which it is `no` on a family, whatever
   * the cells say (`conditions.ts`). A verdict asked without the request's
   * input answers per the condition's `absent`. Ruled out by a condition, the
   * reason is `condition` — `thinking` for `temperatureIgnored`, the reason
   * the drawer has always shown for it.
   */
  unless?: Partial<Record<ProtocolFamily, readonly Condition[]>>;
  /**
   * `yes` on a vendor's **official** standard, before the `origin` default: a
   * field the vendor's own endpoint documents and a compatible one may not
   * implement. The compat half still takes `origin`'s answer until a platform
   * cell says otherwise. Keyed on the standard, not the platform: an
   * `anthropic_compat` channel at api.anthropic.com resolves to the same
   * platform as the official one.
   */
  official?: "yes";
}

const SEES_IMAGES: readonly ModelType[] = ["multimodal", "vision"];

const TEMPERATURE_IGNORED: Condition = { when: "temperatureIgnored", absent: "fire" };
const WITH_FUNCTION_TOOLS: Condition = { when: "functionTools", absent: "defer" };

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
  // A thinking effort beside function tools. The protocol has both, but
  // OpenAI's own Chat Completions refuses the pair from GPT-5.4 on unless the
  // effort is `none` — and the model's default is not `none`, so a request
  // that sends no effort at all is refused too (landscape.md §7 第十八个样本
  // 「GPT 全家补测」, the error in OpenAI's words). Where this is `no` the Chat
  // adapter sends `reasoning_effort: "none"` on every request that carries
  // tools (`effortOnWire`). Responses takes the pair everywhere.
  effortWithTools: { families: ["openai", "responses"], origin: "native" },
  // The effort ladder's `none` — what the 关闭 chip sends on the two OpenAI
  // wires. A model that refuses it has no off: the chip is not offered
  // (`effortMenuOnWire`), and an `off` already stored on the row, or forced by
  // the agent's thinking fallback, goes out as the lowest level instead.
  // Not left to the endpoint's 400 the way other out-of-range levels are
  // (reasoning.ts `responses-effort`): that rule rests on the 400 naming the
  // legal values, and the one gateway where this was measured swallows the
  // reason (第十八个样本「GPT 全家补测」).
  reasoningOff: { families: ["openai", "responses"], origin: "native" },
  // The ladder's two ends past `high`/`low`: `max` and `minimal`. Same reason
  // as `reasoningOff` for not leaving them to the 400 — the one refusal
  // measured came through a gateway that swallows the reason. Where `no`, the
  // dials drop the level (`effortMenuOnWire`) and a stored one goes out as the
  // nearest level the model takes: `max` → `xhigh`, `minimal` → `low`
  // (`effortOnWire`; capability-gating-plan.md §8.15).
  effortMax: { families: ["openai", "responses"], origin: "native" },
  effortMinimal: { families: ["openai", "responses"], origin: "native" },
  // Sampling temperature: every family spells it, but the Messages API accepts
  // `temperature: 1` and nothing else while extended thinking is on, and an
  // Anthropic model thinks unless the author declares otherwise. Clamping the
  // author's 0.2 up to the one legal value would send the opposite of what
  // they asked for under the name of honouring it, so the adapter omits it —
  // and the drawer, asking the same cell, never renders a control that does
  // nothing. Where an Anthropic-shaped endpoint was measured heeding it with
  // thinking switched off, the category says so (`temperatureWhenOff`).
  temperature: {
    families: ["openai", "responses", "gemini", "anthropic"], origin: "native", unless: { anthropic: [TEMPERATURE_IGNORED] },
  },
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
  // The tier below it: "any JSON object" (`response_format: json_object` /
  // `text.format` json_object / `responseMimeType`). The Messages API has the
  // schema tier and nothing weaker, so an Anthropic model's only JSON mode is
  // strict — asked without a schema, or capped below it, it gets the cue alone.
  jsonObjectTier: { families: ["openai", "responses", "gemini"], origin: "native", requires: ["structuredOutput"] },
  // Explicit `cache_control` breakpoints on the system prompt and the toolset
  // (anthropic.ts). The official endpoint documents them; a compatible one is
  // `no` until measured — MiniMax documents `cache_control` on `system` but
  // says nothing about `tools`, and a rejected field costs a whole failed round
  // at the start of a stream (agent-tool-context-lld.md §2.3 says what to
  // measure first). The other families cache long prefixes on their own.
  promptCache: { families: ["anthropic"], origin: "private", official: "yes" },
  // Anthropic's versioned `web_search_*` tool, the Responses built-in
  // `{type:"web_search"}` and Gemini's `googleSearch` are the protocol's own;
  // whether a relay passes them on is unmeasured until a platform cell says so.
  // Chat Completions has no native server tool — every one there is a
  // platform's private body field.
  web_search: { families: ["responses", "anthropic", "gemini"], origin: "native", assumed: "unknown" },
  // DashScope's names on the OpenAI wires — refused outright elsewhere (xAI,
  // 第十一个样本), and a relay that fronts DashScope is set to that platform
  // explicitly. On Gemini they are `urlContext` / `codeExecution`, the
  // protocol's own tools; kept private there too, so they reach only a
  // platform whose cell a sample wrote (OrcaRouter, 第十八个样本「再补测」).
  //
  // Two request conditions, both DashScope's own 400s. Beside function tools
  // on Chat Completions page reading is the `agent_max` search strategy —
  // "agent mode" — and the interpreter is the same mode, and both answer
  // `Agent mode does not support tools` (measured 2026-09-17); the request
  // keeps plain search and gives page reading up. On Responses the
  // interpreter needs the model thinking: with `reasoning.effort: "none"` the
  // whole response fails (`Normal mode does not support Code interpreter`,
  // same day). An unknown thinking state counts as thinking there — only an
  // effort the request itself turned off is off.
  web_extractor: { families: ["openai", "responses", "gemini"], origin: "private", unless: { openai: [WITH_FUNCTION_TOOLS] } },
  web_search_image: { families: ["responses"], origin: "private" },
  image_search: { families: ["responses"], origin: "private" },
  code_interpreter: {
    families: ["openai", "responses", "gemini"], origin: "private",
    unless: {
      openai: [WITH_FUNCTION_TOOLS],
      responses: [{ when: "thinking", is: "off", unknownAs: "on", absent: "defer" }],
    },
  },
};
