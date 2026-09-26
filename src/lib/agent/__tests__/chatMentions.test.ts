/**
 * `@` mentions in the chat composer: what counts as one, and what the model
 * ends up reading.
 *
 * The detection rules are the fiddly half — an `@` is also an email, a handle,
 * and a literal character people type — and getting them wrong means the
 * picker either never opens or opens over prose.
 */
import { describe, expect, it, vi } from "vitest";
import type { ContentPart } from "../../ai/types";

// Stands in for i18next: the default value, with `{{name}}` placeholders
// filled from the options — the interpolation is part of what the composed
// message says, so a mock that skipped it would assert on nothing.
vi.mock("../../../i18n", () => ({
  default: {
    t: (_k: string, o?: Record<string, unknown>) =>
      String(o?.defaultValue ?? "【引用资料】").replace(
        /\{\{(\w+)\}\}/g,
        (whole, key: string) => (key in (o ?? {}) ? String(o![key]) : whole),
      ),
  },
}));
// The picker's own strings go through react-i18next; same stand-in, plus a
// language switch so the English spellings can be read back.
const i18nLang = vi.hoisted(() => ({ current: "zh-CN" }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_k: string, o?: Record<string, unknown>) =>
      String(o?.defaultValue ?? _k).replace(
        /\{\{(\w+)\}\}/g,
        (whole, key: string) => (key in (o ?? {}) ? String(o![key]) : whole),
      ),
    i18n: { language: i18nLang.current },
  }),
}));
vi.mock("../../lore/entity", () => ({
  readEntityFile: vi.fn(async (dir: string) =>
    dir.includes("missing") ? Promise.reject(new Error("nope")) : "身高一米八，左眉有疤。"),
}));

const { EmptyLine, findMention, mentionKeyDown, nextLive, spliceMention, syncMention, useMentionSearch } = await import("../../../components/common/MentionPicker");
const { Highlighted } = await import("../../../components/common/Highlighted");
type MentionItem = import("../../../components/common/MentionPicker").MentionItem;
type MentionCore = import("../../../components/common/MentionPicker").MentionCore;
type MentionState = import("../../../components/common/MentionPicker").MentionState;
type MentionSearch = import("../../../components/common/MentionPicker").MentionSearch;
const { createElement } = await import("react");
const { renderToString } = await import("react-dom/server");
const { buildChatMessage, hasMessage, MAX_MESSAGE_IMAGES, REF_CHAR_CAP, refsAhead } = await import("../chatRefs");

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

// ── The mention's state transition ───────────────────────────────────────────

describe("syncMention", () => {
  const closed: MentionCore = { open: false, id: 0, query: "", active: 0, scope: "all", start: 0 };
  const inEntries: MentionCore = { open: true, id: 1, query: "潮", active: 2, scope: "lore", start: 3 };

  it("opens a fresh `@` at 全部, row 0, with the next serial", () => {
    expect(syncMention(closed, "看看@潮", 4)).toEqual({ open: true, id: 1, query: "潮", active: 0, scope: "all", start: 2 });
  });

  it("keeps the scope while the mention continues; a changed query goes back to row 0", () => {
    expect(syncMention(inEntries, "看看 @潮汐", 6)).toEqual({ ...inEntries, query: "潮汐", active: 0 });
    // Same query (a keystroke elsewhere in the text): the highlight stays.
    expect(syncMention(inEntries, "看看 @潮", 5)).toEqual({ ...inEntries, start: 3 });
  });

  it("a second `@` while one is open is a fresh mention too — the scope does not carry over", () => {
    // `@潮` in 图片, then `@` typed right after it: the picker is for the new `@`.
    expect(syncMention({ ...inEntries, scope: "image", start: 0 }, "@潮@", 3))
      .toEqual({ open: true, id: 2, query: "", active: 0, scope: "all", start: 2 });
  });

  it("closes on a terminator and forgets: reopening is a fresh `@`", () => {
    const shut = syncMention(inEntries, "看看 @潮，", 6);
    expect(shut).toEqual({ ...closed, id: 1 });
    // Backspace over the 「，」: same query as before, but 全部's list now —
    // the row index reached in 条目 would name a different item here, and a
    // pick still in flight from the old mention must not land on this one.
    expect(syncMention(shut, "看看 @潮", 5)).toEqual({ open: true, id: 2, query: "潮", active: 0, scope: "all", start: 3 });
    // Closed stays the same object, so React can bail on the no-op.
    expect(syncMention(shut, "看看 潮", 4)).toBe(shut);
  });
});

