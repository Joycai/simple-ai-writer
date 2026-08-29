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
// zh-CN so the category substitution renders its id(label) pairs — the case
// where the pairing exists at all (English labels mostly equal the ids).
vi.mock("../../i18n", () => ({ default: { t: (key: string) => key, language: "zh-CN" } }));

import { getToolDefinitions } from "../agent/registry";
import { resetActiveWorkspace, setActiveWorkspace } from "../profile/active";
import { resolveWorkspace } from "../profile/resolve";
import { BUILTIN_PROFILES, NOVEL_PROFILE, TTRPG_PROFILE } from "../profile/model";

afterEach(() => resetActiveWorkspace());

/** The `enum` of one parameter of one tool definition. */
function paramEnum(toolId: "create_lore_entity" | "move_lore_entity", param: string): string[] {
  const [def] = getToolDefinitions([toolId]);
  const props = def.function.parameters.properties as Record<string, { enum?: string[] }>;
  return props[param].enum ?? [];
}

describe("lore-category enums in tool definitions", () => {
  it("offers the novel categories (plus the custom bucket) by default", () => {
    expect(paramEnum("create_lore_entity", "category")).toEqual([
      ...NOVEL_PROFILE.categories.map((c) => c.id),
      "custom",
    ]);
  });

  it("follows the active workspace", () => {
    setActiveWorkspace(resolveWorkspace([TTRPG_PROFILE]));
    const expected = [...TTRPG_PROFILE.categories.map((c) => c.id), "custom"];
    expect(paramEnum("create_lore_entity", "category")).toEqual(expected);
    expect(paramEnum("move_lore_entity", "new_category")).toEqual(expected);
    expect(paramEnum("create_lore_entity", "category")).not.toContain("characters");
  });

  it("does not leak one profile's categories into the next resolution", () => {
    // The registry object is shared across every run, so patching it in place
    // would leave a closed project's categories in the schema for the next one.
    setActiveWorkspace(resolveWorkspace([TTRPG_PROFILE]));
    expect(paramEnum("create_lore_entity", "category")).toContain("npcs");
    setActiveWorkspace(resolveWorkspace([NOVEL_PROFILE]));
    expect(paramEnum("create_lore_entity", "category")).toContain("characters");
    expect(paramEnum("create_lore_entity", "category")).not.toContain("npcs");
  });

  it("leaves the rest of the schema intact", () => {
    setActiveWorkspace(resolveWorkspace([TTRPG_PROFILE]));
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
    expect(def.function.description).not.toContain("{{");
  });
});

describe("lore categories named in a tool description", () => {
  const describeOf = (id: "list_lore_entities") =>
    getToolDefinitions([id])[0].function.description;

  it("substitutes the active profile's categories as id(label) pairs", () => {
    setActiveWorkspace(resolveWorkspace([TTRPG_PROFILE]));
    const text = describeOf("list_lore_entities");
    // The label rides with the id: the id is the wire value, the label is the
    // word the author actually uses — hide it and the model reinvents 「人物」
    // beside characters (docs/feature/agent/lore-category-visibility-plan.md).
    expect(text).toContain("npcs(NPC), locations(地点)");
    // Prose listing the wrong categories misleads the model exactly as much as a
    // wrong enum would — it asks for lore the project doesn't have.
    expect(text).not.toContain("characters");
    expect(text).not.toContain("skills");
  });

  it("keeps the enum itself id-only — the label never becomes a wire value", () => {
    const [def] = getToolDefinitions(["create_lore_entity"]);
    const props = def.function.parameters.properties as Record<string, { enum?: string[] }>;
    for (const value of props.category.enum ?? []) expect(value).not.toContain("(");
  });

  it("leaves no placeholder behind for any builtin profile", () => {
    for (const profile of BUILTIN_PROFILES) {
      setActiveWorkspace(resolveWorkspace([profile]));
      expect(describeOf("list_lore_entities")).not.toContain("{{");
    }
  });
});
