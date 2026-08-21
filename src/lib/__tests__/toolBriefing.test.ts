/**
 * The read-tier tool briefing (lib/agent/presets → toolBriefingFor).
 *
 * What this guards is a *silence*, which is why it is worth a test at all: the
 * briefing's absence broke nothing, typed fine and produced plausible output —
 * the model simply wrote from the seeded context instead of looking anything
 * up, at random, on the tasks where looking things up is the whole point.
 */
import { describe, expect, it } from "vitest";
import i18n from "../../i18n";
import { toolBriefingFor } from "../agent/presets";
import { DEFAULT_TASKS } from "../profile/model";
import { promptParams } from "../profile/active";

const params = () => promptParams(true);

describe("toolBriefingFor", () => {
  it("briefs the read tier and nothing else", () => {
    expect(toolBriefingFor("read", params())).not.toBe("");
    // "full" tasks carry their own briefing in the task layer, and a task with
    // no tools would be paying for a description of tools it never sends.
    expect(toolBriefingFor("full", params())).toBe("");
    expect(toolBriefingFor("none", params())).toBe("");
  });

  it("names the read tools the preset actually sends", () => {
    // A briefing that advertises a tool the request withholds teaches the model
    // to call something that comes back "Unknown tool".
    const text = toolBriefingFor("read", params());
    for (const name of ["list_lore_entities", "read_lore_entity", "search_text", "read_file"]) {
      expect(text).toContain(name);
    }
    for (const write of ["propose_edit", "update_lore_file", "create_chapter"]) {
      expect(text).not.toContain(write);
    }
  });

  it("resolves its term placeholders instead of shipping them raw", () => {
    const text = toolBriefingFor("read", params());
    expect(text).not.toMatch(/\{\{/);
    expect(text).toContain("知识库"); // {{kb}} and {{knowledge}} both land here
  });

  it("covers 续写 — the task the gap was found on", () => {
    const cont = DEFAULT_TASKS.find((t) => t.id === "continue")!;
    expect(cont.tools).toBe("read");
    expect(toolBriefingFor(cont.tools, params())).not.toBe("");
  });

  it("has an English translation too, so it is not a zh-only instruction", async () => {
    const prev = i18n.language;
    try {
      await i18n.changeLanguage("en");
      const en = toolBriefingFor("read", promptParams(false));
      expect(en).not.toBe("");
      expect(en).not.toMatch(/\{\{/);
      expect(en).toContain("list_lore_entities");
    } finally {
      await i18n.changeLanguage(prev);
    }
  });
});
