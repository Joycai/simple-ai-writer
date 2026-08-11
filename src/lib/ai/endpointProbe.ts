/**
 * Endpoint probing — find out what a model endpoint *actually* accepts, as
 * opposed to what its documentation, its gateway, or the author's guess says.
 *
 * Runs in the order that spends the least: free metadata first, then a single
 * near-zero-token error probe, then a small number of measured requests. Only
 * the opt-in deep pass generates real tokens.
 *
 *   Step 0  discover()      `/v1/models` extra fields, ollama `/api/show`,
 *                           llama.cpp `/props`.                      0 tokens
 *   Step 1  errorProbe()    absurd max_tokens → the server usually
 *                           writes its real limit into the 4xx body.  ~0 tokens
 *   Step 2  calibrate()     two paddings → this endpoint's true
 *                           chars-per-token, template overhead cancelled out.
 *           truncation()    a sized prompt vs. the reported
 *                           `prompt_tokens` → catches servers that answer
 *                           200 OK after quietly dropping the head.
 *   Step 3  deep (opt-in)   binary search for the accepted ceiling, and a
 *                           real generation to measure output length.
 *
 * Every judgement call — is this error a limit or a rate-limit, is this gap
 * truncation or tokenizer noise — lives in ./probeAnalysis so it can be tested
 * without a network. This file is the plumbing.
 */

import { fetch, isLocalUrl } from "../http";
import {
  calibrate, classifyProbeError, estimateProbeCost, expectedPromptTokens,
  isTransient, judgeTruncation, makePadding, parseOllamaParameters, readEntryLimits,
  suggestSettings,
  type Calibration, type FindingConfidence, type ProbeCost, type ProbeFinding,
  type ProbeSuggestion, type TruncationResult,
} from "./probeAnalysis";
import { anthropicHeaders } from "./anthropic";
import { familyOf, type ApiStandard } from "./types";
import { anthropicUrl, geminiUrl, modelsUrl, openaiUrl, trimBase } from "./urls";

/** Padding sizes for the two-point tokenizer calibration. */
const CAL_SMALL_CHARS = 600;
const CAL_LARGE_CHARS = 6_000;

/**
 * Prompt size for the quick truncation check.
 *
 * Bounded rather than "90% of the declared window" so a quick probe on a 1M
 * model still costs cents. 8k comfortably clears the case this whole feature
 * exists for — ollama's default `num_ctx` of 2048/4096 — and anything tighter
 * than 8k is caught too. Caps *above* 8k need the deep pass, and the UI says so.
 */
const QUICK_TRUNCATION_TOKENS = 8_192;

/** Share of the declared window the deep truncation check fills. */
const DEEP_TRUNCATION_RATIO = 0.9;

/** Output length the generation test asks for when nothing else is known. */
const DEFAULT_OUTPUT_TEST_TOKENS = 4_096;
/** …and the ceiling on it, so an opt-in test can't bill for a 64k generation. */
const MAX_OUTPUT_TEST_TOKENS = 16_384;

/** Fallback chars-per-token before calibration has run. */
const ASSUMED_CHARS_PER_TOKEN = 4;

/** Attempts per request when the failure looks transient (429 / 5xx). */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_200;

/**
 * Per-request timeout. Independent of the chat timeout on purpose: a local
 * backend handed a large context may page for minutes, and the probe must not
 * inherit a chat-sized patience.
 */
const REQUEST_TIMEOUT_MS = 180_000;

export type ProbeStage =
  | "discover"
  | "error-probe"
  | "calibrate"
  | "truncation"
  | "binary-search"
  | "output-test";

export interface ProbeTarget {
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  modelId: string;
}

export interface ProbeOptions extends ProbeTarget {
  /** The context window currently configured, used to size the deep checks. */
  claimedContext?: number;
  /** The max-output currently configured, used to size the generation test. */
  claimedMaxOutput?: number;
  /** Run the binary search and the full-window truncation check. Costs money. */
  deep?: boolean;
  /** Generate for real to measure output length. Costs output tokens. */
  measureOutput?: boolean;
  signal?: AbortSignal;
  onProgress?: (stage: ProbeStage, detail?: string) => void;
}

