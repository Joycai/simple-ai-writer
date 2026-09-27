/**
 * The model-id axis — everything the app knows about a model id without asking
 * the endpoint (docs/api/capability-resolution-lld.md §3.1, §3.2, P2).
 *
 * Seven tables used to hold it, with four ways of matching an id. P2 put them
 * behind one pattern type and one row matcher; the file snapshot below was
 * taken from the old tables *before* that move, and every answer they gave —
 * output caps, the strict-schema list, each platform's calibration, each
 * per-model verdict — must still be given. A deliberate change to one of those
 * facts updates the snapshot, and the diff names the id.
 */
import { describe, expect, it } from "vitest";
import { PLATFORM_CELLS, familyVerdict, platformModelCalibration, type CapabilityId } from "../capabilities";
import { patternMatches, rawModelKey } from "../capability/modelId";
import { knownJsonSchemaModel } from "../jsonMode";
import { knownMaxOutput } from "../modelLimits";
import { PLATFORM_IDS, type PlatformId } from "../platforms";
import type { ProtocolFamily } from "../types";

/**
 * Ids each old table was written for: every output-cap prefix, every strict-schema
 * prefix, each platform's calibrated ids, the ids DashScope's code-interpreter
 * lists name or ought to, and the GPT ids the effort and temperature cells name.
 */
const IDS = [
  // Output caps
  "gpt-6", "gpt-5", "gpt-4.1", "gpt-4o", "gpt-4-turbo", "gpt-4", "gpt-3.5", "o4-mini", "o3", "o1",
  "gemini-3", "gemini-2.5", "gemini-2.0", "gemini-1.5", "deepseek-reasoner", "deepseek-chat", "deepseek-flash",
  "qwen-max", "qwen-plus", "qwen-turbo", "qwen3.8-flash", "qwen3.7-flash", "qwen3-vl-plus", "deepseek-v4-pro",
  "glm-5.2", "kimi-k3", "glm-5", "glm-4.7", "glm-4.6", "glm-4.6v", "glm-4.5", "glm-4.5v", "minimax-m2.5",
  // Strict schema
  "qwen3.7-plus", "qwen3.7-max", "qwen3.8-max", "doubao-seed-2.1", "doubao-seed-2-1-251015", "doubao-seed-2.0-lite",
  "claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-5", "claude-opus-4.5",
  "claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4.5", "claude-haiku-4-5", "claude-haiku-4.5", "claude-3-7-sonnet",
  // Per-platform calibration
  "glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.1", "glm-5-turbo", "glm-4.5-air",
  "openai/gpt-6-luna", "openai/gpt-6-sol", "openai/gpt-6-astra", "openai/gpt-5.6-luna", "openai/gpt-5.6-terra",
  "openai/gpt-5.6-sol", "anthropic/claude-sonnet-5", "anthropic/claude-opus-5.5", "anthropic/claude-fable-5.1",
  "google/gemini-3.8-flash",
  // DashScope's code interpreter, and ids near its patterns
  "qwen3-max", "qwen3-max-2025-09-23", "qwen3-max-preview", "qwen3.5-plus", "qwen3.5-plus-2026-01-01",
  "qwen3.6-max", "qwen3.7-flash-preview", "qwen3.5-flash-0915", "qwen3.5-397b-a17b", "qwen3.5-27b", "qwen3.5-omni-plus",
  "qwen3.8-27b", "qwen3.8-1.5t", "qwen3.6-35b-a3b", "qwen3.6-27b", "qwen3-235b-a22b-thinking-2507",
  "deepseek-v4.1-flash-0813", "qwen3.9-plus",
  // Effort and temperature cells
  "gpt-5.4", "gpt-5.4-mini", "gpt-5.3", "gpt-5.10", "gpt-5.6-sol", "gpt-5.6-terra",
  "grok-4.3", "grok-4-fast-non-reasoning", "no-such-model",
];

/** How an id may arrive: as typed, shouted with spaces, behind a namespace, dated, behind a relay's bracket. */
const variants = (id: string): string[] => [id, `  ${id.toUpperCase()}  `, `vendor/${id}`, `${id}-2026-01-01`, `[x]${id}`];

/** The (platform, family, capability) cells that are decided per model id. */
const PER_MODEL: readonly [PlatformId, ProtocolFamily, CapabilityId][] = [
  ["dashscope", "openai", "code_interpreter"], ["dashscope", "responses", "code_interpreter"],
  ["dashscope-intl", "openai", "code_interpreter"], ["dashscope-intl", "responses", "code_interpreter"],
  ["openai", "openai", "effortWithTools"], ["openai", "responses", "temperature"],
  ["orcarouter", "openai", "effortWithTools"], ["orcarouter", "openai", "reasoningOff"],
  ["orcarouter", "openai", "effortMax"], ["orcarouter", "openai", "effortMinimal"],
  ["orcarouter", "responses", "reasoningOff"], ["orcarouter", "responses", "temperature"],
];

function axis(): string {
  const out: string[] = ["# per id: max output · strict schema"];
  for (const id of IDS) {
    for (const v of variants(id)) out.push(`${JSON.stringify(v)} ${knownMaxOutput(v) ?? "-"} ${knownJsonSchemaModel(v) ? "strict" : "-"}`);
  }
  out.push("", "# platform calibration");
  for (const platform of PLATFORM_IDS) {
    for (const id of IDS) {
      for (const v of variants(id)) {
        const cal = platformModelCalibration(platform, v);
        if (cal) out.push(`${platform} ${JSON.stringify(v)} ${JSON.stringify(Object.fromEntries(Object.entries(cal).sort()))}`);
      }
    }
  }
  out.push("", "# per-model verdicts");
  for (const [platform, family, cap] of PER_MODEL) {
    for (const id of ["", ...IDS]) {
      for (const v of id ? variants(id) : [""]) {
        const { status, reason } = familyVerdict(cap, platform, family, { modelId: v || undefined });
        out.push(`${platform} ${family} ${cap} ${JSON.stringify(v)} ${status} ${reason}`);
      }
    }
  }
  return `${out.join("\n")}\n`;
}

describe("the model-id axis", () => {
  it("answers what the old tables answered", async () => {
    await expect(axis()).toMatchFileSnapshot("./__snapshots__/modelIdAxis.txt");
  });

  /**
   * Rows are consulted in specificity order, and among regexes in the order
   * written — so two regexes in one block that both match an id and disagree
   * about a fact would make the answer depend on which was written first. That
   * is never what a measurement means: a carve-out gets an exact id or a longer
   * prefix, which outrank a regex by construction (capability-resolution-lld §3.2).
   */
  it("never has two regex rows in one block disagree about the same id", () => {
    const clashes: string[] = [];
    const keys = IDS.flatMap(variants).map(rawModelKey);
    for (const [platform, cells] of Object.entries(PLATFORM_CELLS)) {
      for (const [family, block] of Object.entries(cells.families ?? {})) {
        const regexRows = (block?.models ?? []).filter((r) => r.match instanceof RegExp);
        for (const key of keys) {
          const said = new Map<string, unknown>();
          for (const row of regexRows) {
            if (!patternMatches(row.match, key)) continue;
            for (const [fact, value] of Object.entries(row.set)) {
              if (said.has(fact) && said.get(fact) !== value) clashes.push(`${platform}/${family} ${fact} ${key}`);
              said.set(fact, value);
            }
          }
        }
      }
    }
    expect(clashes).toEqual([]);
  });
});
