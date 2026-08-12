/**
 * `@` mentions in the chat composer: what counts as one, and what the model
 * ends up reading.
 *
 * The detection rules are the fiddly half — an `@` is also an email, a handle,
 * and a literal character people type — and getting them wrong means the
 * picker either never opens or opens over prose.
 */
import { describe, expect, it, vi } from "vitest";
import type { ContentPart } from "../ai/types";

// Stands in for i18next: the default value, with `{{name}}` placeholders
// filled from the options — the interpolation is part of what the composed
// message says, so a mock that skipped it would assert on nothing.
vi.mock("../../i18n", () => ({
  default: {
    t: (_k: string, o?: Record<string, unknown>) =>
      String(o?.defaultValue ?? "【引用资料】").replace(
        /\{\{(\w+)\}\}/g,
        (whole, key: string) => (key in (o ?? {}) ? String(o![key]) : whole),
      ),
  },
}));
vi.mock("../lore/entity", () => ({
  readEntityFile: vi.fn(async (dir: string) =>
    dir.includes("missing") ? Promise.reject(new Error("nope")) : "身高一米八，左眉有疤。"),
}));

const { findMention, filterMentions } = await import("../../components/common/MentionPicker");
const { buildChatMessage, MAX_MESSAGE_IMAGES, REF_CHAR_CAP } = await import("../agent/chatRefs");

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

  it("gives up on a run too long to be a name", () => {
    // Chinese prose has no space to end a mention. Without this the picker
    // stayed "open" for the rest of the message — invisible (nothing matched)
    // while the composer swallowed every Enter.
    const long = "@" + "字".repeat(40);
    expect(findMention(long, long.length)).toBeNull();
    const short = "@" + "字".repeat(10);
    expect(findMention(short, short.length)).toEqual({ start: 0, query: "字".repeat(10) });
  });

  it("closes on CJK punctuation, which ends a clause like a space does", () => {
    expect(findMention("参考@第三章，然后", 9)).toBeNull();
    expect(findMention("参考@第三章。", 7)).toBeNull();
  });

  it("still opens on an @ that runs straight out of Chinese prose", () => {
    // The everyday case: nobody types a space before `@` in Chinese.
    expect(findMention("参考@第三", 5)).toEqual({ start: 2, query: "第三" });
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
  const imageRef = (name: string) => ({
    kind: "image" as const,
    file: { name, path: `/p/参考图/${name}`, kind: "image" as const },
    dataUrl: `data:image/png;base64,${name}`,
  });
  /** The text half, which is what the composition rules below are about. */
  const textOf = async (...args: Parameters<typeof buildChatMessage>) =>
    (await buildChatMessage(...args)).text;

  it("puts the author's own words last", async () => {
    // Everything above is material for carrying them out, so they should be
    // the most recent thing the model reads.
    const out = await textOf("改一下这段", "原文片段", [loreRef]);
    expect(out.trim().endsWith("改一下这段")).toBe(true);
    expect(out.indexOf("原文片段")).toBeLessThan(out.indexOf("艾尔登"));
  });

  it("inlines a lore entry's body rather than just naming it", async () => {
    const out = await textOf("看看", undefined, [loreRef]);
    expect(out).toContain("## 艾尔登");
    expect(out).toContain("左眉有疤");
  });

  it("survives an unreadable entry", async () => {
    const broken = { kind: "lore" as const, entity: { name: "幽灵", dirPath: "/p/lore/missing" } as never };
    const out = await textOf("看看", undefined, [broken]);
    expect(out).toContain("幽灵");
    expect(out).toMatch(/unavailable/);
  });

  it("inlines a short file whole", async () => {
    const out = await textOf("看看", undefined, [fileRef("短短一段")]);
    expect(out).toContain("--- 第三章.md ---");
    expect(out).toContain("短短一段");
    expect(out).not.toMatch(/truncated/);
  });

  it("caps a long file and says where the rest is", async () => {
    // Silent truncation would leave the assistant confidently reasoning about
    // half a chapter; naming read_file gives it a way to get the rest.
    const long = "字".repeat(REF_CHAR_CAP + 500);
    const out = await textOf("看看", undefined, [fileRef(long)]);
    expect(out).toMatch(/truncated — 500 more chars/);
    expect(out).toContain("/p/writing/第三章.md");
    expect(out.length).toBeLessThan(long.length);
  });

  it("stops inlining once the message's whole budget is spent", async () => {
    // The per-file cap bounds one reference, not ten of them — and chat
    // history persists, so what goes in stays in for the rest of the session.
    const refs = Array.from({ length: 8 }, (_, i) => ({
      kind: "text" as const,
      file: { name: `第${i}章.md`, path: `/p/writing/${i}.md`, kind: "text" as const },
      content: "字".repeat(REF_CHAR_CAP),
    }));
    const out = await textOf("看看", undefined, refs);
    expect(out.length).toBeLessThan(REF_CHAR_CAP * 8);
    // The ones that didn't fit are still named, with a way to get them.
    expect(out).toMatch(/not inlined/);
    expect(out).toContain("/p/writing/7.md");
  });

  it("carries no reference block when there are none", async () => {
    const out = await buildChatMessage("你好");
    expect(out.text).toBe("你好");
    // A plain string, not a one-element parts array: some Gemini endpoints
    // reject the latter, and there is nothing for it to express here.
    expect(out.content).toBe("你好");
  });

  it("attaches a picture as an image part, after the words", async () => {
    const out = await buildChatMessage("这件外套什么颜色", undefined, [imageRef("外套.png")], {
      allowImages: true,
    });
    expect(Array.isArray(out.content)).toBe(true);
    const parts = out.content as ContentPart[];
    // Text first: an image ahead of the instruction reads as the subject of a
    // question that hasn't been asked yet.
    expect(parts[0]).toEqual({ type: "text", text: out.text });
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,外套.png" } });
    expect(out.imagePaths).toEqual(["/p/参考图/外套.png"]);
  });

  it("names the attached pictures, since the parts array carries no filenames", async () => {
    // "第二张图里的那件外套" only resolves if the model knows which is which.
    const out = await buildChatMessage("看看", undefined, [imageRef("a.png"), imageRef("b.png")], {
      allowImages: true,
    });
    expect(out.text).toContain("1. a.png");
    expect(out.text).toContain("2. b.png");
  });

  it("tells a text-only model the picture could not travel", async () => {
    // Silently dropping it makes the assistant look like it ignored the
    // author; naming it lets the assistant say what happened.
    const out = await buildChatMessage("看看", undefined, [imageRef("a.png")]);
    expect(typeof out.content).toBe("string");
    expect(out.imagePaths).toEqual([]);
    expect(out.text).toContain("a.png");
    expect(out.text).toMatch(/未能随本条消息发送/);
  });

  it("caps how many pictures one message carries", async () => {
    // The cap trimHistory enforces is per *message*, so without this one, ten
    // attachments would be ten base64 payloads in the one request that has to
    // succeed before any trimming ever runs.
    const refs = Array.from({ length: MAX_MESSAGE_IMAGES + 2 }, (_, i) => imageRef(`${i}.png`));
    const out = await buildChatMessage("看看", undefined, refs, { allowImages: true });
    const parts = out.content as ContentPart[];
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(MAX_MESSAGE_IMAGES);
    expect(out.imagePaths).toHaveLength(MAX_MESSAGE_IMAGES);
    // The ones that didn't fit are named rather than vanishing.
    expect(out.text).toMatch(/未能随本条消息发送/);
    expect(out.text).toContain(`${MAX_MESSAGE_IMAGES + 1}.png`);
  });
});
