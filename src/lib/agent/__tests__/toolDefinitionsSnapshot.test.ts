/**
 * What the model is sent about every tool, byte for byte.
 *
 * Taken before `registry.ts` was split by domain (docs/feature/code-structure-plan.md
 * P6) and not to be updated by a refactor: the split moves where a tool is
 * declared, never what the wire carries. The order of `ALL_TOOL_IDS` and of
 * each searchable group is part of it — `search_tools`' catalogue and the
 * Anthropic cached prefix both follow declaration order.
 *
 * A change to a tool's description or schema *does* update this snapshot —
 * that is a deliberate wire change, and `agentToolBudget.test.ts` prices it.
 */
import { describe, expect, it, vi } from "vitest";

// The registry reaches the Tauri fs at import time through the write tools;
// nothing here executes one. Same mock set as agentToolSchema.test.ts, minus
// the i18n stub: the real strings are what this pins.
vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
  writeBinaryFile: vi.fn(async () => {}),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
  copyPath: vi.fn(async () => {}),
  makeDir: vi.fn(async () => {}),
  fileExists: vi.fn(async () => false),
  removeDir: vi.fn(async () => {}),
  removeFile: vi.fn(async () => {}),
  renamePath: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
}));
vi.mock("../../project", () => ({ readDirRecursive: vi.fn(async () => []) }));

import { ALL_TOOL_IDS, getToolDefinitions, partitionByGroup } from "../registry";

describe("tool definitions on the wire", () => {
  it("declaration order", () => {
    expect(ALL_TOOL_IDS).toMatchSnapshot();
  });

  it("every definition, widest catalogue", () => {
    expect(JSON.stringify(getToolDefinitions(ALL_TOOL_IDS), null, 1)).toMatchSnapshot();
  });

  it("every definition, with page-reading search", () => {
    expect(JSON.stringify(getToolDefinitions(ALL_TOOL_IDS, undefined, true), null, 1)).toMatchSnapshot();
  });

  it("resident / deferred split of the whole registry", () => {
    expect(partitionByGroup(ALL_TOOL_IDS)).toMatchSnapshot();
  });
});
