/**
 * LIVE probe for B6 — NOT part of the suite. Does an Anthropic-shaped endpoint
 * whose thinking switch really turns thinking off take a temperature other
 * than 1 while it is off (docs/issues/anthropic-temperature-thinking-off.md)?
 *
 * Runs per platform only when its key is set: MINIMAX_KEY (MiniMax's ④
 * endpoint, category `minimax`), SEEDDACE_KEY (火山方舟 Coding Plan's ④ route,
 * category `doubao-switch`).
 *
 * The adapter today omits `temperature` on these categories whatever the
 * switch says — that is the behaviour under question — so the request is the
 * real adapter's body with one field added at the fetch seam: exactly what the
 * adapter would send if the rule ruled by the wire's thinking state. The
 * `thinking` spelling, path and auth are the adapter's own.
 *
 * Three samples per platform:
 *   1. disabled + 0.3 — status, and that thinking really is off;
 *   2. disabled: 0.01, 0, 1 and no temperature, 20 runs each, on prompts with
 *      a handful of likely answers — heeded = 0.01 collapses onto one answer
 *      while no temperature does not. (Counting distinct sentences on an open
 *      prompt could not tell the two apart: every sentence differs.) Two
 *      prompts, because a model whose default already collapses one of them
 *      (MiniMax on the fruit) says nothing there.
 *   3. adaptive: 0.3 once for the status, then 0.01 against none, 20 each.
 *
 * Results: docs/api/landscape.md §7 「B6 补测」.
 */
import { afterEach, describe, expect, it } from "vitest";
import { streamCompletion } from "../index";
import { resolvePlatform } from "../platforms";
import type { ApiStandard, StreamChunk, StreamOptions } from "../types";
import type { ThinkingCategoryId } from "../reasoning";

interface Target {
  name: string;
  key: string;
  baseUrl: string;
  modelId: string;
  category: ThinkingCategoryId;
}

const TARGETS: Target[] = [
  {
    name: "MiniMax ④", key: process.env.MINIMAX_KEY ?? "",
    baseUrl: "https://api.minimaxi.com/anthropic", modelId: "MiniMax-M3", category: "minimax",
  },
  {
    name: "火山方舟 Plan ④", key: process.env.SEEDDACE_KEY ?? "",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan", modelId: "doubao-seed-2.0-mini", category: "doubao-switch",
  },
];

const STANDARD: ApiStandard = "anthropic_compat";
const PICK_PROMPTS = {
  fruit: "Name one random fruit. Reply with the single word only.",
  number: "Pick a random whole number from 1 to 50. Reply with the number only.",
};
const RUNS = 20;

/** Bodies as they left for the endpoint, after the injection. */
const sent: Record<string, unknown>[] = [];
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Route every fetch through the real one, adding `temperature` (when given) to a JSON body. */
function injectTemperature(temperature: number | undefined) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (temperature !== undefined) body.temperature = temperature;
      sent.push(body);
      init = { ...init, body: JSON.stringify(body) };
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

interface Collected { text: string; reasoning: string; error?: string }

async function ask(t: Target, effort: "off" | "on", temperature: number | undefined, prompt = "Say hello in one short sentence."): Promise<Collected> {
  injectTemperature(temperature);
  const c: Collected = { text: "", reasoning: "" };
  try {
    await streamCompletion({
      standard: STANDARD, baseUrl: t.baseUrl, apiKey: t.key, modelId: t.modelId,
      platform: resolvePlatform(undefined, t.baseUrl, STANDARD),
      thinkingCategory: t.category,
      // An on/off category: any level is "on" (adaptive); off is disabled.
      reasoningEffort: effort === "off" ? "off" : "high",
      maxOutput: 2048,
      messages: [{ role: "user", content: prompt }],
      onChunk: (chunk: StreamChunk) => {
        if ("text" in chunk) c.text += chunk.text;
        if ("reasoning" in chunk) c.reasoning += chunk.reasoning;
      },
    } as StreamOptions);
  } catch (e) {
    c.error = e instanceof Error ? e.message : String(e);
  }
  return c;
}

const lastSent = () => sent[sent.length - 1];

/** RUNS answers to one prompt, in parallel; an error is kept as its first words. */
const answers = (t: Target, effort: "off" | "on", temp: number | undefined, prompt: string) =>
  Promise.all(Array.from({ length: RUNS }, async () => {
    const c = await ask(t, effort, temp, prompt);
    return c.error ? `ERROR ${c.error.slice(0, 80)}` : c.text.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  }));

/** `{answer: count}`, most frequent first. */
const tally = (outs: string[]) => Object.fromEntries(
  Object.entries(outs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1]),
);
const log = (t: Target, what: string, v: unknown) => console.log(`[B6] ${t.name} · ${what}:`, JSON.stringify(v));

for (const t of TARGETS) {
  describe.skipIf(!t.key)(`LIVE B6 · ${t.name}`, () => {
    it("1. thinking disabled + temperature 0.3", async () => {
      const c = await ask(t, "off", 0.3);
      expect(lastSent()).toMatchObject({ thinking: { type: "disabled" }, temperature: 0.3 });
      log(t, "disabled+0.3", { error: c.error, reasoningChars: c.reasoning.length, text: c.text.slice(0, 120) });
    }, 120_000);

    it("2. thinking disabled: 0.01 / 0 / 1 / none, 20 runs each", async () => {
      for (const [name, prompt] of Object.entries(PICK_PROMPTS)) {
        for (const temp of [0.01, 0, 1, undefined]) {
          const outs = await answers(t, "off", temp, prompt);
          log(t, `${name}, disabled, temperature ${temp ?? "none"}`, tally(outs));
          expect(lastSent().thinking).toEqual({ type: "disabled" });
          expect(lastSent().temperature).toBe(temp);
        }
      }
    }, 900_000);

    it("3. thinking adaptive: 0.3 once, then 0.01 / none, 20 runs each", async () => {
      const c = await ask(t, "on", 0.3);
      expect(lastSent()).toMatchObject({ thinking: { type: "adaptive" }, temperature: 0.3 });
      log(t, "adaptive+0.3", { error: c.error, reasoningChars: c.reasoning.length, text: c.text.slice(0, 120) });
      for (const [name, prompt] of Object.entries(PICK_PROMPTS)) {
        for (const temp of [0.01, undefined]) {
          log(t, `${name}, adaptive, temperature ${temp ?? "none"}`, tally(await answers(t, "on", temp, prompt)));
        }
      }
    }, 900_000);
  });
}
