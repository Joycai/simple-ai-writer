/**
 * Tool *definitions* (the wire schemas handed to the model), specifically the
 * lore-category enums that have to follow the active workspace profile.
 *
 * The registry is a module-level constant evaluated once at import, so a naive
 * `enum: loreCategoryIds()` inside it would freeze to whichever profile loaded
 * first — and then offer a TTRPG author "characters"/"world". These tests pin
 * the per-call resolution that prevents that.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The registry pulls in the write tools, which reach for the Tauri-backed fs at
// import time. Nothing here executes a tool, so a bare mock is enough.
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

import { getToolDefinitions } from "../agent/registry";
import { resetActiveProfile, setActiveProfile } from "../profile/active";
import { NOVEL_PROFILE, TTRPG_PROFILE } from "../profile/model";

afterEach(() => resetActiveProfile());

/** The `enum` of one parameter of one tool definition. */
function paramEnum(toolId: "create_lore_entity" | "move_lore_entity", param: string): string[] {
  const [def] = getToolDefinitions([toolId]);
  const props = def.function.parameters.properties as Record<string, { enum?: string[] }>;
  return props[param].enum ?? [];
}

describe("lore-category enums in tool definitions", () => {
  it("offers the novel categories by default", () => {
    expect(paramEnum("create_lore_entity", "category")).toEqual(
      NOVEL_PROFILE.categories.map((c) => c.id),
    );
  });

  it("follows the active profile", () => {
    setActiveProfile(TTRPG_PROFILE);
    const expected = TTRPG_PROFILE.categories.map((c) => c.id);
    expect(paramEnum("create_lore_entity", "category")).toEqual(expected);
    expect(paramEnum("move_lore_entity", "new_category")).toEqual(expected);
    expect(paramEnum("create_lore_entity", "category")).not.toContain("characters");
  });

  it("does not leak one profile's categories into the next resolution", () => {
    // The registry object is shared across every run, so patching it in place
    // would leave a closed project's categories in the schema for the next one.
    setActiveProfile(TTRPG_PROFILE);
    expect(paramEnum("create_lore_entity", "category")).toContain("npcs");
    setActiveProfile(NOVEL_PROFILE);
    expect(paramEnum("create_lore_entity", "category")).toContain("characters");
    expect(paramEnum("create_lore_entity", "category")).not.toContain("npcs");
  });

  it("leaves the rest of the schema intact", () => {
    setActiveProfile(TTRPG_PROFILE);
    const [def] = getToolDefinitions(["create_lore_entity"]);
    const props = def.function.parameters.properties as Record<string, unknown>;
    expect(def.function.name).toBe("create_lore_entity");
    // Sibling parameters must survive the copy that patches `category`.
    expect(Object.keys(props)).toContain("name");
    expect(Object.keys(props)).toContain("summary");
    expect(Object.keys(props)).toContain("content");
    expect(def.function.parameters.required).toBeDefined();
  });

  it("passes through tools that have no category parameter", () => {
    const [def] = getToolDefinitions(["read_file"]);
    expect(def.function.name).toBe("read_file");
  });
});