export type ProbeWarningCode =
  | "models-endpoint-failed"
  | "no-usage-reported"
  | "rate-limited"
  | "server-error"
  | "payload-too-large"
  | "auth-failed"
  | "param-switched"
  | "truncation-unproven"
  | "aborted";

export interface ProbeWarning {
  code: ProbeWarningCode;
  detail?: string;
}

export interface OutputTestResult {
  requested: number;
  produced: number;
  finishReason?: string;
  /** True when the server stopped us at a lower ceiling than we asked for. */
  capped: boolean;
}

export interface ProbeReport {
  findings: ProbeFinding[];
  calibration?: Calibration;
  truncation?: TruncationResult;
  outputTest?: OutputTestResult;
  /** Largest prompt accepted without a 4xx, when the deep search ran. */
  acceptedLimit?: number;
  suggestion: ProbeSuggestion;
  warnings: ProbeWarning[];
  /** What the run actually spent, for the receipt shown after it finishes. */
  spent: ProbeCost;
  probedAt: number;
}

// ─── Cost planning ───────────────────────────────────────────────────────────

export interface ProbePlanInput {
  claimedContext?: number;
  claimedMaxOutput?: number;
  deep?: boolean;
  measureOutput?: boolean;
  priceIn: number;
  priceOut: number;
}

/**
 * Up-front estimate for a probe plan. Shown before the button is pressed —
 * consenting to a cost you can't see isn't consent.
 */
export function planProbeCost(input: ProbePlanInput): ProbeCost {
  const claimed = input.claimedContext ?? 0;
  // Calibration: two short prompts.
  let inputTokens = Math.ceil((CAL_SMALL_CHARS + CAL_LARGE_CHARS) / ASSUMED_CHARS_PER_TOKEN);
  let outputTokens = 4;

  const quickTruncation = claimed > 0
    ? Math.min(QUICK_TRUNCATION_TOKENS, Math.floor(claimed * DEEP_TRUNCATION_RATIO))
    : QUICK_TRUNCATION_TOKENS;
  inputTokens += input.deep && claimed > 0
    ? Math.floor(claimed * DEEP_TRUNCATION_RATIO)
    : quickTruncation;

  if (input.deep) {
    // Binary search converges geometrically, so the sum of the probes is on the
    // order of twice the final answer.
    inputTokens += claimed > 0 ? claimed * 2 : QUICK_TRUNCATION_TOKENS * 2;
  }
  if (input.measureOutput) {
    outputTokens += outputTestTokens(input.claimedMaxOutput);
  }
  return estimateProbeCost(inputTokens, outputTokens, input.priceIn, input.priceOut);
}

function outputTestTokens(claimedMaxOutput?: number): number {
  const want = claimedMaxOutput && claimedMaxOutput > 0
    ? claimedMaxOutput
    : DEFAULT_OUTPUT_TEST_TOKENS;
  return Math.min(MAX_OUTPUT_TEST_TOKENS, want);
}

// ─── HTTP layer ──────────────────────────────────────────────────────────────

/**
 * One probe request's outcome, structured.
 *
 * A `probe() → string | null` style connection test — which is what the app had
 * — flattens exactly the fields the classifier needs (status, body, usage,
 * finish reason) into one human sentence. Everything downstream depends on
 * keeping them apart.
 */
interface RawResult {
  ok: boolean;
  status: number;
  body: string;
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string;
}

class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

/**
 * Merge the caller's cancel signal with a per-request timeout, handing back the
 * controller so a probe that only cares about the response *headers* can hang
 * up before the body is generated.
 */
