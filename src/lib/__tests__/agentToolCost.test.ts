/**
 * What the toolset costs a request (lib/agent/toolCost) — the number every
 * budget decision now subtracts before it plans anything.
 *
 * Two properties are worth pinning, and they are the two that were wrong before
 * this module existed: the measurement follows the *routed* toolset (what the
 * wire actually carries), and it follows the *active profile* (the registry
 * patches category ids into the schemas, so a novel's measurement is not a
 * TTRPG project's).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The registry pulls in the write tools, which reach for the Tauri-backed fs at
// import time. Nothing here executes a tool, so bare mocks are enough — same
// set agentToolSchema.test.ts uses for the same reason.
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

import {
  __resetToolCostCache,
  messageCeilingFor,
  plannedToolTokens,
  toolTokensOf,
} from "../agent/toolCost";
import { AGENT_ASSIST_PRESET, CONTINUE_PRESET, LORE_GENERATE_PRESET } from "../agent/presets";
import { resetActiveWorkspace, setActiveWorkspace } from "../profile/active";
import { resolveWorkspace } from "../profile/resolve";
import { NOVEL_PROFILE, TTRPG_PROFILE } from "../profile/model";
import type { SubAgentConfig, SubAgentKind } from "../agent/subagent";

afterEach(() => {
  resetActiveWorkspace();
  __resetToolCostCache();
});

/** Every subagent off — the default, and what routing strips the most for. */
const NO_SUBS: Record<SubAgentKind, SubAgentConfig> = {
  search: { kind: "search", modelId: null, enabled: false },
  vision: { kind: "vision", modelId: null, enabled: false },
  longread: { kind: "longread", modelId: null, enabled: false },
  pdf: { kind: "pdf", modelId: null, enabled: false },
  imagegen: { kind: "imagegen", modelId: null, enabled: false },
  translate: { kind: "translate", modelId: null, enabled: false },
  writer: { kind: "writer", modelId: null, enabled: false },
  retrieval: { kind: "retrieval", modelId: null, enabled: false },
};

describe("toolTokensOf", () => {
  it("is zero for a toolless preset, so a plain completion pays nothing", () => {
    expect(toolTokensOf(LORE_GENERATE_PRESET.tools)).toBe(0);
  });

  it("grows with the toolset", () => {
    expect(toolTokensOf(AGENT_ASSIST_PRESET.tools))
      .toBeGreaterThan(toolTokensOf(CONTINUE_PRESET.tools));
  });

  it("follows the active profile rather than the first one loaded", () => {
    // The memo is keyed on the category ids for exactly this reason: the
    // registry patches them into the schemas, so caching on tool ids alone
    // would keep serving a closed project's measurement.
    setActiveWorkspace(resolveWorkspace([NOVEL_PROFILE]));
    const novel = toolTokensOf(["create_lore_entity", "list_lore_entities"]);
    setActiveWorkspace(resolveWorkspace([TTRPG_PROFILE]));
    const ttrpg = toolTokensOf(["create_lore_entity", "list_lore_entities"]);
    expect(ttrpg).not.toBe(novel);
  });
});

describe("plannedToolTokens", () => {
  it("measures the routed toolset, not the raw preset", () => {
    // With no imagegen subagent and the pptx Beta off, routing drops those
    // tools — a budget taken from the unrouted preset describes a request
    // nobody sends.
    expect(plannedToolTokens(AGENT_ASSIST_PRESET, NO_SUBS, []))
      .toBeLessThan(toolTokensOf(AGENT_ASSIST_PRESET.tools));
  });

  it("is zero for a null preset (a task with no tools at all)", () => {
    expect(plannedToolTokens(null, NO_SUBS, [])).toBe(0);
  });
});

describe("messageCeilingFor", () => {
  it("hands back the input ceiling minus the toolset", () => {
    const tools = plannedToolTokens(AGENT_ASSIST_PRESET, NO_SUBS, []);
    expect(messageCeilingFor(100_000, 0.5, AGENT_ASSIST_PRESET, NO_SUBS, []))
      .toBe(50_000 - tools);
  });

  it("never goes negative on a window smaller than the toolset", () => {
    expect(messageCeilingFor(1_000, 0.5, AGENT_ASSIST_PRESET, NO_SUBS, [])).toBe(0);
  });

  it("leaves a toolless run's ceiling untouched", () => {
    expect(messageCeilingFor(100_000, 0.5, null, NO_SUBS, [])).toBe(50_000);
  });
});
