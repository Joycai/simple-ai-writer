/**
 * A ratchet on what the toolset costs every request.
 *
 * This number is not an incidental one. The assistant preset's schemas ride on
 * **every round** of a run — forty of them at the cap — and nothing about
 * adding a tool makes that cost visible in a diff. So it is pinned here: going
 * over means someone decides to, and the decision shows up as an edit to the
 * constant rather than as a slow drift nobody signed off on.
 *
 * Measured against the **whole preset**, before `routeTools` narrows it. The
 * routed set changes with the author's subagent switches and the pptx Beta
 * flag, so ratcheting on it would make flipping a switch look like a
 * regression.
 *
 * If a new tool genuinely belongs in the assistant, raise the cap in the same
 * commit and say why. If several are landing at once, that is the signal to
 * read docs/feature/agent/agent-tool-context-lld.md §5 instead — deferred loading is the
 * answer to "the toolset keeps growing", not a bigger number here.
 */
import { describe, expect, it, vi } from "vitest";

// The registry reaches the Tauri fs at import time through the write tools;
// nothing here executes one. Same mock set as agentToolSchema.test.ts.
vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
  writeBinaryFile: vi.fn(async () => {}),
  makeDir: vi.fn(async () => {}),
  fileExists: vi.fn(async () => false),
  removeDir: vi.fn(async () => {}),
  removeFile: vi.fn(async () => {}),
  renamePath: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
}));
vi.mock("../project", () => ({ readDirRecursive: vi.fn(async () => []) }));
vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));

import { getToolDefinitions, partitionByGroup } from "../agent/registry";
import { AGENT_ASSIST_PRESET, CONTINUE_PRESET } from "../agent/presets";
import { NARRATOR_PRESET, ROLEPLAY_PRESET } from "../roleplay/presets";
import { estimateToolsTokens } from "../ai/tokenEstimate";

/** Measured 9,609 at 1.22.0. Headroom for wording, not for a new tool. */
const AGENT_ASSIST_CAP = 10_000;
/** The read tier a 续写 carries. Measured 1,738. */
const CONTINUE_CAP = 2_000;
/** 旁白 reads other scenes and can write back; 扮演 is deliberately tiny. */
const NARRATOR_CAP = 7_000;
const ROLEPLAY_CAP = 2_500;

const tokensOf = (preset: { tools: readonly string[] }) =>
  estimateToolsTokens(getToolDefinitions(preset.tools as never));

describe("tool schema budget", () => {
  it.each([
    ["agent-assist", AGENT_ASSIST_PRESET, AGENT_ASSIST_CAP],
    ["continue", CONTINUE_PRESET, CONTINUE_CAP],
    ["roleplay-narrator", NARRATOR_PRESET, NARRATOR_CAP],
    ["roleplay-character", ROLEPLAY_PRESET, ROLEPLAY_CAP],
  ])("%s stays within its per-request budget", (_name, preset, cap) => {
    expect(tokensOf(preset)).toBeLessThanOrEqual(cap);
  });

  it("keeps the assistant's resident half well under the full toolset", () => {
    // What a conversation actually pays before it touches the knowledge base —
    // which is most conversations. Measured 7,067 of 9,609 at 1.22.0.
    const { resident } = partitionByGroup(AGENT_ASSIST_PRESET.tools);
    const residentTokens = estimateToolsTokens(getToolDefinitions(resident));
    expect(residentTokens).toBeLessThanOrEqual(7_400);
    // A guard against the deferral quietly becoming a no-op: someone drops the
    // `group` tag off a tool and the only symptom is a bigger bill.
    expect(tokensOf(AGENT_ASSIST_PRESET) - residentTokens).toBeGreaterThan(2_000);
  });

  it("prices the tools that routing appends, which this file's preset caps cannot see", () => {
    // `delegate` and `translate` are added by `routeTools`, not listed in any
    // preset — they depend on the author's switches, which the preset layer
    // cannot know. That keeps them outside the caps above, so their cost is
    // pinned here instead. Without this, "append in routing" would be a way to
    // add tools that no ratchet ever measures.
    //
    // Measured 504 — delegate 287, translate 217. Note these are not additive
    // with the caps above in practice: a conversation carries at most the ones
    // its author has switched on.
    const appended = estimateToolsTokens(getToolDefinitions(["delegate", "translate"]));
    expect(appended).toBeLessThanOrEqual(600);
  });

  it("gives every tool a description worth its place", () => {
    // A tool the model can see but can't tell apart from its neighbours is
    // worse than no tool: it costs schema tokens *and* buys a wrong call.
    for (const def of getToolDefinitions([...AGENT_ASSIST_PRESET.tools, "delegate", "translate"])) {
      expect(def.function.description.trim().length).toBeGreaterThan(40);
      // The category placeholder is substituted per call — one that survives
      // into the wire means the model is being shown literal `{{…}}`.
      expect(def.function.description).not.toContain("{{");
    }
  });
});