function requestSignal(
  outer: AbortSignal | undefined,
  ms: number,
): { ctrl: AbortController; signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  outer?.addEventListener("abort", onAbort);
  return {
    ctrl,
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function asText(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** `choices[0]` / `candidates[0]` — the single-completion shape both APIs use. */
function firstChoice(v: unknown): Record<string, unknown> | undefined {
  return Array.isArray(v) ? asObject(v[0]) : undefined;
}

/**
 * The bare server root behind an OpenAI-compatible base URL. ollama and
 * llama.cpp expose their own richer endpoints as siblings of `/v1`, and those
 * are the most accurate sources available for local models.
 */
function serverOrigin(baseUrl: string): string {
  return trimBase(baseUrl).replace(/\/v\d+(?:beta)?$/i, "");
}

/**
 * Whether to try the local-backend endpoints. Restricted to targets that plausibly
 * are one, so a remote gateway never sees requests for paths it doesn't serve.
 */
function looksLocal(baseUrl: string): boolean {
  if (isLocalUrl(baseUrl)) return true;
  return /:(11434|1234|8080|8000)(\/|$)/.test(trimBase(baseUrl));
}

function authHeaders(t: ProbeTarget): Record<string, string> {
  switch (familyOf(t.standard)) {
    case "gemini":
      return { "Content-Type": "application/json", "x-goog-api-key": t.apiKey };
    case "anthropic":
      return anthropicHeaders(t.apiKey);
    default:
      return {
        "Content-Type": "application/json",
        ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}),
      };
  }
}

async function readJson(res: Response): Promise<unknown | undefined> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** A single chat request, non-streaming, with usage read back. */
async function chatRequest(
  t: ProbeTarget,
  prompt: string,
  maxTokens: number,
  outputParam: string,
  outer: AbortSignal | undefined,
): Promise<RawResult> {
  const { signal, done } = requestSignal(outer, REQUEST_TIMEOUT_MS);
  try {
    if (familyOf(t.standard) === "gemini") {
      const url = geminiUrl(t.baseUrl, `/models/${t.modelId}:generateContent`);
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders(t),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
        signal,
      });
      if (!res.ok) return { ok: false, status: res.status, body: await res.text() };
      const json = asObject(await readJson(res));
      const usage = asObject(json?.usageMetadata);
      return {
        ok: true,
        status: res.status,
        body: "",
        promptTokens: asCount(usage?.promptTokenCount),
        completionTokens: asCount(usage?.candidatesTokenCount),
        finishReason: asText(firstChoice(json?.candidates)?.finishReason),
      };
    }

    if (familyOf(t.standard) === "anthropic") {
      const res = await fetch(anthropicUrl(t.baseUrl, "/messages"), {
        method: "POST",
        headers: authHeaders(t),
        body: JSON.stringify({
          model: t.modelId,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
        signal,
      });
      if (!res.ok) return { ok: false, status: res.status, body: await res.text() };
      const json = asObject(await readJson(res));
      const usage = asObject(json?.usage);
      return {
        ok: true,
        status: res.status,
        body: "",
        // Anthropic splits the prompt across three disjoint buckets, so the
        // total is the sum — `input_tokens` alone under-reports a cached prompt
        // (same normalization as ai/anthropic.ts readUsage).
        promptTokens:
          (asCount(usage?.input_tokens) ?? 0) +
          (asCount(usage?.cache_read_input_tokens) ?? 0) +
          (asCount(usage?.cache_creation_input_tokens) ?? 0),
        completionTokens: asCount(usage?.output_tokens),
        finishReason: asText(json?.stop_reason),
      };
    }

    const url = openaiUrl(t.baseUrl, "/chat/completions");
    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(t),
      body: JSON.stringify({
        model: t.modelId,
        messages: [{ role: "user", content: prompt }],
        [outputParam]: maxTokens,
        stream: false,
      }),
      signal,
    });
    if (!res.ok) return { ok: false, status: res.status, body: await res.text() };
    const json = asObject(await readJson(res));
    const usage = asObject(json?.usage);
    return {
      ok: true,
      status: res.status,
      body: "",
      promptTokens: asCount(usage?.prompt_tokens),
      completionTokens: asCount(usage?.completion_tokens),
      finishReason: asText(firstChoice(json?.choices)?.finish_reason),
    };
  } finally {
    done();
  }
}

// ─── Probe session ───────────────────────────────────────────────────────────

/**
 * Mutable state threaded through one run: findings collected so far, tokens
 * spent, and the output parameter name — which can change mid-run when a model
 * rejects `max_tokens` in favor of `max_completion_tokens`.
 */
interface Session {
  target: ProbeTarget;
  signal?: AbortSignal;
  onProgress?: (stage: ProbeStage, detail?: string) => void;
  findings: ProbeFinding[];
  warnings: ProbeWarning[];
  outputParam: string;
  inputTokens: number;
  outputTokens: number;
}

function warn(s: Session, code: ProbeWarningCode, detail?: string): void {
  if (s.warnings.some((w) => w.code === code)) return;
  s.warnings.push({ code, detail });
}

