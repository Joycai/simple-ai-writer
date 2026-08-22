/**
 * Thinking effort: the author's intent, and how each protocol family spells it.
 *
 * The four families all grew an effort dial, and their level names look almost
 * alike — which is the trap. `medium` on one vendor is silently folded into
 * `high` on another; `minimal`/`none` exist on some models and 400 on others;
 * one family wants a *token budget* rather than a level at all. So what is
 * stored on a model is **this app's own six-value vocabulary**, and each adapter
 * translates. Never let a provider's own spelling reach the config layer.
 *
 * See `docs/api/landscape.md` for the protocol facts and `docs/api/reasoning-plan.md`
 * for why the mapping is shaped this way.
 *
 * Only the OpenAI Chat Completions family is wired up so far; the others return
 * undefined, which is exactly the behaviour they had before this file existed.
 */

import { familyOf, type ApiStandard } from "./types";

/**
 * How hard the author wants this model to think.
 *
 * `default` (and an absent value, which every model configured before this
 * setting existed has) means **send nothing** and let the endpoint apply its own
 * default. That is the only choice that is safe on every relay: any field this
 * app volunteers is a field some gateway can reject outright.
 */
export type ReasoningEffort = "default" | "off" | "low" | "medium" | "high" | "max";

/** Selectable values, in the order the settings drawer shows them. */
export const REASONING_EFFORTS: ReasoningEffort[] = [
  "default", "off", "low", "medium", "high", "max",
];

/** Narrow a stored string to the union — the DB column is free text. */
export function parseReasoningEffort(v: unknown): ReasoningEffort | undefined {
  return typeof v === "string" && (REASONING_EFFORTS as string[]).includes(v)
    ? (v as ReasoningEffort)
    : undefined;
}

// ─── Which dialect of the thinking parameter a model speaks ───────────────────

/**
 * How this model wants its thinking configured.
 *
 * A protocol family is not enough to answer this: within one family the
 * parameter changed shape between model generations, and **the generation is
 * not recoverable from the model id** on a relay, where that id is free text the
 * author typed (`特价kiro | claude-opus-4-6-thinking`). So the author declares
 * it — they picked the relay and know what they bought; it is the code that
 * can't tell. See `docs/api/anthropic-plan.md` §3.
 *
 *   - `adaptive`  — the model decides when and how deeply to think; depth comes
 *                   from an effort level. Claude 4.6+.
 *   - `extended`  — a fixed thinking token budget per request. Claude 4.5 and
 *                   earlier. Also the shape Gemini 2.5 uses.
 *   - `switch`    — a bare on/off switch, spelled per family: on Anthropic
 *                   bodies `{type:"adaptive"|"disabled"}` and nothing else — no
 *                   `display`, no budget, and **no `output_config`**, which is
 *                   where family ④'s depth dial lives; on OpenAI-compatible
 *                   bodies a top-level `enable_thinking: bool` (Qwen's DashScope
 *                   compatible-mode — what the SDK docs put in `extra_body` is
 *                   just a top-level wire field). Declaring this dialect also
 *                   means "this endpoint has no depth dial at all". The samples
 *                   it was written for: MiniMax-M3's `/anthropic/v1/messages`
 *                   (`docs/api/landscape.md` §7 第四个样本) and Qwen3 on
 *                   DashScope — on both, thinking on the affected models
 *                   defaults to **off**, so sending the switch is the only way
 *                   the model thinks.
 *   - `none`      — this endpoint has no thinking parameter; send nothing.
 *
 * Absent means "assume the family's current generation" — see `defaultDialect`.
 */
export type ThinkingDialect = "adaptive" | "extended" | "switch" | "none";

export const THINKING_DIALECTS: ThinkingDialect[] = ["adaptive", "extended", "switch", "none"];

export function parseThinkingDialect(v: unknown): ThinkingDialect | undefined {
  return typeof v === "string" && (THINKING_DIALECTS as string[]).includes(v)
    ? (v as ThinkingDialect)
    : undefined;
}

/**
 * The dialect to assume when the author hasn't declared one.
 *
 * Optimistic on purpose, and only for families whose current generation this app
 * declares support for: guessing `adaptive` on Anthropic is right for every
 * model in the supported range (4.6+), and wrong in exactly one recoverable way
 * — an older model answers with a 400 naming the problem, which is a far better
 * outcome than defaulting to "no thinking" and leaving the author wondering why
 * their reasoning model never reasons.
 */
export function defaultDialect(standard: ApiStandard): ThinkingDialect {
  return familyOf(standard) === "anthropic" ? "adaptive" : "none";
}

