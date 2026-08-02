/**
 * Pure analysis helpers for endpoint probing — no network, no storage.
 *
 * The probe's judgement calls all live here so they can be unit-tested against
 * the real error strings providers emit. `endpointProbe.ts` owns the HTTP and
 * calls into this file for every decision.
 *
 * Three different quantities get conflated by anyone who says "context size";
 * keeping them apart is the whole point of the feature:
 *   - **accepted limit** — how large a prompt survives without a 4xx.
 *   - **untruncated limit** — how much the server actually *forwards*. Local
 *     backends (ollama's `num_ctx`) answer 200 OK and silently drop the head.
 *   - **effective limit** — how deep the model still attends. Not measured here.
 */

/** Hard ceiling for any number we accept out of a provider response. */
export const PROBE_VALUE_MAX = 10_000_000;

/**
 * Keys that carry a context window, most authoritative first. Names differ per
 * backend (vLLM `max_model_len`, OpenRouter `context_length`, LM Studio
 * `max_context_length`, ollama `<arch>.context_length`), so this is a candidate
 * list rather than one hardcoded field.
 *
 * `loaded_context_length` / `num_ctx` describe what is *actually in effect*,
 * which is usually far below what the model supports — both are collected and
 * the caller keeps the smaller one.
 */
const CONTEXT_KEYS = [
  "max_model_len",
  "context_length",
  "max_context_length",
  "loaded_context_length",
  "context_window",
  "max_context_window_tokens",
  "max_input_tokens",
  "inputtokenlimit",
  "num_ctx",
  "n_ctx",
];

/** Keys that carry a maximum completion length. */
const OUTPUT_KEYS = [
  "max_completion_tokens",
  "max_output_tokens",
  "maxoutputtokens",
  "outputtokenlimit",
  "max_tokens",
  "n_predict",
];

/** Nested containers worth descending into (`top_provider`, `model_info`, …). */
const NESTED_DEPTH = 2;

function toPositiveInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const i = Math.floor(n);
  return i > 0 && i <= PROBE_VALUE_MAX ? i : undefined;
}

/**
 * Normalize a key for matching: lowercase, and keep only the last dot segment
 * so ollama's `llama.context_length` matches the same candidate as a plain
 * `context_length`.
 */
function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot + 1) : lower;
}

export interface EntryLimits {
  /** Every context value found, keyed by the path it came from. */
  context: { path: string; value: number }[];
  /** Every output-length value found. */
  output: { path: string; value: number }[];
}

/**
 * Harvest context/output limits from an arbitrary provider JSON object.
 *
 * Deliberately structural rather than per-provider: the same walk handles a
 * `/v1/models` entry, ollama's `/api/show`, and llama.cpp's `/props`, and it
 * keeps working when a gateway invents its own field name that happens to
 * match one of the candidates.
 */
export function readEntryLimits(entry: unknown): EntryLimits {
  const context: { path: string; value: number }[] = [];
  const output: { path: string; value: number }[] = [];

  const walk = (node: unknown, prefix: string, depth: number) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const norm = normalizeKey(key);
      const num = toPositiveInt(value);
      if (num !== undefined) {
        if (CONTEXT_KEYS.includes(norm)) context.push({ path, value: num });
        else if (OUTPUT_KEYS.includes(norm)) output.push({ path, value: num });
      } else if (depth < NESTED_DEPTH) {
        walk(value, path, depth + 1);
      }
    }
  };

  walk(entry, "", 0);
  return { context, output };
}

/**
 * ollama's `/api/show` returns `parameters` as a flat text blob
 * (`num_ctx    4096\nstop  "<|im_end|>"`), not JSON. The value in there is the
 * one actually in effect, so it outranks the model's advertised window.
 */
export function parseOllamaParameters(params: unknown): { path: string; value: number }[] {
  if (typeof params !== "string") return [];
  const out: { path: string; value: number }[] = [];
  for (const line of params.split("\n")) {
    const m = /^\s*(num_ctx|num_predict)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const value = toPositiveInt(m[2]);
    if (value !== undefined) out.push({ path: `parameters.${m[1]}`, value });
  }
  return out;
}

// ─── Error classification ────────────────────────────────────────────────────