function account(s: Session, r: RawResult): void {
  s.inputTokens += r.promptTokens ?? 0;
  s.outputTokens += r.completionTokens ?? 0;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Send one chat probe, retrying transient failures and switching the output
 * parameter name once if the server asks for a different one.
 *
 * The retry is what keeps a rate-limited request from being recorded as a
 * ceiling: `isTransient` outcomes never reach the caller as evidence until
 * they've survived every attempt.
 */
async function probeRequest(
  s: Session,
  prompt: string,
  maxTokens: number,
): Promise<RawResult> {
  let paramSwitched = false;
  let last: RawResult | undefined;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    throwIfAborted(s.signal);
    const res = await chatRequest(s.target, prompt, maxTokens, s.outputParam, s.signal);
    account(s, res);
    if (res.ok) return res;
    last = res;
    const info = classifyProbeError(res.status, res.body);

    if (info.kind === "param_name" && !paramSwitched && info.paramHint && info.paramHint !== s.outputParam) {
      s.outputParam = info.paramHint;
      paramSwitched = true;
      warn(s, "param-switched", info.paramHint);
      continue; // retry immediately with the name the server wants
    }
    if (!isTransient(info.kind)) return res;

    warn(s, info.kind === "rate_limit" ? "rate-limited" : "server-error");
    if (attempt < RETRY_ATTEMPTS - 1) await delay(RETRY_BASE_DELAY_MS * (attempt + 1));
  }
  return last!;
}

function confidenceForPath(path: string): FindingConfidence {
  const key = path.toLowerCase();
  // Values that describe what is *loaded and running* rather than what the
  // model theoretically supports.
  if (/max_model_len|num_ctx|n_ctx|loaded_context_length|inputtokenlimit|outputtokenlimit/.test(key)) {
    return "high";
  }
  if (/context_length|max_context_length|context_window|max_output_tokens|max_completion_tokens|maxoutputtokens/.test(key)) {
    return "medium";
  }
  return "low";
}

function findingsFrom(
  source: ProbeFinding["source"],
  entries: { context: { path: string; value: number }[]; output: { path: string; value: number }[] },
): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  for (const c of entries.context) {
    out.push({ source, detail: c.path, contextWindow: c.value, confidence: confidenceForPath(c.path) });
  }
  for (const o of entries.output) {
    out.push({ source, detail: o.path, maxOutput: o.value, confidence: confidenceForPath(o.path) });
  }
  return out;
}

// ─── Step 0: free metadata ───────────────────────────────────────────────────

async function discoverFromModelsEndpoint(s: Session): Promise<void> {
  const t = s.target;
  const { signal, done } = requestSignal(s.signal, 30_000);
  try {
    if (familyOf(t.standard) === "gemini") {
      // Gemini names both limits outright (`inputTokenLimit` /
      // `outputTokenLimit`), which makes every later step optional for it.
      const res = await fetch(geminiUrl(t.baseUrl, `/models/${t.modelId}`), {
        headers: authHeaders(t),
        signal,
      });
      if (!res.ok) return warn(s, "models-endpoint-failed", `${res.status}`);
      s.findings.push(...findingsFrom("models-endpoint", readEntryLimits(await readJson(res))));
      return;
    }

    if (familyOf(t.standard) === "anthropic") {
      // Same deal as Gemini: the per-model endpoint names both limits outright
      // (`max_input_tokens` / `max_tokens`), and both keys are already in
      // probeAnalysis's candidate lists, so readEntryLimits picks them up as-is.
      const res = await fetch(anthropicUrl(t.baseUrl, `/models/${t.modelId}`), {
        headers: authHeaders(t),
        signal,
      });
      if (!res.ok) return warn(s, "models-endpoint-failed", `${res.status}`);
      s.findings.push(...findingsFrom("models-endpoint", readEntryLimits(await readJson(res))));
      return;
    }

    const res = await fetch(modelsUrl(t.standard, t.baseUrl), { headers: authHeaders(t), signal });
    if (!res.ok) return warn(s, "models-endpoint-failed", `${res.status}`);
    const json = (await readJson(res)) as { data?: unknown[] } | undefined;
    const list = Array.isArray(json?.data) ? json!.data : [];
    // Most clients throw the whole entry away after reading `id`; the fields
    // beside it are the cheapest accurate answer this feature has.
    const entry = list.find((m) => (m as { id?: string })?.id === t.modelId);
    if (!entry) return;
    s.findings.push(...findingsFrom("models-endpoint", readEntryLimits(entry)));
  } catch (e) {
    if (e instanceof AbortedError || s.signal?.aborted) throw new AbortedError();
    warn(s, "models-endpoint-failed", e instanceof Error ? e.message : String(e));
  } finally {
    done();
  }
}