/** The dialect in force for a request: the author's choice, else the default. */
export function dialectFor(standard: ApiStandard, declared?: ThinkingDialect): ThinkingDialect {
  return declared ?? defaultDialect(standard);
}

/**
 * OpenAI Chat Completions spells effort as a top-level `reasoning_effort`
 * string, and turns thinking off with the same field rather than a separate
 * switch. Its full enum is `none|minimal|low|medium|high|xhigh|max`; the two
 * values omitted here (`minimal`, `xhigh`) sit between levels this app already
 * offers, and "not every model supports every value" is a rule that applies to
 * the fringes first.
 *
 * DeepSeek and the other OpenAI-compatible endpoints accept the same field.
 * Vendor switch fields (`thinking: {type}`, `enable_thinking`) are deliberately
 * **not** sent unless the author declared the `switch` dialect on the model:
 * they are single-vendor spellings, and OpenAI's own endpoint rejects unknown
 * top-level arguments outright — so volunteering one would break the official
 * path to spell something `reasoning_effort: "none"` already says. With the
 * dialect declared, the statement inverts: this endpoint's thinking vocabulary
 * *is* the switch, so `enable_thinking` is sent and `reasoning_effort` is not
 * (on Qwen the two are documented as mutually exclusive — effort there
 * only distinguishes "off" from everything else).
 */