export type ProbeErrorKind =
  /** The server named a real context-window limit. Trustworthy. */
  | "context_limit"
  /** The server named a real max-output limit. Trustworthy. */
  | "output_limit"
  /** Wrong parameter name for this model (`max_tokens` vs `max_completion_tokens`). */
  | "param_name"
  /** Gateway body-size cap — a byte limit, *not* a token limit. */
  | "payload_too_large"
  | "rate_limit"
  | "server_error"
  | "auth"
  | "not_found"
  | "unknown";

export interface ProbeErrorInfo {
  kind: ProbeErrorKind;
  /** Limit named in the message, when one was parseable. */
  limit?: number;
  /** For `param_name`: the parameter the server wants instead. */
  paramHint?: string;
  /** Whether this outcome may be treated as evidence of a real ceiling. */
  conclusive: boolean;
}

const CONTEXT_PHRASES =
  /context[_ -]?length|context[_ -]?window|context[_ -]?size|too many tokens|prompt is too long|input is too long|maximum input|reduce the length of the messages|上下文|输入过长/i;

const OUTPUT_PHRASES =
  /max_tokens|max_completion_tokens|maxoutputtokens|max_output_tokens|completion tokens|output tokens|n_predict|输出长度/i;

const PARAM_PHRASES =
  /unsupported (?:parameter|value)|unrecognized (?:request )?argument|is not supported with this model|use ['"`]?max_completion_tokens|unknown (?:field|parameter)/i;

/**
 * First number that reads as a limit rather than as "what you requested".
 *
 * Order matters: providers usually phrase it as "maximum … is N, however you
 * requested M", and grabbing the first integer in the string would return the
 * *requested* value on the messages that put it first.
 */
export function parseLimitFromMessage(text: string): number | undefined {
  const patterns = [
    /maximum context length is (\d[\d,_]*)/i,
    /max(?:imum)?(?: allowed)?(?: value)? (?:is|of) (\d[\d,_]*)/i,
    /must be (?:at most|<=|less than or equal to) (\d[\d,_]*)/i,
    /supports? at most (\d[\d,_]*)/i,
    /limit(?:ed)? (?:is |to )(\d[\d,_]*)/i,
    /(?:n_ctx|num_ctx|max_model_len|context_length)\D{0,12}(\d[\d,_]*)/i,
    /(\d[\d,_]*) tokens?\)?\s*(?:maximum|limit|max)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const n = toPositiveInt(m[1].replace(/[,_]/g, ""));
    if (n !== undefined) return n;
  }
  return undefined;
}

