/**
 * LIVE probe for LLD §10 item 1 — NOT part of the suite. Runs only when
 * ORCA_KEY is set.
 *
 * The agent's thinking guard cuts a round whose thinking ate half the room
 * left in the window, then retries with a fallback: `off` where the model's
 * menu on this wire has an off, else `nudge` — a notice asking it not to
 * deliberate (`runAgent`, the `thinkingCut` branch). On gemini3 and
 * claude-adaptive the menu has `off`, but the wire has no real off
 * (`offSpelling: "lowest"`): Claude goes out at `effort: low`, Gemini at
 * `thinkingLevel: LOW`. The question is whether that lowest level still thinks
 * enough to exhaust the budget again — and whether the nudge would do better.
 *
 * Five requests per model, five runs each, on one counting problem with a
 * one-number answer, through the real adapters:
 *   unset · high — what the author may have had when the guard fired;
 *   off — what the fallback sends today;
 *   high + nudge · off + nudge — the notice the other fallback sends
 *   (the app's own zh-CN text), after the question, as the runtime puts it.
 *
 * `outputTokens` counts the thinking on both wires (Anthropic's output_tokens;
 * Gemini's candidates + thoughts). Results: docs/api/landscape.md
 * 「思考回退补测」.
 */
import { describe, expect, it } from "vitest";
import zh from "../../../i18n/locales/zh-CN.json";
import { streamCompletion } from "../index";
import type { ReasoningEffort, ThinkingCategoryId } from "../reasoning";
import type { ApiStandard, AuthMode, StreamChunk, StreamMessage, StreamOptions } from "../types";

const KEY = process.env.ORCA_KEY ?? "";
const ORIGIN = "https://api.orcarouter.ai";

interface Target {
  name: string;
  standard: ApiStandard;
  baseUrl: string;
  authMode: AuthMode;
  model: string;
  category: ThinkingCategoryId;
}
const TARGETS: Target[] = [
  { name: "claude-sonnet-5", standard: "anthropic_compat", baseUrl: ORIGIN, authMode: "bearer", model: "anthropic/claude-sonnet-5", category: "claude-adaptive" },
  { name: "gemini-3.8-flash", standard: "gemini_compat", baseUrl: `${ORIGIN}/v1beta`, authMode: "bearer", model: "google/gemini-3.8-flash", category: "gemini3" },
];

const QUESTION = "How many ordered pairs of positive integers (a, b) with a ≤ 60 and b ≤ 60 make a² + b² divisible by 13? Reply with the number only.";
const ANSWER = "538";
const NUDGE = zh.ai.instructions.thinkingBudgetAnswerNow;
const RUNS = 5;

interface Variant { name: string; effort?: ReasoningEffort; nudge: boolean }
const VARIANTS: Variant[] = [
  { name: "unset", nudge: false },
  { name: "high", effort: "high", nudge: false },
  { name: "off", effort: "off", nudge: false },
  { name: "high+nudge", effort: "high", nudge: true },
  { name: "off+nudge", effort: "off", nudge: true },
];

interface Run { out: number; reasoningChars: number; cost?: number; answer: string; body?: Record<string, unknown>; error?: string }

async function once(t: Target, v: Variant): Promise<Run> {
  const messages: StreamMessage[] = [{ role: "user", content: QUESTION }];
  if (v.nudge) messages.push({ role: "user", content: NUDGE });
  const r: Run = { out: 0, reasoningChars: 0, answer: "" };
  try {
    await streamCompletion({
      standard: t.standard, baseUrl: t.baseUrl, authMode: t.authMode, apiKey: KEY, modelId: t.model,
      platform: "orcarouter", thinkingCategory: t.category, maxOutput: 32_000,
      ...(v.effort ? { reasoningEffort: v.effort } : {}),
      messages,
      onChunk: (chunk: StreamChunk) => {
        if ("text" in chunk) r.answer += chunk.text;
        if ("reasoning" in chunk) r.reasoningChars += chunk.reasoning.length;
        if ("done" in chunk) { r.out = chunk.outputTokens; r.cost = chunk.reportedCost; }
      },
      _onRequestBody: (b: unknown) => { r.body = b as Record<string, unknown>; },
    } as StreamOptions);
  } catch (e) {
    r.error = e instanceof Error ? e.message.slice(0, 160) : String(e);
  }
  r.answer = r.answer.trim();
  return r;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

describe.skipIf(!KEY)("LIVE thinking fallback — how much the lowest level still thinks", () => {
  for (const t of TARGETS) {
    it(t.name, async () => {
      let spent = 0;
      for (const v of VARIANTS) {
        const runs = await Promise.all(Array.from({ length: RUNS }, () => once(t, v)));
        spent += runs.reduce((s, r) => s + (r.cost ?? 0), 0);
        const ok = runs.filter((r) => !r.error);
        const thinking = t.standard === "anthropic_compat" ? runs[0].body?.output_config : runs[0].body?.generationConfig;
        console.log(`[fallback] ${t.name} · ${v.name}:`, JSON.stringify({
          wire: thinking,
          out: ok.map((r) => r.out),
          median: ok.length ? median(ok.map((r) => r.out)) : null,
          correct: `${ok.filter((r) => r.answer.replace(/[^0-9]/g, "") === ANSWER).length}/${ok.length}`,
          answers: ok.map((r) => r.answer.slice(0, 12)),
          errors: runs.filter((r) => r.error).map((r) => r.error),
        }));
        expect(ok.length, `${t.name} ${v.name}`).toBeGreaterThan(0);
      }
      console.log(`[fallback] ${t.name} · reported cost: $${spent.toFixed(4)}`);
    }, 1_800_000);
  }
});
