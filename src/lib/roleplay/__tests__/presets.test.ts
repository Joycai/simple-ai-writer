/**
 * 不变量三的回归测试：隔离是结构性的。
 *
 * 角色之间读不到对方，不是因为提示词请它们别看，而是因为扮演 preset 的工具
 * 集里根本没有那些名字。这条断言的价值全在「将来有人往里加工具」的那一刻。
 */

import { describe, expect, it } from "vitest";
import { NARRATOR_PRESET, ROLEPLAY_PRESET, presetFor } from "../presets";

const SCENE_TOOLS = [
  "list_scenes", "read_scene", "search_scenes", "read_scene_summary", "read_scene_memory",
];

describe("ROLEPLAY_PRESET", () => {
  it("has no scene tools — a character cannot reach another's transcript", () => {
    for (const tool of SCENE_TOOLS) {
      expect(ROLEPLAY_PRESET.tools).not.toContain(tool);
    }
  });

  it("writes nothing but its own memory — not the manuscript, not the lore", () => {
    const writes = ROLEPLAY_PRESET.tools.filter(
      (t) => t.startsWith("propose_") || t.startsWith("create_") || t.startsWith("update_")
        || t.startsWith("append_") || t.startsWith("delete_") || t.startsWith("rewrite_")
        || t.startsWith("edit_") || t.startsWith("move_"),
    );
    expect(writes).toEqual([]);
    expect(ROLEPLAY_PRESET.tools).toContain("remember");
    expect(ROLEPLAY_PRESET.tools).toContain("revise_memory");
  });

  // 只增改不删是记忆的安全阀（L1 没有审批卡兜底）。工具集里出现一个删除工具，
  // 就是那条不变量被绕过去了。
  it("has no tool that can destroy a memory record", () => {
    expect(ROLEPLAY_PRESET.tools).not.toContain("forget");
    expect(NARRATOR_PRESET.tools).not.toContain("forget");
  });

  it("cannot read the manuscript — a character lives in the story, not in the files", () => {
    expect(ROLEPLAY_PRESET.tools).not.toContain("read_file");
    expect(ROLEPLAY_PRESET.tools).not.toContain("list_files");
  });

  /**
   * `search_text` 是**稿件**检索，而且排除 `.ai-writer/`——它够不到 transcript，
   * 所以它给不了「你还记得我们说过的话吗」；它能给的只有作者的稿子，而上一条
   * 断言刚说过那是不该给的。加上没有 `read_file` 去接它的「路径:行号」，它还是
   * 个死胡同。它的位置由 search_conversation / read_conversation 接替。
   */
  it("searches its own conversation, not the manuscript", () => {
    expect(ROLEPLAY_PRESET.tools).not.toContain("search_text");
    expect(ROLEPLAY_PRESET.tools).toContain("search_conversation");
    // 检索必须有配对的读，否则又是一个指向读不了的东西的工具。
    expect(ROLEPLAY_PRESET.tools).toContain("read_conversation");
  });

  // 撞到轮数上限就 force-text 收尾，因为扮演面板不渲染那张「继续/收尾」卡。
  it("ends in prose", () => {
    expect(ROLEPLAY_PRESET.finishPolicy).toBe("force-text");
    expect(ROLEPLAY_PRESET.maxRounds).toBeLessThanOrEqual(6);
  });
});

describe("NARRATOR_PRESET", () => {
  it("has every scene tool", () => {
    for (const tool of SCENE_TOOLS) {
      expect(NARRATOR_PRESET.tools).toContain(tool);
    }
  });

  it("can read a character's memory — strictly less than the transcript it already reads", () => {
    expect(NARRATOR_PRESET.tools).toContain("read_scene_memory");
  });

  // 「把对话写进正文」复用现有的写工具，不新建——见 01-overview §6 决策 3。
  it("writes the manuscript through the existing approval-gated tools", () => {
    expect(NARRATOR_PRESET.tools).toContain("propose_edit");
    expect(NARRATOR_PRESET.tools).toContain("create_chapter");
    expect(NARRATOR_PRESET.tools).toContain("append_file");
  });

  it("does not write the knowledge base in v1", () => {
    expect(NARRATOR_PRESET.tools).not.toContain("create_lore_entity");
    expect(NARRATOR_PRESET.tools).not.toContain("update_lore_file");
    expect(NARRATOR_PRESET.tools).not.toContain("propose_lore_plan");
  });
});

describe("presetFor", () => {
  it("maps each kind to its own preset", () => {
    expect(presetFor("character")).toBe(ROLEPLAY_PRESET);
    expect(presetFor("narrator")).toBe(NARRATOR_PRESET);
  });
});
