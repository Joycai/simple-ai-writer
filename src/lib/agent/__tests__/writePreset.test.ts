/**
 * The `write` tier's composition.
 *
 * A preset is a list, and a list drifts: the cheap way to fix "the model did
 * not do X" is to add a tool, and nothing about doing that shows up as a cost.
 * So the shape is pinned here rather than left to the ratchet — the ratchet
 * catches the tokens, these catch the *reason*, which is that this tier exists
 * to carry exactly what a document-producing task calls and nothing else.
 */
import { describe, expect, it, vi } from "vitest";

// The registry touches the Tauri fs at import time through the write tools.
vi.mock("../../fs/fileio", () => ({
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
vi.mock("../../project", () => ({ readDirRecursive: vi.fn(async () => []) }));

import { AGENT_ASSIST_PRESET, WRITE_PRESET, presetForTools } from "../presets";
import { partitionByGroup } from "../registry";

const has = (id: string) => (WRITE_PRESET.tools as readonly string[]).includes(id);

describe("presetForTools", () => {
  it("resolves the write tier", () => {
    expect(presetForTools("write")).toBe(WRITE_PRESET);
    expect(presetForTools("full")).toBe(AGENT_ASSIST_PRESET);
    expect(presetForTools("none")).toBeNull();
  });
});

describe("the write tier carries", () => {
  it("the read tools a page is assembled from", () => {
    for (const id of ["list_files", "read_file", "search_text", "read_slides", "read_image"]) {
      expect(has(id)).toBe(true);
    }
  });

  // The task instruction says to consult the knowledge base — consult, not
  // change. Reading it is in; the machinery for editing it is not (below).
  it("read-only access to the knowledge base", () => {
    expect(has("list_lore_entities")).toBe(true);
    expect(has("read_lore_entity")).toBe(true);
  });

  it("the file-authoring tools, and the verifier", () => {
    for (const id of [
      "create_file",
      "append_file",
      "propose_edit",
      "rewrite_lines",
      "rewrite_document",
      "inspect_html",
      "export_pptx",
    ]) {
      expect(has(id)).toBe(true);
    }
  });
});

describe("the write tier does not carry", () => {
  // Every one of these is a road this task can never walk down, and each would
  // be paid for on every round of every run.
  it("anything that writes the knowledge base", () => {
    expect(has("propose_lore_plan")).toBe(false);
    const loreWriters = (AGENT_ASSIST_PRESET.tools as readonly string[]).filter(
      (id) => id.includes("lore") && !id.startsWith("read_") && !id.startsWith("list_"),
    );
    expect(loreWriters.length).toBeGreaterThan(5); // the list being tested is not empty
    for (const id of loreWriters) expect(has(id)).toBe(false);
  });

  // Approving one of these spends the author's money, and this task's graphics
  // are inline SVG by design (html-artifact-plan D3).
  it("image generation", () => {
    for (const id of ["generate_image", "edit_image", "redraw_lore_image"]) {
      expect(has(id)).toBe(false);
    }
  });

  // Both take markdown; this task's product is .html. Dropping export_docx also
  // drops the format roster that rides with it — see aiTaskStore.
  it("the exports that take markdown", () => {
    expect(has("export_docx")).toBe(false);
    expect(has("export_xlsx")).toBe(false);
    expect(has("read_doc_format")).toBe(false);
  });

  it("story memory, or anything that deletes", () => {
    for (const id of ["read_memory", "update_memory", "delete_chapter", "delete_directory"]) {
      expect(has(id)).toBe(false);
    }
  });
});

describe("the write tier is all resident", () => {
  // Deferred groups only pay off for tools gated behind something that makes
  // them fail until it opens (an approved lore plan). This tier has none of
  // those, so its whole cost is on the wire from round one — which is why the
  // list itself has to stay short rather than be deferred later.
  it("has nothing in a deferred group", () => {
    const { resident, deferred } = partitionByGroup(WRITE_PRESET.tools);
    expect(resident).toHaveLength(WRITE_PRESET.tools.length);
    expect(Object.values(deferred).every((ids) => ids.length === 0)).toBe(true);
  });
});
