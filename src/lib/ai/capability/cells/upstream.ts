/**
 * On a relay, what each upstream behind it was measured to do — consulted
 * before the relay's own cells when the model's upstream is known
 * (`relayUpstream.ts` resolves which one it is).
 */

import type { ProtocolFamily } from "../../types";
import type { RelayUpstreamId } from "../../relayUpstream";
import type { CapabilityId } from "../facts";
import type { ModelPattern } from "../modelId";

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
  models: ModelPattern;
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
export const UPSTREAM_CELLS: Record<RelayUpstreamId, UpstreamCapabilities> = {
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