const OPENAI_EFFORT: Record<Exclude<ReasoningEffort, "default">, string> = {
  off: "none",
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

/**
 * The request-body fragment for this model's effort setting, or undefined to
 * send nothing at all.
 *
 * Undefined is returned for `default`/absent **and** for every family whose
 * translation isn't written yet — both mean "leave the endpoint's own default
 * alone", which is the pre-existing behaviour in each case.
 */
export function reasoningBody(
  standard: ApiStandard,
  effort: ReasoningEffort | undefined,
  dialect?: ThinkingDialect,
): Record<string, unknown> | undefined {
  if (!effort || effort === "default") return undefined;
  switch (familyOf(standard)) {
    case "openai":
      // The `switch` dialect is the statement that this endpoint's thinking
      // vocabulary is a bare `enable_thinking` boolean (Qwen on DashScope
      // compatible-mode) and that `reasoning_effort` is not welcome beside it.
      // No depth dial exists there, so effort is spent on on/off alone —
      // exactly the deal the same dialect strikes on the Anthropic family.
      return dialect === "switch"
        ? { enable_thinking: effort !== "off" }
        : { reasoning_effort: OPENAI_EFFORT[effort] };
    case "anthropic":
      // The `switch` dialect *is* the statement that this endpoint has no
      // `output_config` — depth there is expressible only as on/off, which
      // `thinkingBody` already spent the effort setting on. Sending the field
      // anyway would volunteer an unknown top-level argument to an endpoint
      // whose documented request schema doesn't have one.
      return dialect === "switch"
        ? undefined
        : { output_config: { effort: ANTHROPIC_EFFORT[effort] } };
    case "gemini":
      return {
        generationConfig: {
          thinkingConfig: {
            thinkingLevel: GEMINI_LEVEL[effort],
            // Paired with the level on purpose. Thinking runs either way and is
            // billed either way; this only decides whether the reasoning comes
            // back with the answer. Setting a depth while leaving it off would
            // pay for thinking nobody can see.
            includeThoughts: true,
          },
        },
      };
    default:
      return undefined;
  }
}

/**
 * Gemini spells the level as an enum, in **upper case** — the lower-case
 * `thinking_level` seen in the guides belongs to the newer Interactions API, a
 * different surface (see `docs/api/landscape.md` §4.1).
 *
 * Two levels collapse. `off` maps to `MINIMAL` because this family has no way
 * to turn thinking off at all — the docs say plainly that "`minimal` does not
 * guarantee that thinking is off", so the UI's "off" is honestly "as little as
 * this model allows", same as on Anthropic. `max` maps to `HIGH` because the
 * enum stops there.
 *
 * `thinkingBudget` — the older numeric form — is deliberately never sent: it
 * lives in the same object and is distinguished only by which models accept it,
 * and this app's Gemini support starts at 3, where the level enum is the
 * documented input.
 */
const GEMINI_LEVEL: Record<Exclude<ReasoningEffort, "default">, string> = {
  off: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  max: "HIGH",
};

/**
 * Anthropic spells effort in `output_config.effort`, and it governs the **whole
 * response** — prose, tool calls and thinking together — not just thinking
 * depth. That is why it is a second dial here rather than the same one.
 *
 * `off` maps to the lowest level rather than to `thinking: {type:"disabled"}`,
 * which is what "off" means literally. Three reasons, in order of weight:
 * several models reject `disabled` outright; the ones that accept it are
 * documented to occasionally emit tool calls as plain text once thinking is
 * gone; and the vendor's own advice for spending less is to lower effort rather
 * than to disable. So "off" here is honestly "as little as this model allows" —
 * the UI says so rather than promising a switch the protocol won't honour.
 *
 * `xhigh` is deliberately absent from this app's vocabulary (see
 * REASONING_EFFORTS), which sidesteps the one level Claude 4.6 lacks.
 */
const ANTHROPIC_EFFORT: Record<Exclude<ReasoningEffort, "default">, string> = {
  off: "low",
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

/**
 * The `thinking` field for a request, or undefined to send none.
 *
 * `display` is not negotiable per request here: the current Claude generation
 * defaults it to `"omitted"`, which returns thinking blocks whose text is an
 * empty string — billed in full, and useless to a UI that wants to show the
 * reasoning. Asking for `"summarized"` is what makes the feature visible at all.
 * The `switch` dialect is the one place it is left out, because that endpoint's
 * documented schema has no such field — and a compat layer that ignores unknown
 * keys and one that 400s on them are equally common (see `docs/api/landscape.md`
 * §7), so nothing is volunteered there that the docs don't name.
 *
 * `effort` reaches here only for `switch`, where on/off is the *entire* depth
 * vocabulary: with no `output_config` to carry a level, "as little as possible"
 * can only be said by turning thinking off. Every other dialect keeps the two
 * dials separate and ignores it.
 */
export function thinkingBody(
  dialect: ThinkingDialect,
  budgetTokens: number,
  effort?: ReasoningEffort,
): Record<string, unknown> | undefined {
  switch (dialect) {
    case "adaptive":
      return { thinking: { type: "adaptive", display: "summarized" } };
    case "extended":
      return { thinking: { type: "enabled", budget_tokens: budgetTokens, display: "summarized" } };
    case "switch":
      return { thinking: { type: effort === "off" ? "disabled" : "adaptive" } };
    case "none":
      return undefined;
  }
}

// ─── What a given endpoint can actually be told ───────────────────────────────

/**
 * Whether a thinking level can reach this endpoint at all.
 *
 * Answers "can the adapter *send* it today", not "does the model think" — an
 * endpoint whose family has no mapping yet would swallow the setting silently,
 * and a control that does nothing is worse than no control.
 *
 * Every family this app speaks now has a mapping, so this is true across the
 * board. It stays as a function rather than collapsing into `true` because the
 * fourth family (OpenAI Responses) is not implemented yet, and because
 * `reasoningBody` returning undefined for an unmapped family is exactly the
 * silent-swallow case this guards against.
 */
export function supportsThinkingLevel(standard: ApiStandard): boolean {
  const family = familyOf(standard);
  return family === "openai" || family === "anthropic" || family === "gemini";
}

/**
 * Whether a `temperature` can reach this endpoint at all.
 *
 * Lives here, next to `supportsThinkingLevel` and for the same reason, because
 * the one protocol that refuses it refuses it *because of thinking*: the
 * Messages API accepts `temperature: 1` and nothing else while extended
 * thinking is on, and `defaultDialect` makes Anthropic thinking unless the
 * author declares otherwise — so on an ordinary Claude model the field is
 * unsendable. Clamping the author's 0.2 up to the one legal value would send
 * the opposite of what they asked for under the name of honoring it, so the
 * adapter omits it instead.
 *
 * The adapter and the model editor both read this, rather than each testing
 * the condition their own way: a control the request then drops is exactly
 * what the comment on `supportsThinkingLevel` says not to ship.
 */
export function supportsTemperature(standard: ApiStandard, declared?: ThinkingDialect): boolean {
  if (familyOf(standard) !== "anthropic") return true;
  return dialectFor(standard, declared) === "none";
}

/**
 * Whether this endpoint has a **separate** overall-effort dial, distinct from
 * the thinking level.
 *
 * Nothing does yet. Anthropic is the one that will: its `output_config.effort`
 * governs the whole response — prose, tool calls and thinking together — while
 * `thinking` governs only whether it thinks. On the OpenAI family the two
 * collapse into the single `reasoning_effort` field, so offering two dials
 * there would be two controls writing one value.
 */
export function supportsSeparateEffort(standard: ApiStandard): boolean {
  return familyOf(standard) === "anthropic";
}

// ─── Reasoning content on the OpenAI-compatible wire ──────────────────────────

/**
 * Reasoning the model emitted, kept **verbatim together with the field name it
 * arrived under**, so it can be echoed back exactly as received.
 *
 * The field name travels with the text on purpose. Endpoints speaking the same
 * protocol disagree on what to call this, and an endpoint that sends one name
 * is the endpoint most likely to expect that same name back. Echoing what we
 * were given needs no knowledge of *which* vendor we are talking to — which is
 * the only version of this that survives the next provider.
 */
export interface NativeReasoning {
  /** The wire field it arrived under (`reasoning_content`, `reasoning`, …). */
  field: string;
  text: string;
}

/**
 * Field names carrying reasoning text on an OpenAI-compatible delta, in
 * preference order.
 *
 * OpenAI's own Chat Completions returns **no** reasoning content at all — only
 * a `reasoning_tokens` count — so anything found here comes from an endpoint
 * that extended the protocol. `reasoning_content` is the more widely mirrored
 * spelling; `reasoning` is the other one in circulation. Both are read, neither
 * is assumed: an endpoint that sends neither simply produces no reasoning, and
 * everything downstream behaves exactly as it did before this existed.
 *
 * Adding a name here is the whole cost of supporting another endpoint's
 * spelling — deliberately, so it never becomes a per-vendor branch.
 */
export const REASONING_CONTENT_FIELDS = ["reasoning_content", "reasoning"] as const;

/**
 * Pull a reasoning fragment off one streamed delta, or null if it carries none.
 *
 * Non-string values are ignored rather than coerced: at least one endpoint
 * sends a structured `reasoning_details` array beside the plain field, and
 * `String(...)`-ing an object into the transcript would put "[object Object]"
 * in front of the author.
 */
// ─── Reasoning inlined into the answer text ───────────────────────────────────

const OPEN = "<think>";
const CLOSE = "</think>";

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function danglingPrefix(s: string, tag: string): number {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

/**
 * Pulls an inline `<think>…</think>` block out of streamed answer text.
 *
 * Some endpoints don't separate thinking from the answer at all — they wrap it
 * in tags and send the whole thing as `content`. Left alone, that prose reaches
 * the manuscript: `{text}` chunks are what gets inserted into the document.
 *
 * Two properties make this safe to run on every response:
 *
 *   - **Only at the very start.** A response is treated as tag-wrapped only
 *     when `<think>` is the first non-whitespace thing in it, which is where
 *     the endpoints that do this always put it. A `<think>` appearing later is
 *     the author's own text — this is a writing app, and silently eating a
 *     passage would be far worse than leaving a stray tag visible.
 *   - **Tag-splitting is handled.** `<thi` + `nk>` arriving in two chunks is
 *     normal, so any tail that could still become a tag is held back rather
 *     than emitted as text.
 */
export function createThinkTagSplitter(): {
  push(text: string): StreamPiece[];
  /** Anything still held back when the stream ends. */
  flush(): StreamPiece[];
} {
  type Phase = "start" | "thinking" | "body";
  let phase: Phase = "start";
  let buf = "";

  const step = (out: StreamPiece[]): boolean => {
    if (phase === "start") {
      const lead = buf.length - buf.trimStart().length;
      const rest = buf.slice(lead);
      if (rest.startsWith(OPEN)) {
        buf = rest.slice(OPEN.length);
        phase = "thinking";
        return true;
      }
      // Still possibly the opening tag, split across chunks — wait for more.
      if (rest.length < OPEN.length && OPEN.startsWith(rest)) return false;
      phase = "body";
      return true;
    }
    if (phase === "thinking") {
      const at = buf.indexOf(CLOSE);
      if (at >= 0) {
        if (at > 0) out.push({ reasoning: buf.slice(0, at) });
        buf = buf.slice(at + CLOSE.length);
        phase = "body";
        return true;
      }
      const hold = danglingPrefix(buf, CLOSE);
      const safe = buf.slice(0, buf.length - hold);
      if (safe) out.push({ reasoning: safe });
      buf = buf.slice(buf.length - hold);
      return false;
    }
    if (buf) out.push({ text: buf });
    buf = "";
    return false;
  };

  return {
    push(text: string) {
      buf += text;
      const out: StreamPiece[] = [];
      while (step(out)) { /* phase changed — re-run against the same buffer */ }
      return out;
    },
    flush() {
      if (!buf) return [];
      // An unterminated block: report it as reasoning rather than as answer
      // text. The response was cut off mid-thought, and the tail is not prose
      // the author asked for.
      const out: StreamPiece[] = [{ [phase === "thinking" ? "reasoning" : "text"]: buf } as StreamPiece];
      buf = "";
      return out;
    },
  };
}

/** What the splitter emits — the two `StreamChunk` variants it can produce. */
export type StreamPiece = { text: string } | { reasoning: string };

export function readReasoningDelta(delta: Record<string, unknown>): NativeReasoning | null {
  for (const field of REASONING_CONTENT_FIELDS) {
    const v = delta[field];
    if (typeof v === "string" && v.length > 0) return { field, text: v };
  }
  return null;
}