describe("nextLive", () => {
  it("follows an open mention and keeps the last one past a close — the file read outlives the mention", () => {
    const none = { id: 0, start: 0, query: "" };
    const open: MentionCore = { open: true, id: 1, query: "潮", active: 0, scope: "all", start: 2 };
    const at = nextLive(none, open);
    expect(at).toEqual({ id: 1, start: 2, query: "潮" });
    expect(nextLive(at, { ...open, query: "潮汐" })).toEqual({ id: 1, start: 2, query: "潮汐" });
    // Closed (a 「，」 typed while the picture was still decoding): unchanged,
    // so the splice still lands at 2 and not at CLOSED's 0.
    expect(nextLive(at, { ...open, open: false, start: 0, query: "" })).toBe(at);
  });
});

describe("spliceMention", () => {
  it("replaces `@query` at start with `@[label]` and keeps the rest", () => {
    expect(spliceMention("看看@潮，", 2, "潮", "潮汐.png")).toBe("看看@[潮汐.png]，");
    expect(spliceMention("@", 0, "", "沈砚")).toBe("@[沈砚]");
  });

  it("leaves the text alone when the mention is no longer there — a file read finished after the author moved on", () => {
    // Text inserted ahead of it: `start` now points into prose.
    expect(spliceMention("再看看@潮，", 2, "潮", "潮汐.png")).toBe("再看看@潮，");
    // Deleted outright.
    expect(spliceMention("看看", 2, "潮", "潮汐.png")).toBe("看看");
    // Grown under it without a `sync` (a snippet insert): `@潮` is there but
    // runs on into `汐` — replacing only `@潮` would strand the `汐`.
    expect(spliceMention("看看@潮汐，", 2, "潮", "潮汐.png")).toBe("看看@潮汐，");
    // A terminator or the end after it is fine.
    expect(spliceMention("看看@潮 ", 2, "潮", "潮汐.png")).toBe("看看@[潮汐.png] ");
    // Just landed: `@[A]` at the same `@`, an empty query — the `[` says so.
    expect(spliceMention("看看@[A.png]", 2, "", "B.png")).toBe("看看@[A.png]");
  });
});

// ── The keyboard protocol, once for all three hosts ──────────────────────────

const doc = (name: string): MentionItem =>
  ({ type: "file", file: { name, path: `/p/${name}`, kind: "text" } }) as MentionItem;
const entry = (name: string): MentionItem =>
  ({ type: "lore", entity: { name, aliases: [] } }) as unknown as MentionItem;

function fakeMention(active = 0) {
  return { active, close: vi.fn(), move: vi.fn(), cycleScope: vi.fn() };
}
function fakeSearch(over: Partial<MentionSearch> = {}): MentionSearch {
  return { open: true, scopes: ["all", "lore", "text"], items: [doc("a.md"), doc("b.md")], hits: new Map(), counts: undefined, ...over };
}
function key(k: string, shiftKey = false) {
  return { key: k, shiftKey, preventDefault: vi.fn() };
}