/** Which parameter name the server is asking for, when it says so. */
function parseParamHint(text: string): string | undefined {
  const m = /use ['"`]?(max_completion_tokens|max_tokens|max_output_tokens)['"`]?/i.exec(text);
  if (m) return m[1];
  if (/max_completion_tokens/i.test(text)) return "max_completion_tokens";
  return undefined;
}

/**
 * Turn one failed probe request into a verdict.
 *
 * The single most damaging bug this feature can ship is reading a 429 or a 502
 * as "that's the ceiling" — a rate-limited 128k model would be recorded as
 * whatever size happened to trip the quota. Only messages that actually talk
 * about context/output length are `conclusive`; everything else is explicitly
 * marked transient so the caller retries instead of concluding.
 */
export function classifyProbeError(status: number, body: string): ProbeErrorInfo {
  const text = body ?? "";
  if (status === 413) return { kind: "payload_too_large", conclusive: false };
  if (status === 429) return { kind: "rate_limit", conclusive: false };
  if (status >= 500) return { kind: "server_error", conclusive: false };
  if (status === 401 || status === 403) return { kind: "auth", conclusive: false };
  if (status === 404) return { kind: "not_found", conclusive: false };

  // A parameter-name complaint mentions `max_tokens` too, so it has to be
  // tested before the output-limit branch or every o-series model reads as
  // "output limit unknown number".
  if (PARAM_PHRASES.test(text)) {
    return { kind: "param_name", paramHint: parseParamHint(text), conclusive: false };
  }
  if (CONTEXT_PHRASES.test(text)) {
    return { kind: "context_limit", limit: parseLimitFromMessage(text), conclusive: true };
  }
  if (OUTPUT_PHRASES.test(text)) {
    return { kind: "output_limit", limit: parseLimitFromMessage(text), conclusive: true };
  }
  return { kind: "unknown", conclusive: false };
}

/** Transient failures worth retrying rather than recording as a limit. */
export function isTransient(kind: ProbeErrorKind): boolean {
  return kind === "rate_limit" || kind === "server_error";
}

// ─── Token calibration ───────────────────────────────────────────────────────

export interface CalibrationSample {
  /** Characters of padding actually sent. */
  chars: number;
  /** `usage.prompt_tokens` the server reported for that request. */
  tokens: number;
}

export interface Calibration {
  /** Characters per token for this model, measured on this endpoint. */
  charsPerToken: number;
  /** Constant per-request cost: chat template, role markers, system prompt. */
  overheadTokens: number;
}

/**
 * Two-point calibration of the endpoint's own tokenizer.
 *
 * Taking the *difference* between two padding sizes cancels the fixed overhead
 * (chat template, BOS, any system prompt the gateway injects), which is exactly
 * the term that makes a single-sample estimate useless on short prompts.
 * Returns null when the two samples disagree with reality badly enough that the
 * slope is not credible — better no ratio than a wrong one.
 */
export function calibrate(a: CalibrationSample, b: CalibrationSample): Calibration | null {
  const [lo, hi] = a.chars <= b.chars ? [a, b] : [b, a];
  const dChars = hi.chars - lo.chars;
  const dTokens = hi.tokens - lo.tokens;
  if (dChars <= 0 || dTokens <= 0) return null;
  const charsPerToken = dChars / dTokens;
  // Outside this band the server is not reporting what we think it is (counts
  // characters, counts bytes, or truncated one of the two samples).
  if (charsPerToken < 0.4 || charsPerToken > 12) return null;
  const overheadTokens = Math.max(0, Math.round(lo.tokens - lo.chars / charsPerToken));
  return { charsPerToken, overheadTokens };
}

/** Expected `prompt_tokens` for a padding of `chars` under a calibration. */
export function expectedPromptTokens(chars: number, cal: Calibration): number {
  return Math.round(chars / cal.charsPerToken + cal.overheadTokens);
}

// ─── Silent-truncation verdict ───────────────────────────────────────────────

export type TruncationVerdict = "truncated" | "not-detected" | "unknown";

export interface TruncationResult {
  verdict: TruncationVerdict;
  expectedTokens: number;
  reportedTokens?: number;
  /** Where the server appears to cut, when truncation was detected. */
  cap?: number;
}

/**
 * A prompt this much smaller than what we sent means content was dropped.
 * Loose on purpose — tokenizers differ from our calibration by a few percent,
 * and a false "your server is truncating" is worse than a missed detection.
 */
const TRUNCATION_RATIO = 0.75;
/** …and the absolute gap must be real, so small prompts never trip it. */
const TRUNCATION_MIN_GAP = 400;

/**
 * Compare what we sent against what the server says it received.
 *
 * The asymmetry here is load-bearing and is surfaced in the UI: a detection is
 * proof, but a non-detection is **not** proof of absence. Some servers report
 * the pre-truncation count, some report no usage at all, and a proxy can simply
 * make the number up. Only a needle test gives positive evidence.
 */
export function judgeTruncation(
  expectedTokens: number,
  reportedTokens: number | undefined,
): TruncationResult {
  if (reportedTokens === undefined || reportedTokens <= 0) {
    return { verdict: "unknown", expectedTokens };
  }
  const gap = expectedTokens - reportedTokens;
  if (gap > TRUNCATION_MIN_GAP && reportedTokens < expectedTokens * TRUNCATION_RATIO) {
    return { verdict: "truncated", expectedTokens, reportedTokens, cap: reportedTokens };
  }
  return { verdict: "not-detected", expectedTokens, reportedTokens };
}

// ─── Padding ─────────────────────────────────────────────────────────────────

const PAD_WORDS = [
  "river", "cabinet", "morning", "signal", "harbor", "candle", "gravel", "meadow",
  "lantern", "orchard", "pebble", "thicket", "willow", "anchor", "bramble", "cinder",
  "drifting", "ember", "fathom", "glimmer", "hollow", "ivory", "juniper", "kindle",
  "lattice", "marble", "nimbus", "opal", "prairie", "quarry", "ripple", "saffron",
  "tundra", "umber", "verdant", "whisper", "yarrow", "zephyr", "basalt", "clover",
];

/** Deterministic 32-bit LCG — same seed, same padding, so runs are comparable. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * Filler text of roughly `chars` characters.
 *
 * Not `"aaaa…"` and not a repeated paragraph: prefix caching and some
 * tokenizers collapse long repeats, which would make the measured token count
 * a fiction. A seeded word sequence with a running counter every few words has
 * no long repeated substring, so the count reflects real work.
 */
export function makePadding(chars: number, seed = 20240801): string {
  if (chars <= 0) return "";
  const rand = lcg(seed);
  const parts: string[] = [];
  let len = 0;
  let n = 0;
  while (len < chars) {
    const word = PAD_WORDS[Math.floor(rand() * PAD_WORDS.length)];
    const token = ++n % 7 === 0 ? `${word}${n}` : word;
    parts.push(token);
    len += token.length + 1;
  }
  return parts.join(" ").slice(0, chars);
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

export type FindingSource =
  | "models-endpoint"
  | "ollama-show"
  | "llamacpp-props"
  | "error-message"
  | "measured";

export type FindingConfidence = "high" | "medium" | "low";

export interface ProbeFinding {
  source: FindingSource;
  /** Where the number came from — a JSON path or a phrase from the error. */
  detail: string;
  contextWindow?: number;
  maxOutput?: number;
  confidence: FindingConfidence;
}

export interface ProbeSuggestion {
  contextWindow?: number;
  maxOutput?: number;
  /** Findings that disagreed with the chosen value, for the UI to surface. */
  conflicts: string[];
}

/**
 * Collapse the findings into the pair of numbers to write into settings.
 *
 * Always the **smallest** credible value, never the largest or the newest: the
 * effective ceiling is whatever link in the chain is tightest, and every way of
 * being wrong here is asymmetric. Too low costs some unused window; too high
 * puts us back at silent truncation, which is the bug this feature exists to
 * find. A confirmed truncation cap overrides everything above it.
 */
export function suggestSettings(
  findings: ProbeFinding[],
  truncation?: TruncationResult,
): ProbeSuggestion {
  const ctx = findings.filter((f) => f.contextWindow !== undefined);
  const out = findings.filter((f) => f.maxOutput !== undefined);
  const conflicts: string[] = [];

  let contextWindow = ctx.length
    ? Math.min(...ctx.map((f) => f.contextWindow!))
    : undefined;
  for (const f of ctx) {
    if (f.contextWindow !== contextWindow) {
      conflicts.push(`${f.detail}: ${f.contextWindow!.toLocaleString()}`);
    }
  }

  if (truncation?.verdict === "truncated" && truncation.cap) {
    // Round down to a power-of-two-ish stop: the real cap is a configured
    // number (4096, 8192), and the measured value sits just under it.
    const cap = truncation.cap;
    if (contextWindow === undefined || cap < contextWindow) {
      if (contextWindow !== undefined) {
        conflicts.push(`declared ${contextWindow.toLocaleString()}`);
      }
      contextWindow = cap;
    }
  }

  const maxOutput = out.length ? Math.min(...out.map((f) => f.maxOutput!)) : undefined;
  for (const f of out) {
    if (f.maxOutput !== maxOutput) {
      conflicts.push(`${f.detail}: ${f.maxOutput!.toLocaleString()}`);
    }
  }

  return { contextWindow, maxOutput, conflicts };
}

// ─── Cost ────────────────────────────────────────────────────────────────────

export interface ProbeCost {
  inputTokens: number;
  outputTokens: number;
  /** USD, or undefined when the model has no prices configured. */
  usd?: number;
}

/**
 * What a probe plan will spend, shown *before* the run starts.
 *
 * Deep probes on a 1M-window model are not free, and a user who cannot see the
 * number before pressing the button cannot consent to it.
 */
export function estimateProbeCost(
  inputTokens: number,
  outputTokens: number,
  priceIn: number,
  priceOut: number,
): ProbeCost {
  const usd = priceIn > 0 || priceOut > 0
    ? (inputTokens / 1_000_000) * priceIn + (outputTokens / 1_000_000) * priceOut
    : undefined;
  return { inputTokens, outputTokens, usd };
}
