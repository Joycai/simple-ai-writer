/**
 * `@` mentions in the chat composer: what counts as one, and what the model
 * ends up reading.
 *
 * The detection rules are the fiddly half — an `@` is also an email, a handle,
 * and a literal character people type — and getting them wrong means the
 * picker either never opens or opens over prose.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({
  default: { t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? "【引用资料】" },
}));
vi.mock("../lore/entity", () => ({
  readEntityFile: vi.fn(async (dir: string) =>
    dir.includes("missing") ? Promise.reject(new Error("nope")) : "身高一米八，左眉有疤。"),
}));

const { findMention, filterMentions } = await import("../../components/common/MentionPicker");
const { buildChatMessage, REF_CHAR_CAP } = await import("../agent/chatRefs");

describe("findMention", () => {
  it("opens on a bare @ and tracks what follows", () => {
    expect(findMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(findMention("看看 @第三", 6)).toEqual({ start: 3, query: "第三" });
  });

  it("ignores an @ glued to a preceding word", () => {
    // An address, not a mention.
    expect(findMention("mail me at rein@example", 23)).toBeNull();
  });

  it("closes once the author types a space", () => {
    // They moved on and are writing prose again.
    expect(findMention("@第三章 然后", 8)).toBeNull();
  });

  it("only considers the mention the caret is inside", () => {
    const text = "@甲 和 @乙";
    expect(findMention(text, text.length)).toEqual({ start: 5, query: "乙" });
  });

  it("finds nothing when there is no @ before the caret", () => {
    expect(findMention("普通的一句话", 5)).toBeNull();
  });
});

describe("filterMentions", () => {
  const items = [
    { type: "file" as const, file: { name: "第三章 审判.md", path: "/p/a.md", kind: "text" as const } },
    { type: "file" as const, file: { name: "第四章.md", path: "/p/b.md", kind: "text" as const } },
  ];

  it("matches anywhere in the name, not just the start", () => {
    // A chapter is recalled by a word from its title far more often than by
    // its numbering.
    expect(filterMentions(items, "审判")).toHaveLength(1);
  });

  it("is case-insensitive and returns everything for an empty query", () => {
    expect(filterMentions(items, "")).toHaveLength(2);
    expect(filterMentions([{ type: "file", file: { name: "Chapter.md", path: "/p/c.md", kind: "text" } }], "chap"))
      .toHaveLength(1);
  });
});

describe("buildChatMessage", () => {
  const loreRef = {
    kind: "lore" as const,
    entity: { name: "艾尔登", dirPath: "/p/lore/elden" } as never,
  };
  const fileRef = (content: string) => ({
    kind: "text" as const,
    file: { name: "第三章.md", path: "/p/writing/第三章.md", kind: "text" as const },
    content,
  });

  it("puts the author's own words last", async () => {
    // Everything above is material for carrying them out, so they should be
    // the most recent thing the model reads.
    const out = await buildChatMessage("改一下这段", "原文片段", [loreRef]);
    expect(out.trim().endsWith("改一下这段")).toBe(true);
    expect(out.indexOf("原文片段")).toBeLessThan(out.indexOf("艾尔登"));
  });

  it("inlines a lore entry's body rather than just naming it", async () => {
    const out = await buildChatMessage("看看", undefined, [loreRef]);
    expect(out).toContain("## 艾尔登");
    expect(out).toContain("左眉有疤");
  });

  it("survives an unreadable entry", async () => {
    const broken = { kind: "lore" as const, entity: { name: "幽灵", dirPath: "/p/lore/missing" } as never };
    const out = await buildChatMessage("看看", undefined, [broken]);
    expect(out).toContain("幽灵");
    expect(out).toMatch(/unavailable/);
  });

  it("inlines a short file whole", async () => {
    const out = await buildChatMessage("看看", undefined, [fileRef("短短一段")]);
    expect(out).toContain("--- 第三章.md ---");
    expect(out).toContain("短短一段");
    expect(out).not.toMatch(/truncated/);
  });

  it("caps a long file and says where the rest is", async () => {
    // Silent truncation would leave the assistant confidently reasoning about
    // half a chapter; naming read_file gives it a way to get the rest.
    const long = "字".repeat(REF_CHAR_CAP + 500);
    const out = await buildChatMessage("看看", undefined, [fileRef(long)]);
    expect(out).toMatch(/truncated — 500 more chars/);
    expect(out).toContain("/p/writing/第三章.md");
    expect(out.length).toBeLessThan(long.length);
  });

  it("carries no reference block when there are none", async () => {
    expect(await buildChatMessage("你好")).toBe("你好");
  });

  it("drops images, which a string message cannot carry", async () => {
    const image = {
      kind: "image" as const,
      file: { name: "a.png", path: "/p/a.png", kind: "image" as const },
      dataUrl: "data:image/png;base64,aGk=",
    };
    const out = await buildChatMessage("看看", undefined, [image]);
    expect(out).toBe("看看");
  });
});
