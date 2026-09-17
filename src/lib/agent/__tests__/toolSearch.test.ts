import { describe, expect, it } from "vitest";
import { groupsUsedIn, matchGroups, runSearchTools, type SearchableTools } from "../toolSearch";

const BOTH: SearchableTools = {
  file_ops: ["move_chapter", "copy_file", "delete_directory"],
  image: ["generate_image", "edit_image"],
};

describe("matchGroups", () => {
  it("matches a group by name, by tool name, and by words in either language", () => {
    expect(matchGroups("file_ops", BOTH)).toEqual(["file_ops"]);
    expect(matchGroups("edit_image", BOTH)).toEqual(["image"]);
    expect(matchGroups("Rename a chapter", BOTH)).toEqual(["file_ops"]);
    expect(matchGroups("给阿瓦画一张头像", BOTH)).toEqual(["image"]);
    expect(matchGroups("删除这个文件夹", BOTH)).toEqual(["file_ops"]);
  });

  it("does not pull the drawing tools in for a diagram the briefing wants in HTML", () => {
    expect(matchGroups("做一张流程图", BOTH)).toEqual([]);
    expect(matchGroups("an architecture chart to start", BOTH)).toEqual([]);
  });

  it("never matches a group this run does not have", () => {
    expect(matchGroups("draw a picture", { file_ops: BOTH.file_ops })).toEqual([]);
  });
});

describe("runSearchTools", () => {
  it("says there is nothing to load when the run has no handle", () => {
    expect(runSearchTools("file_ops", undefined)).toMatch(/^Error/);
  });

  it("queues the hits and reports an already-loaded group as such", () => {
    const queued: string[] = [];
    const handle = {
      groups: BOTH,
      load: (gs: readonly string[]) => void queued.push(...gs),
      isLoaded: (g: string) => g === "image",
    };
    const text = runSearchTools("move files and draw", handle);
    expect(queued).toEqual(["file_ops", "image"]);
    expect(text).toContain("Loaded file_ops: move_chapter, copy_file, delete_directory.");
    expect(text).toContain("image is already loaded");
  });
});

describe("groupsUsedIn", () => {
  it("reads both direct tool calls and earlier searches, ignoring broken arguments", () => {
    const call = (name: string, args: string) => ({
      role: "assistant" as const,
      content: null,
      tool_calls: [{ id: name, type: "function" as const, function: { name, arguments: args } }],
    });
    expect(groupsUsedIn([call("copy_file", "{}")], BOTH)).toEqual(["file_ops"]);
    expect(groupsUsedIn([call("search_tools", '{"query":"image"}')], BOTH)).toEqual(["image"]);
    expect(groupsUsedIn([call("search_tools", "{not json")], BOTH)).toEqual([]);
    expect(groupsUsedIn([{ role: "user", content: "move_chapter" }], BOTH)).toEqual([]);
  });
});

describe("a search for knowledge-base writes", () => {
  const handle = { groups: BOTH, load: () => {}, isLoaded: () => false };

  it("is sent to propose_lore_plan when the run has the plan gate", () => {
    expect(runSearchTools("更新别名 update_lore_meta", { ...handle, planGated: true }))
      .toContain("propose_lore_plan");
  });

  it("gets the plain no-match answer when it does not", () => {
    expect(runSearchTools("update lore alias", handle)).not.toContain("propose_lore_plan");
  });
});
