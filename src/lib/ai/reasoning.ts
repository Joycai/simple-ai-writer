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
 * See `docs/api/landscape.md` for the protocol facts and `docs/reasoning-plan.md`
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

/**
 * OpenAI Chat Completions spells effort as a top-level `reasoning_effort`
 * string, and turns thinking off with the same field rather than a separate
 * switch. Its full enum is `none|minimal|low|medium|high|xhigh|max`; the two
 * values omitted here (`minimal`, `xhigh`) sit between levels this app already
 * offers, and "not every model supports every value" is a rule that applies to
 * the fringes first.
 *
 * DeepSeek and the other OpenAI-compatible endpoints accept the same field.
 * Their extra `thinking: {type}` switch is deliberately **not** sent: it is a
 * single vendor's dialect, and OpenAI's own endpoint rejects unknown top-level
 * arguments outright — so volunteering it would break the official path to
 * spell something `reasoning_effort: "none"` already says.
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
): Record<string, unknown> | undefined {
  if (!effort || effort === "default") return undefined;
  switch (familyOf(standard)) {
    case "openai":
      return { reasoning_effort: OPENAI_EFFORT[effort] };
    // Gemini's thinkingConfig and Anthropic's output_config.effort land here
    // next; until then they keep sending nothing.
    default:
      return undefined;
  }
}

// ─── What a given endpoint can actually be told ───────────────────────────────

/**
 * Whether a thinking level can reach this endpoint at all.
 *
 * Answers "can the adapter *send* it today", not "does the model think" — an
 * endpoint whose family has no mapping yet would swallow the setting silently,
 * and a control that does nothing is worse than no control. Widen this as each
 * family's mapping lands (see `reasoningBody`), never ahead of it.
 */
export function supportsThinkingLevel(standard: ApiStandard): boolean {
  return familyOf(standard) === "openai";
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
export function supportsSeparateEffort(_standard: ApiStandard): boolean {
  return false;
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
