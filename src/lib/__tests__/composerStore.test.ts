/**
 * The composer holds *unsent* input, and the AI drawer unmounts when it closes.
 * These are the two rules that make that survivable: the setters behave like
 * `useState` setters (so the call sites read unchanged), and only sending or a
 * project switch empties the box.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useComposerStore } from "../../stores/composerStore";
import type { AttachedLore } from "../lore/aiTask";
import type { LoreEntity } from "../lore/model";

const loreRef = (id: string): AttachedLore => ({
  kind: "lore",
  entity: {
    id, category: "characters", dirPath: `/p/.ai-writer/lore/characters/${id}`,
    name: id, aliases: [], summary: "", avatarPath: null,
    collections: [],
    mdFiles: ["index.md"], images: [], facets: [],
  } as LoreEntity,
});

const s = () => useComposerStore.getState();

describe("composerStore", () => {
  beforeEach(() => s().resetAll());

  it("keeps the chat draft until the message is sent", () => {
    s().setChatDraft("这一章想写什么");
    s().setChatRefs([loreRef("lin-shen")]);
    // A close/reopen touches nothing here — the store outlives the mount.
    expect(s().chatDraft).toBe("这一章想写什么");
    expect(s().chatRefs).toHaveLength(1);

    s().clearChatComposer();
    expect(s().chatDraft).toBe("");
    expect(s().chatRefs).toEqual([]);
  });

  it("accepts functional updates, like the useState setters it replaced", () => {
    s().setChatDraft("第一行");
    s().setChatDraft((prev) => `${prev}\n第二行`);
    expect(s().chatDraft).toBe("第一行\n第二行");

    s().setPanelInstruction("要求一");
    s().setPanelInstruction((prev) => `${prev}\n要求二`);
    expect(s().panelInstruction).toBe("要求一\n要求二");

    s().setChatRefs([loreRef("wu-gang")]);
    s().setChatRefs((prev) => [...prev, loreRef("bei-ling")]);
    expect(s().chatRefs.map((r) => (r.kind === "lore" ? r.entity.id : ""))).toEqual([
      "wu-gang", "bei-ling",
    ]);
  });

  it("drops everything on a project switch", () => {
    s().setChatDraft("给这本书的问题");
    s().setPanelOutline("大纲");
    s().setPanelKnowledge("补充设定");
    s().setPanelRequirement("要求");
    s().setPanelInstruction("指令");

    s().resetAll();

    expect(s().chatDraft).toBe("");
    expect(s().panelOutline).toBe("");
    expect(s().panelKnowledge).toBe("");
    expect(s().panelRequirement).toBe("");
    expect(s().panelInstruction).toBe("");
  });
});
