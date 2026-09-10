/**
 * The composer holds *unsent* input, and the AI drawer unmounts when it closes.
 * These are the two rules that make that survivable: the setters behave like
 * `useState` setters (so the call sites read unchanged), and only sending or a
 * project switch empties the box.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { chatComposerOf, useComposerStore } from "../../stores/composerStore";
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
    s().setChatDraft("c1", "这一章想写什么");
    s().setChatRefs("c1", [loreRef("lin-shen")]);
    // A close/reopen touches nothing here — the store outlives the mount.
    expect(chatComposerOf(s(), "c1").draft).toBe("这一章想写什么");
    expect(chatComposerOf(s(), "c1").refs).toHaveLength(1);

    s().clearChatComposer("c1");
    expect(chatComposerOf(s(), "c1").draft).toBe("");
    expect(chatComposerOf(s(), "c1").refs).toEqual([]);
  });

  it("keeps a chat draft per conversation, like roleplay's per agent", () => {
    // Several conversations are open at once (agentStore.chats); a question
    // half-written for one tab must not appear under the next.
    s().setChatDraft("c1", "第三章的问题");
    s().setChatDraft("c2", (prev) => `${prev}另一段`);
    expect(chatComposerOf(s(), "c1").draft).toBe("第三章的问题");
    expect(chatComposerOf(s(), "c2").draft).toBe("另一段");
    expect(s().chat.c3).toBeUndefined();
    s().clearChatComposer("c1");
    expect(s().chat.c1).toBeUndefined();
    expect(chatComposerOf(s(), "c2").draft).toBe("另一段");
  });

  it("accepts functional updates, like the useState setters it replaced", () => {
    s().setChatDraft("c1", "第一行");
    s().setChatDraft("c1", (prev) => `${prev}\n第二行`);
    expect(chatComposerOf(s(), "c1").draft).toBe("第一行\n第二行");

    s().setPanelInstruction("要求一");
    s().setPanelInstruction((prev) => `${prev}\n要求二`);
    expect(s().panelInstruction).toBe("要求一\n要求二");

    s().setChatRefs("c1", [loreRef("wu-gang")]);
    s().setChatRefs("c1", (prev) => [...prev, loreRef("bei-ling")]);
    expect(chatComposerOf(s(), "c1").refs.map((r) => (r.kind === "lore" ? r.entity.id : ""))).toEqual([
      "wu-gang", "bei-ling",
    ]);
  });

  it("keeps a roleplay draft per agent until that agent's message is sent", () => {
    s().setRoleplayDraft("lin", "*推门进来*");
    s().setRoleplayRefs("lin", [loreRef("lin-shen")]);
    s().setRoleplayDraft("wu", (prev) => `${prev}「你来了」`);

    // Reopening the panel remounts the chat for the active agent — it reads
    // its own slot back, and never another agent's.
    expect(s().roleplay.lin).toEqual({ draft: "*推门进来*", refs: [loreRef("lin-shen")] });
    expect(s().roleplay.wu).toEqual({ draft: "「你来了」", refs: [] });
    expect(s().roleplay.nobody).toBeUndefined();

    s().clearRoleplayComposer("lin");
    expect(s().roleplay.lin).toBeUndefined();
    expect(s().roleplay.wu?.draft).toBe("「你来了」");
    // Clearing an agent that never typed is a no-op, not a new empty slot.
    s().clearRoleplayComposer("nobody");
    expect("nobody" in s().roleplay).toBe(false);
  });

  it("drops everything on a project switch", () => {
    s().setChatDraft("c1", "给这本书的问题");
    s().setRoleplayDraft("lin", "*推门进来*");
    s().setPanelOutline("大纲");
    s().setPanelKnowledge("补充设定");
    s().setPanelRequirement("要求");
    s().setPanelInstruction("指令");

    s().resetAll();

    expect(s().chat).toEqual({});
    expect(s().panelOutline).toBe("");
    expect(s().panelKnowledge).toBe("");
    expect(s().panelRequirement).toBe("");
    expect(s().panelInstruction).toBe("");
    expect(s().roleplay).toEqual({});
  });
});
