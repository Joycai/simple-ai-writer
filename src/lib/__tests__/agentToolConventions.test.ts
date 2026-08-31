/**
 * The conventions the whole tool surface holds to — enforced, not documented.
 *
 * Three rounds of review over this registry each found the same shape of
 * defect: not a broken tool, but **two names for one thing**. A read tool that
 * addressed an entity by `name` while every write tool used `entity`; a picture
 * whose description was `note` to the tool that made it and `desc` to the tool
 * that edited it; a scene addressed by `agent` in the schema and called a
 * "scene id" in every sentence around it. Each cost a wrong call the author
 * had to notice, and none of them would fail a test.
 *
 * So the conventions live here. A new tool that breaks one fails this file,
 * which is the only place that can catch it — a reviewer comparing one tool
 * against forty is exactly the reader who cannot.
 *
 * Fixing a failure means either renaming the parameter or, if the convention
 * is genuinely wrong for the new case, changing it here **and** saying why.
 */
import { describe, expect, it, vi } from "vitest";

// The registry reaches the Tauri fs at import time through the write tools;
// nothing here executes one. Same mock set as agentToolSchema.test.ts.
vi.mock("../fs/fileio", () => ({
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
vi.mock("../project", () => ({ readDirRecursive: vi.fn(async () => []) }));
vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));

import {
  ALL_TOOL_IDS,
  executeRegisteredTool,
  getToolDefinitions,
  toolNeedsProject,
  type ToolContext,
  type ToolId,
} from "../agent/registry";
import { createSplitSink } from "../agent/splitTools";

/** Every tool in the registry, with its parameter names. */
const allTools = (): { id: string; params: string[]; description: string }[] =>
  getToolDefinitions(ALL_TOOL_IDS).map((def) => ({
    id: def.function.name,
    params: Object.keys(
      (def.function.parameters.properties ?? {}) as Record<string, unknown>,
    ),
    description: def.function.description,
  }));

/**
 * The guard that keeps this whole file from passing vacuously.
 *
 * Every check below is a loop over `allTools()`. If that ever came back empty
 * — a renamed export, a registry that stopped being a plain object — all of
 * them would go green while enforcing nothing, which is worse than not having
 * them. 58 tools at the time of writing; the floor only has to be low enough
 * not to trip on a deletion and high enough to prove the sweep is real.
 */
describe("the sweep itself", () => {
  it("sees the whole registry", () => {
    const tools = allTools();
    expect(tools.length).toBeGreaterThan(40);
    // Spot-check one tool from each family, so a partial derivation shows up.
    const ids = tools.map((t) => t.id);
    for (const id of ["read_file", "read_lore_entity", "read_scene", "delegate", "remember"]) {
      expect(ids).toContain(id);
    }
    // And that parameters really came through — a definition whose properties
    // failed to resolve would make every naming check trivially true.
    expect(tools.find((t) => t.id === "read_file")?.params).toContain("path");
  });
});

describe("parameter naming conventions", () => {
  /**
   * An addressing parameter is named after **what it addresses**: `entity` for
   * a knowledge-base entry, `scene` for a roleplay scene, `workflow` for a
   * card, `path` for a file. A bare `name` says nothing — and when it appeared
   * on `read_lore_entity` it disagreed with the `entity` every write tool took,
   * so the same string had two spellings depending on which tool you reached
   * for.
   *
   * `name` as a *value* is fine and stays: `create_lore_entity({name})` is the
   * name being given, not a thing being addressed.
   */
  const NAME_AS_VALUE = new Set<ToolId>(["create_lore_entity"]);

  it("addresses things by what they are, never by a bare `name`", () => {
    for (const { id, params } of allTools()) {
      if (NAME_AS_VALUE.has(id as ToolId)) continue;
      expect(params, `${id} takes a bare 'name'`).not.toContain("name");
    }
  });

  it("uses one spelling per concept across every tool", () => {
    // Each entry: the spelling that won, and the ones that must not come back.
    const canonical: Record<string, string[]> = {
      entity: ["entity_name", "lore_entity"],
      scene: ["agent", "agent_id", "scene_id"],
      // A picture's caption is `desc` — the field images.md actually has, and
      // what update_lore_image edits. `note` was generate_image's private name
      // for the same value.
      desc: ["note", "caption", "alt"],
      references: ["refs"],
      query: ["search", "text_query"],
      folder: ["dir", "directory"],
    };
    for (const { id, params } of allTools()) {
      for (const [winner, losers] of Object.entries(canonical)) {
        for (const loser of losers) {
          expect(
            params,
            `${id} uses '${loser}' where the convention is '${winner}'`,
          ).not.toContain(loser);
        }
      }
    }
  });

  /**
   * Paging forward through something long is `start_line` / `start_slide` — a
   * cursor the tool hands back in its own trailer. Reading a *named range* is
   * `from`/`to`. The two are different access patterns and keep different
   * names; what must not happen is a third spelling for either.
   */
  it("pages with a start_* cursor and reads ranges with from/to", () => {
    for (const { id, params } of allTools()) {
      for (const p of params) {
        if (/^(offset|begin|first|since)$/.test(p)) {
          throw new Error(`${id} invents a paging parameter '${p}' — use start_* or from/to`);
        }
      }
      if (params.includes("to")) {
        expect(params, `${id} has 'to' without 'from'`).toContain("from");
      }
    }
  });
});

describe("description conventions", () => {
  /**
   * The person on the other side of an approval card is **the author**. Half
   * the manuscript tools used to say "the user" while every knowledge-base
   * tool said "the author", which reads to a model as two different people —
   * and to a reader of the code as two different features.
   */
  it("calls the person 'the author', never 'the user'", () => {
    for (const { id, description } of allTools()) {
      expect(description, `${id} says "the user"`).not.toMatch(/\bthe user\b/i);
    }
  });

  /** A search tool must say how matching works, or the model writes regexes. */
  it("makes every search tool state its matching semantics", () => {
    for (const { id, description } of allTools()) {
      if (!id.startsWith("search_")) continue;
      expect(description, `${id} does not say matching is literal`).toMatch(/literal/i);
      expect(description, `${id} does not say matching is case-insensitive`)
        .toMatch(/case-insensitive/i);
    }
  });
});

describe("the open-folder fence", () => {
  /**
   * The same rule the icon rail applies to the knowledge base and the library
   * (`appStore.viewNeedsProject`), on the AI side. It cannot be a per-handler
   * check: containment is a prefix test and every absolute path is inside the
   * empty prefix, so a tool that skipped it would not fail closed — it would
   * reach the whole disk.
   */
  it("exempts only the tools that touch nothing on disk", () => {
    const free = ALL_TOOL_IDS.filter((id) => !toolNeedsProject(id));
    // The split collector appends to an in-memory sink the modal renders; its
    // run (lib/lore/splitter) is the one caller that passes no project at all.
    // Anything else added here needs a reason of that kind in its registry entry.
    expect(free.sort()).toEqual(["split_core", "split_facet"]);
  });

  it("refuses a fenced tool with no folder open, before the handler runs", async () => {
    const ctx = { projectPath: "", loreIndex: {}, multimodal: false } as ToolContext;
    const call = { id: "c1", name: "list_lore_entities", arguments: "{}" };
    const res = await executeRegisteredTool(call, ["list_lore_entities"], ctx);
    expect(res.content).toMatch(/^Error: no folder is open/);
    // Named, so the model can tell this from a tool that is merely absent.
    expect(res.content).toContain("list_lore_entities");
  });

  it("lets the exempt tools through, so a facet split still runs", async () => {
    // lib/lore/splitter's actual shape: no project, and the sink is the whole
    // of what the run needs.
    const sink = createSplitSink();
    const ctx = { projectPath: "", loreIndex: {}, multimodal: false, splitSink: sink } as ToolContext;
    const call = { id: "c2", name: "split_core", arguments: JSON.stringify({ content: "kept" }) };
    const res = await executeRegisteredTool(call, ["split_core"], ctx);
    expect(res.content).not.toMatch(/no folder is open/);
    expect(sink.core).toBe("kept");
  });
});