describe("mentionKeyDown", () => {
  it("claims nothing while the picker is off screen", () => {
    const m = fakeMention();
    const e = key("Enter");
    expect(mentionKeyDown(e, m, fakeSearch({ open: false }), false, vi.fn())).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(m.close).not.toHaveBeenCalled();
  });

  it("Escape closes the picker, mid-composition included", () => {
    const m = fakeMention();
    const e = key("Escape");
    expect(mentionKeyDown(e, m, fakeSearch(), true, vi.fn())).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(m.close).toHaveBeenCalled();
  });

  it("leaves every other key to the IME while composing", () => {
    const m = fakeMention();
    const pick = vi.fn();
    for (const k of ["Enter", "Tab", "ArrowDown"]) {
      const e = key(k);
      expect(mentionKeyDown(e, m, fakeSearch(), true, pick)).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(pick).not.toHaveBeenCalled();
    expect(m.cycleScope).not.toHaveBeenCalled();
  });

  it("Tab and Shift+Tab cycle the scope; Enter alone picks the highlighted row", () => {
    const m = fakeMention(1);
    const pick = vi.fn();
    const s = fakeSearch();
    expect(mentionKeyDown(key("Tab"), m, s, false, pick)).toBe(true);
    expect(m.cycleScope).toHaveBeenLastCalledWith(s.scopes, 1, undefined);
    expect(mentionKeyDown(key("Tab", true), m, s, false, pick)).toBe(true);
    expect(m.cycleScope).toHaveBeenLastCalledWith(s.scopes, -1, undefined);
    expect(pick).not.toHaveBeenCalled();
    expect(mentionKeyDown(key("Enter"), m, s, false, pick)).toBe(true);
    expect(pick).toHaveBeenCalledWith(s.items[1]);
    // Shift+Enter is the host's newline, not a pick.
    expect(mentionKeyDown(key("Enter", true), m, s, false, pick)).toBe(false);
  });

  it("↑ / ↓ move within the shown rows", () => {
    const m = fakeMention();
    expect(mentionKeyDown(key("ArrowDown"), m, fakeSearch(), false, vi.fn())).toBe(true);
    expect(m.move).toHaveBeenLastCalledWith(1, 2);
    expect(mentionKeyDown(key("ArrowUp"), m, fakeSearch(), false, vi.fn())).toBe(true);
    expect(m.move).toHaveBeenLastCalledWith(-1, 2);
  });

  it("from an empty list, Tab hands the counts over so the step lands where the hits are", () => {
    const m = fakeMention();
    const counts = { lore: 0, text: 0, image: 2 };
    const s = fakeSearch({ items: [], counts });
    expect(mentionKeyDown(key("Tab"), m, s, false, vi.fn())).toBe(true);
    expect(m.cycleScope).toHaveBeenLastCalledWith(s.scopes, 1, counts);
    // With rows on screen the plain step: an empty chip is a fact worth seeing.
    expect(mentionKeyDown(key("Tab"), m, fakeSearch(), false, vi.fn())).toBe(true);
    expect(m.cycleScope).toHaveBeenLastCalledWith(expect.anything(), 1, undefined);
  });

  it("still claims ↑ / ↓ on an empty list, and Enter falls back to row 0 when the highlight is past the end", () => {
    const m = fakeMention(7);
    const pick = vi.fn();
    expect(mentionKeyDown(key("ArrowDown"), m, fakeSearch({ items: [] }), false, pick)).toBe(true);
    expect(m.move).toHaveBeenLastCalledWith(1, 0);
    const s = fakeSearch();
    expect(mentionKeyDown(key("Enter"), m, s, false, pick)).toBe(true);
    expect(pick).toHaveBeenCalledWith(s.items[0]);
  });

  it("lets Enter through on an empty list when no counts were computed", () => {
    const e = key("Enter");
    expect(mentionKeyDown(e, fakeMention(), fakeSearch({ items: [], counts: undefined }), false, vi.fn())).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("swallows Enter on an empty scope only while another scope has the hit", () => {
    const m = fakeMention();
    const pick = vi.fn();
    // 条目 scope, nothing here, but the document chip holds the match: a send
    // now would carry a half-formed mention.
    const elsewhere = key("Enter");
    expect(mentionKeyDown(elsewhere, m, fakeSearch({ items: [], counts: { lore: 0, text: 1, image: 0 } }), false, pick)).toBe(true);
    expect(elsewhere.preventDefault).toHaveBeenCalled();
    // Nothing anywhere: the `@` is just an `@`, and Enter goes to the host.
    const nowhere = key("Enter");
    expect(mentionKeyDown(nowhere, m, fakeSearch({ items: [], counts: { lore: 0, text: 0, image: 0 } }), false, pick)).toBe(false);
    expect(nowhere.preventDefault).not.toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled();
  });
});

describe("useMentionSearch", () => {
  // Rendered to a string: the hook is memo and arithmetic, no effects, so a
  // server render is enough to read what it hands the host.
  function run(candidates: MentionItem[], over: Partial<MentionState>) {
    const mention = { open: true, query: "", scope: "all", active: 0, ...over } as MentionState;
    let out: MentionSearch | null = null;
    function Probe() { out = useMentionSearch(candidates, mention, "/p"); return null; }
    renderToString(createElement(Probe));
    return out!;
  }

  it("stays off screen with no candidates at all — nothing to scope", () => {
    const r = run([], { open: true });
    expect(r.open).toBe(false);
    expect(r.scopes).toEqual([]);
    expect(r.items).toEqual([]);
    expect(r.counts).toBeUndefined();
  });

  it("computes nothing while the mention is closed", () => {
    const r = run([doc("a.md")], { open: false });
    expect(r.open).toBe(false);
    expect(r.items).toEqual([]);
    expect(r.scopes).toEqual([]);
  });

  it("offers the present kinds, the scoped list, and counts only for an empty list", () => {
    const items = [entry("沈砚"), doc("第三章 潮汐门.md")];
    const all = run(items, { query: "" });
    expect(all.open).toBe(true);
    expect(all.scopes).toEqual(["all", "lore", "text"]);
    expect(all.items).toHaveLength(2);
    expect(all.counts).toBeUndefined();
    const empty = run(items, { query: "潮", scope: "lore" });
    expect(empty.items).toEqual([]);
    expect(empty.counts).toEqual({ lore: 0, text: 1, image: 0 });
  });
});

// ── What the picker draws for an empty scope, and how a hit is painted ───────

describe("EmptyLine", () => {
  const text = (el: React.ReactElement) => renderToString(el).replace(/<!-- -->/g, "");
  const line = (over: Partial<Parameters<typeof EmptyLine>[0]>) =>
    text(createElement(EmptyLine, { scope: "lore", query: "夜航", scopes: ["all", "lore", "text", "image"], counts: { lore: 0, text: 1, image: 0 }, ...over }));

  it("says what is missing here, where it is, and the key — the count in a <b>", () => {
    expect(line({})).toBe("条目里没有「夜航」<span> · 文档里有 <b>1</b> 篇</span> · <i>Tab</i> 切过去");
  });

  it("with no query, says the scope is empty rather than quoting nothing", () => {
    expect(line({ query: "  ", counts: { lore: 0, text: 3, image: 2 } }))
      .toBe("条目里还没有内容<span> · 文档里有 <b>3</b> 篇</span><span> · 图片里有 <b>2</b> 张</span> · <i>Tab</i> 切过去");
  });

  it("nothing anywhere is one plain sentence, no Tab hint", () => {
    expect(line({ counts: { lore: 0, text: 0, image: 0 } })).toBe("没有匹配「夜航」");
    expect(line({ query: "", counts: { lore: 0, text: 0, image: 0 } })).toBe("条目里还没有内容");
  });

  it("only names chips that are on offer", () => {
    expect(line({ scopes: ["all", "lore", "text"], counts: { lore: 0, text: 0, image: 5 } })).toBe("没有匹配「夜航」");
  });

  it("spells the scopes as plain plurals in English", () => {
    i18nLang.current = "en";
    try {
      expect(line({})).toBe("entries里没有「夜航」<span> · documents里有 <b>1</b> 篇</span> · <i>Tab</i> 切过去");
    } finally {
      i18nLang.current = "zh-CN";
    }
  });
});

describe("Highlighted", () => {
  const html = (t: string, ranges: { start: number; end: number }[] | undefined) =>
    renderToString(createElement(Highlighted, { text: t, ranges })).replace(/<!-- -->/g, "").replace(/ class="[^"]*"/g, "");

  it("paints each range and nothing else", () => {
    expect(html("第三章 潮汐门.md", [{ start: 4, end: 7 }])).toBe("第三章 <span>潮汐门</span>.md");
    expect(html("潮汐门", [{ start: 0, end: 3 }])).toBe("<span>潮汐门</span>");
    expect(html("ab", [{ start: 0, end: 1 }, { start: 1, end: 2 }])).toBe("<span>a</span><span>b</span>");
    expect(html("plain", [])).toBe("plain");
    expect(html("plain", undefined)).toBe("plain");
  });
});

describe("hasMessage", () => {
  it("counts words or a picture, not a bare file chip", () => {
    expect(hasMessage("  ", [])).toBe(false);
    expect(hasMessage("看看", [])).toBe(true);
    const picture = { kind: "image" as const, file: { name: "a.png", path: "/p/a.png", kind: "image" as const }, dataUrl: "data:," };
    expect(hasMessage("", [picture])).toBe(true);
    // A file with nothing asked of it is material, not a question.
    const file = { kind: "text" as const, file: { name: "a.md", path: "/p/a.md", kind: "markdown" as const }, content: "x" };
    expect(hasMessage("", [file as never])).toBe(false);
  });
});

describe("refsAhead", () => {
  it("puts handed-back chips first and does not double one already there", () => {
    const img = (name: string) =>
      ({ kind: "image" as const, file: { name, path: `/p/${name}`, kind: "image" as const }, dataUrl: "data:," });
    const out = refsAhead([img("a.png"), img("b.png")], [img("c.png"), img("a.png")]);
    expect(out.map((r) => (r.kind === "image" ? r.file.name : ""))).toEqual(["a.png", "b.png", "c.png"]);
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

  it("says where each sent picture is, relative to the project", async () => {
    // The pixels leave the context after a turn or two; this line does not.
    // Without the path, "read it again" had nothing to read.
    const out = await buildChatMessage("看看", undefined, [imageRef("a.png")], {
      allowImages: true, projectPath: "/p",
    });
    expect(out.text).toContain("1. a.png — 参考图/a.png");
    // Without a project root the absolute path still travels.
    const bare = await buildChatMessage("看看", undefined, [imageRef("a.png")], { allowImages: true });
    expect(bare.text).toContain("1. a.png — /p/参考图/a.png");
  });

  it("marks a pasted picture as session scratch", async () => {
    // A scratch file goes with the session; a link to it in the manuscript
    // would break then, so the model is told what it is.
    const pasted = {
      kind: "image" as const,
      file: { name: "粘贴的图片 1", path: "/p/.ai-writer/tmp/chat/s1/abc123def456.png", kind: "image" as const },
      dataUrl: "data:image/png;base64,x",
    };
    const out = await buildChatMessage("看看", undefined, [pasted, imageRef("b.png")], {
      allowImages: true, projectPath: "/p",
    });
    expect(out.text).toContain("1. 粘贴的图片 1 — .ai-writer/tmp/chat/s1/abc123def456.png（会话暂存，随会话删除）");
    expect(out.text).toContain("2. b.png — 参考图/b.png\n");
    // What lore matching reads names the pictures but never locates them: a
    // path or the scratch note would name entries by accident.
    expect(out.matchText).toContain("b.png");
    // A pasted picture's name is the app's, not the author's ("Pasted image"
    // holds "ted").
    expect(out.matchText).not.toContain("粘贴的图片");
    expect(out.matchText).not.toContain(".ai-writer");
    expect(out.matchText).not.toContain("参考图/");
    expect(out.matchText).not.toContain("会话暂存");
    expect(out.matchText).toContain("看看");
  });

  it("marks a pasted picture as scratch even when it cannot travel", async () => {
    // A text-only model learns of the picture only from this list — and must
    // not link a scratch path into the manuscript either.
    const pasted = {
      kind: "image" as const,
      file: { name: "粘贴的图片 1", path: "/p/.ai-writer/tmp/chat/s1/abc123def456.png", kind: "image" as const },
      dataUrl: "data:image/png;base64,x",
    };
    const out = await buildChatMessage("看看", undefined, [pasted]);
    expect(out.text).toContain("abc123def456.png（会话暂存，随会话删除）");
    expect(out.matchText).not.toContain(".ai-writer");
  });

  it("sends a picture on its own as just the 【附图】 block", async () => {
    // "Screenshot, ⌘V, Enter": the picture is the question (plan §10). No
    // empty part after it — the block is the whole of the text.
    const out = await buildChatMessage("", undefined, [imageRef("a.png")], {
      allowImages: true, projectPath: "/p",
    });
    expect(out.text).toBe("【附图】\n1. a.png — 参考图/a.png");
    expect(Array.isArray(out.content)).toBe(true);
    expect(out.imagePaths).toEqual(["/p/参考图/a.png"]);
  });

  it("carries five pictures on one message", () => {
    // Pasted and @-attached share this one number (chat-image-paste-plan §3.4).
    expect(MAX_MESSAGE_IMAGES).toBe(5);
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
    // …and the reason given is the cap, not a blindness the model doesn't have.
    expect(out.text).toMatch(new RegExp(`没有随本条消息发送——单条消息最多带 ${MAX_MESSAGE_IMAGES} 张`));
    expect(out.text).not.toMatch(/读不了图/);
    expect(out.text).toContain(`${MAX_MESSAGE_IMAGES + 1}.png`);
  });
});