async function discoverOllama(s: Session): Promise<void> {
  const origin = serverOrigin(s.target.baseUrl);
  const { signal, done } = requestSignal(s.signal, 20_000);
  try {
    const res = await fetch(`${origin}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: s.target.modelId }),
      signal,
    });
    if (!res.ok) return;
    const json = (await readJson(res)) as Record<string, unknown> | undefined;
    if (!json) return;
    // `model_info` carries what the weights support; `parameters` carries the
    // `num_ctx` actually in force. They routinely differ by 30×, and the small
    // one wins — that mismatch *is* the silent-truncation bug.
    s.findings.push(...findingsFrom("ollama-show", readEntryLimits(json.model_info)));
    for (const p of parseOllamaParameters(json.parameters)) {
      const isCtx = p.path.endsWith("num_ctx");
      s.findings.push({
        source: "ollama-show",
        detail: p.path,
        ...(isCtx ? { contextWindow: p.value } : { maxOutput: p.value }),
        confidence: "high",
      });
    }
  } catch {
    // Not an ollama server, or not reachable — the other sources still apply.
  } finally {
    done();
  }
}

async function discoverLlamaCpp(s: Session): Promise<void> {
  const origin = serverOrigin(s.target.baseUrl);
  const { signal, done } = requestSignal(s.signal, 20_000);
  try {
    const res = await fetch(`${origin}/props`, { signal });
    if (!res.ok) return;
    const json = (await readJson(res)) as Record<string, unknown> | undefined;
    if (!json) return;
    // `default_generation_settings.n_ctx` is the server's actual `-c` value —
    // the single most trustworthy number available anywhere in this file.
    s.findings.push(...findingsFrom("llamacpp-props", readEntryLimits(json.default_generation_settings)));
  } catch {
    // Not a llama.cpp server.
  } finally {
    done();
  }
}

// ─── Step 1: error probe ─────────────────────────────────────────────────────

/**
 * Ask for an impossible number of output tokens with a two-word prompt.
 *
 * Servers that enforce a limit answer with it written out in the error body,
 * which is an exact value for the price of a handful of tokens — orders of
 * magnitude cheaper than searching for the same number. Servers that don't
 * enforce it accept the request, and we hang up before they generate anything.
 */
async function errorProbe(s: Session): Promise<void> {
  // Both already got exact limits free from Step 0, and neither serves
  // /chat/completions — the endpoint this probe posts to.
  const family = familyOf(s.target.standard);
  if (family === "gemini" || family === "anthropic") return;

  const ABSURD = 10_000_000;
  let paramSwitched = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfAborted(s.signal);
    const { ctrl, done } = requestSignal(s.signal, 60_000);
    try {
      const res = await fetch(openaiUrl(s.target.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: authHeaders(s.target),
        body: JSON.stringify({
          model: s.target.modelId,
          messages: [{ role: "user", content: "hi" }],
          [s.outputParam]: ABSURD,
          // Streaming so an *accepted* probe can be cut at the first byte
          // instead of billing for however much it decides to write.
          stream: true,
        }),
        signal: ctrl.signal,
      });

      if (res.ok) {
        ctrl.abort();
        return; // no cap on the parameter — nothing learned, nothing spent
      }

      const body = await res.text();
      const info = classifyProbeError(res.status, body);

      if (info.kind === "param_name" && !paramSwitched && info.paramHint) {
        s.outputParam = info.paramHint;
        paramSwitched = true;
        warn(s, "param-switched", info.paramHint);
        continue;
      }
      if (info.kind === "payload_too_large") return warn(s, "payload-too-large");
      if (info.kind === "auth") return warn(s, "auth-failed");
      if (isTransient(info.kind)) {
        warn(s, info.kind === "rate_limit" ? "rate-limited" : "server-error");
        return;
      }
      if (info.limit === undefined) return;

      if (info.kind === "context_limit") {
        s.findings.push({
          source: "error-message", detail: "error.context_length",
          contextWindow: info.limit, confidence: "high",
        });
      } else if (info.kind === "output_limit") {
        s.findings.push({
          source: "error-message", detail: `error.${s.outputParam}`,
          maxOutput: info.limit, confidence: "high",
        });
      }
      return;
    } catch {
      if (s.signal?.aborted) throw new AbortedError();
      // An abort we issued ourselves after res.ok lands here on some runtimes,
      // as does a plain transport failure. Neither is evidence of a limit.
      return;
    } finally {
      done();
    }
  }
}

// ─── Step 2: calibration + silent-truncation check ───────────────────────────

async function calibrateTokenizer(s: Session): Promise<Calibration | undefined> {
  const small = await probeRequest(s, makePadding(CAL_SMALL_CHARS), 1);
  const large = await probeRequest(s, makePadding(CAL_LARGE_CHARS, 990001), 1);
  if (!small.ok || !large.ok) return undefined;
  if (small.promptTokens === undefined || large.promptTokens === undefined) {
    warn(s, "no-usage-reported");
    return undefined;
  }
  return calibrate(
    { chars: CAL_SMALL_CHARS, tokens: small.promptTokens },
    { chars: CAL_LARGE_CHARS, tokens: large.promptTokens },
  ) ?? undefined;
}

/**
 * Send a known-size prompt and compare it against the server's own count.
 *
 * A shortfall is proof of truncation. Agreement is *not* proof of its absence —
 * a server can report the pre-truncation count, omit usage entirely, or (via a
 * relay) invent it. That asymmetry is carried through to the report so the UI
 * can phrase the two outcomes differently.
 */
async function truncationCheck(
  s: Session,
  cal: Calibration | undefined,
  targetTokens: number,
): Promise<TruncationResult | undefined> {
  const ratio = cal?.charsPerToken ?? ASSUMED_CHARS_PER_TOKEN;
  const chars = Math.max(1_000, Math.floor(targetTokens * ratio));
  const res = await probeRequest(s, makePadding(chars, 424242), 1);

  if (!res.ok) {
    const info = classifyProbeError(res.status, res.body);
    // Being *rejected* at this size is good news: the server enforces its
    // window instead of quietly eating the head of the prompt.
    if (info.kind === "context_limit") {
      s.findings.push({
        source: "error-message", detail: "error.context_length",
        contextWindow: info.limit ?? targetTokens, confidence: info.limit ? "high" : "low",
      });
    } else if (info.kind === "payload_too_large") {
      warn(s, "payload-too-large");
    }
    return undefined;
  }

  const expected = cal
    ? expectedPromptTokens(chars, cal)
    : Math.round(chars / ASSUMED_CHARS_PER_TOKEN);
  const verdict = judgeTruncation(expected, res.promptTokens);
  if (verdict.verdict === "unknown") warn(s, "no-usage-reported");
  else if (verdict.verdict === "not-detected") warn(s, "truncation-unproven");
  return verdict;
}

// ─── Step 3: deep pass ───────────────────────────────────────────────────────

/**
 * Largest prompt the endpoint accepts, by binary search.
 *
 * Starts by testing the declared value: if it passes there is nothing to search
 * and the run costs one request. Only a failure opens the search, which then
 * converges downward — never a blind sweep from zero to an unknown ceiling.
 */
async function binarySearchAccepted(
  s: Session,
  cal: Calibration | undefined,
  claimed: number,
): Promise<number | undefined> {
  const ratio = cal?.charsPerToken ?? ASSUMED_CHARS_PER_TOKEN;
  const attempt = async (tokens: number): Promise<boolean | undefined> => {
    throwIfAborted(s.signal);
    s.onProgress?.("binary-search", tokens.toLocaleString());
    const res = await probeRequest(s, makePadding(Math.floor(tokens * ratio), 771133), 1);
    if (res.ok) return true;
    const info = classifyProbeError(res.status, res.body);
    if (info.kind === "context_limit") return false;
    // Anything not conclusively about length is not evidence of a ceiling.
    return undefined;
  };

  const top = Math.floor(claimed * DEEP_TRUNCATION_RATIO);
  if (await attempt(top) === true) return top;

  let lo = 1_024;
  let hi = top;
  let best: number | undefined;
  for (let i = 0; i < 8 && hi - lo > Math.max(1_024, lo * 0.05); i++) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await attempt(mid);
    if (r === undefined) break; // inconclusive — stop rather than guess
    if (r) { best = mid; lo = mid; } else { hi = mid; }
  }
  return best;
}

/**
 * Measure real output length.
 *
 * The task has to be one the model cannot finish naturally, or a `stop` finish
 * reason is ambiguous between "the ceiling" and "it was done talking".
 */
async function measureOutputLength(
  s: Session,
  claimedMaxOutput: number | undefined,
): Promise<OutputTestResult | undefined> {
  const requested = outputTestTokens(claimedMaxOutput);
  const prompt =
    "Count upward. Output the integers starting at 1, one per line, " +
    "with no commentary and no summary. Do not stop early.";
  const res = await probeRequest(s, prompt, requested);
  if (!res.ok || res.completionTokens === undefined) return undefined;
  const produced = res.completionTokens;
  return {
    requested,
    produced,
    finishReason: res.finishReason,
    // Stopping well short of the request without hitting a length limit means
    // the server enforces a lower ceiling than the parameter suggested.
    capped: produced < requested * 0.9,
  };
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export async function probeEndpoint(opts: ProbeOptions): Promise<ProbeReport> {
  const s: Session = {
    target: opts,
    signal: opts.signal,
    onProgress: opts.onProgress,
    findings: [],
    warnings: [],
    outputParam: "max_tokens",
    inputTokens: 0,
    outputTokens: 0,
  };

  let calibration: Calibration | undefined;
  let truncation: TruncationResult | undefined;
  let outputTest: OutputTestResult | undefined;
  let acceptedLimit: number | undefined;

  try {
    s.onProgress?.("discover");
    await discoverFromModelsEndpoint(s);
    if (looksLocal(opts.baseUrl)) {
      await discoverOllama(s);
      await discoverLlamaCpp(s);
    }

    s.onProgress?.("error-probe");
    await errorProbe(s);

    s.onProgress?.("calibrate");
    calibration = await calibrateTokenizer(s);

    // The declared window bounds the check either way: never probe past what
    // the endpoint claims, and never below what the quick pass promises.
    const declared = suggestSettings(s.findings).contextWindow ?? opts.claimedContext;
    const target = opts.deep && declared
      ? Math.floor(declared * DEEP_TRUNCATION_RATIO)
      : Math.min(QUICK_TRUNCATION_TOKENS, declared ? Math.floor(declared * DEEP_TRUNCATION_RATIO) : QUICK_TRUNCATION_TOKENS);
    if (target > 0) {
      s.onProgress?.("truncation", target.toLocaleString());
      truncation = await truncationCheck(s, calibration, target);
    }

    if (opts.deep) {
      const claimed = declared ?? opts.claimedContext;
      if (claimed && claimed > 0) {
        acceptedLimit = await binarySearchAccepted(s, calibration, claimed);
        if (acceptedLimit) {
          s.findings.push({
            source: "measured", detail: "binary-search",
            contextWindow: acceptedLimit, confidence: "high",
          });
        }
      }
    }

    if (opts.measureOutput) {
      s.onProgress?.("output-test");
      outputTest = await measureOutputLength(s, opts.claimedMaxOutput);
      if (outputTest) {
        s.findings.push({
          source: "measured", detail: "generation",
          // A capped run measures the ceiling; a clean run only proves the
          // model reached what we asked for, which is a floor, not a limit.
          maxOutput: outputTest.capped ? outputTest.produced : outputTest.requested,
          confidence: outputTest.capped ? "high" : "low",
        });
      }
    }
  } catch (e) {
    if (e instanceof AbortedError || opts.signal?.aborted) warn(s, "aborted");
    else throw e;
  }

  return {
    findings: s.findings,
    calibration,
    truncation,
    outputTest,
    acceptedLimit,
    suggestion: suggestSettings(s.findings, truncation),
    warnings: s.warnings,
    spent: estimateProbeCost(s.inputTokens, s.outputTokens, 0, 0),
    probedAt: Date.now(),
  };
}
