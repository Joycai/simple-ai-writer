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

const { EmptyLine, acceptPick, afterAccept, caretThrough, claimOf, editRange, findMention, isMentionReading, landSelection, mentionKeyDown, selectionThrough, shiftClaims, shiftCore, spliceMention, syncMention, trackClaims, trackMentionRead, useMentionSearch } = await import("../../../components/common/MentionPicker");
const { matchesMention } = await import("../../search/mentionSearch");
const { Highlighted } = await import("../../../components/common/Highlighted");
type MentionItem = import("../../../components/common/MentionPicker").MentionItem;
type MentionCore = import("../../../components/common/MentionPicker").MentionCore;
type MentionClaim = NonNullable<ReturnType<MentionState["claim"]>>;
type MentionState = import("../../../components/common/MentionPicker").MentionState;
type MentionSearch = import("../../../components/common/MentionPicker").MentionSearch;
type TextSelection = import("../../../components/common/MentionPicker").TextSelection;
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

  it("does not reopen on a landed reference with prose typed after it", () => {
    // `@[沈砚]的性格`: the `@[` is a pick's own output; the picker must not come
    // back over an unmatchable query and eat the arrow keys for 24 characters.
    expect(findMention("看看@[潮汐.png]的", 11)).toBeNull();
    expect(findMention("看看@[潮汐.png]", 10)).toBeNull();
    // A name that itself holds an `@`: the last `@` is inside the reference.
    expect(findMention("看看@[图标@2x.png]的", 14)).toBeNull();
    expect(findMention("看看@[沈@砚]", 8)).toBeNull();
    // A closed reference followed by a new `@` opens as usual.
    expect(findMention("看看@[沈砚]@潮", 9)).toEqual({ start: 7, query: "潮" });
    // The deliberate price: an author-typed `@[` does not open either, nor
    // an `@` after it on the line — until a CJK terminator ends the would-be
    // name (a space does not: names have spaces).
    expect(findMention("看@[草", 4)).toBeNull();
    expect(findMention("@[草稿 然后 @沈", 11)).toBeNull();
    expect(findMention("@[草稿，再看看@潮", 10)).toEqual({ start: 8, query: "潮" });
    // A name with an `@` past a 「（」, where the rule above stops: the `]`
    // in the would-be query says the caret is after a landed reference.
    expect(findMention("看看@[图标（深色）@2x.png]的", 21)).toBeNull();
    // A name with paired brackets and an `@` after them: counted, not cut at
    // the first `]` — the caret after the inner `@` is inside the reference.
    expect(findMention("看看@[手稿[旧]@2x.png]的", 13)).toBeNull();
    expect(findMention("看看@[手稿[旧]@2x", 13)).toBeNull();
    // Closed by its own `]`: an `@` after it opens as usual.
    expect(findMention("看看@[手稿[旧]]@潮", 12)).toEqual({ start: 10, query: "潮" });
    // An author-typed `@[` ends at the next `@[` — a landed reference, never
    // part of a name — so an `@` after that reference opens as usual.
    expect(findMention("@[草稿 看@[潮汐.md] @夜", 17)).toEqual({ start: 15, query: "夜" });
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

describe("spliceMention", () => {
  it("replaces `@query` at start with `@[label]` and keeps the rest", () => {
    expect(spliceMention("看看@潮，", 2, "潮", "潮汐.png")).toBe("看看@[潮汐.png]，");
    expect(spliceMention("@", 0, "", "沈砚")).toBe("@[沈砚]");
    // Brackets in the name land in the shape the readers count (mentionText).
    expect(spliceMention("看看@潮，", 2, "潮", "潮汐[旧].png")).toBe("看看@[潮汐[旧].png]，");
    expect(spliceMention("看看@夜，", 2, "夜", "夜航].png")).toBe("看看@[夜航］.png]，");
  });

  it("leaves the text alone when the mention is no longer there — a file read finished after the author moved on", () => {
    // Text inserted ahead of it: `start` now points into prose.
    expect(spliceMention("再看看@潮，", 2, "潮", "潮汐.png")).toBe("再看看@潮，");
    // A reference already landed on that `@` (another instance's pick, or the
    // same `@` re-picked after an Esc): an empty query's check would pass on
    // its `@` alone, and `@[A][B]` is not a mention anything can read.
    expect(spliceMention("看看@[夜航.png]", 2, "", "潮汐.mp4")).toBe("看看@[夜航.png]");
    // But an `@` put in front of `[草稿]第一章` (`+ 引用` there) was glued to
    // that `[` from the start: the claim says so, and the pick lands.
    expect(spliceMention("@[草稿]第一章", 0, "", "沈砚.png", true)).toBe("@[沈砚.png][草稿]第一章");
    // Deleted outright.
    expect(spliceMention("看看", 2, "潮", "潮汐.png")).toBe("看看");
  });

  it("leaves what follows the mention alone — a mention typed mid-sentence has prose after it", () => {
    // `findMention` reads up to the caret: the query is `沈`, the `更生动` was always there.
    expect(spliceMention("我想让@沈更生动", 3, "沈", "沈砚")).toBe("我想让@[沈砚]更生动");
    // `+ 引用` with the caret mid-line: an empty query in front of text.
    expect(spliceMention("看看@这个", 2, "", "潮汐.png")).toBe("看看@[潮汐.png]这个");
    expect(spliceMention("(@)", 1, "", "沈砚")).toBe("(@[沈砚])");
  });
});

describe("afterAccept", () => {
  const claim = { id: 1, start: 2, query: "潮" };
  const first: MentionCore = { open: true, id: 1, query: "潮", active: 0, scope: "lore", start: 2 };
  // `@潮` → `@[潮汐.png]`: the text grew by this much.
  const delta = "@[潮汐.png]".length - "@潮".length;

  it("closes the claimed mention and keeps its serial", () => {
    expect(afterAccept(first, claim, delta)).toEqual({ open: false, id: 1, query: "", active: 0, scope: "all", start: 0 });
  });

  it("shifts a mention opened after it in the text — `@夜` typed while the file read — so its own pick still lands", () => {
    const later: MentionCore = { ...first, id: 2, query: "夜", start: 7 };
    expect(afterAccept(later, claim, delta)).toEqual({ ...later, start: 7 + delta });
  });

  it("closes a mention reopened on the same `@` (Esc during the read, then more letters): that `@` is the landed one now", () => {
    const reopened: MentionCore = { ...first, id: 2, query: "潮汐" };
    expect(afterAccept(reopened, claim, delta).open).toBe(false);
  });

  it("leaves a mention before it, and a closed state, as they are", () => {
    const earlier: MentionCore = { ...first, id: 2, query: "夜", start: 0 };
    expect(afterAccept(earlier, claim, delta)).toBe(earlier);
    const shut: MentionCore = { ...first, open: false };
    expect(afterAccept(shut, claim, delta)).toBe(shut);
  });
});

describe("trackClaims", () => {
  it("follows a claimed mention while it is open and keeps its last place past a close", () => {
    const pending = new Map<number, MentionClaim>([[1, { id: 1, start: 2, query: "潮", glued: true }]]);
    trackClaims(pending, { open: true, id: 1, query: "潮汐", active: 0, scope: "all", start: 2 });
    // `glued` rides along: it is about the claim, not the place.
    expect(pending.get(1)).toEqual({ id: 1, start: 2, query: "潮汐", glued: true });
    // A 「，」 typed while the picture was still decoding: unchanged, so the
    // splice still lands at 2 and not at CLOSED's 0.
    trackClaims(pending, { open: false, id: 1, query: "", active: 0, scope: "all", start: 0 });
    expect(pending.get(1)).toEqual({ id: 1, start: 2, query: "潮汐", glued: true });
    // Another mention, not claimed: nothing to track.
    trackClaims(pending, { open: true, id: 2, query: "夜", active: 0, scope: "all", start: 7 });
    expect(pending.size).toBe(1);
    // The same `@` reopened under a new id (Esc, then more letters): followed.
    trackClaims(pending, { open: true, id: 3, query: "潮汐门", active: 0, scope: "all", start: 2 });
    expect(pending.get(1)).toEqual({ id: 1, start: 2, query: "潮汐门", glued: true });
  });
});

describe("claimOf", () => {
  it("registers the open mention and hands back the same entry; nothing when closed", () => {
    const pending = new Map<number, MentionClaim>();
    expect(claimOf(pending, { open: false, id: 3, query: "", active: 0, scope: "all", start: 0 }, "")).toBeNull();
    expect(pending.size).toBe(0);
    const c = claimOf(pending, { open: true, id: 3, query: "潮", active: 0, scope: "all", start: 2 }, "看看@潮");
    expect(c).toEqual({ id: 3, start: 2, query: "潮", glued: false });
    expect(pending.get(3)).toEqual(c);
    // An `@` in front of `[草稿]`: the `[` was there when the claim was taken.
    const g = claimOf(pending, { open: true, id: 4, query: "", active: 0, scope: "all", start: 2 }, "看看@[草稿]第一章");
    expect(g).toMatchObject({ id: 4, glued: true });
  });
});

describe("acceptPick", () => {
  const claim = { id: 1, start: 2, query: "潮", glued: false };
  const nameHas = (label: string) => (q: string) => label.includes(q);
  const table = (...claims: MentionClaim[]) => new Map(claims.map((c) => [c.id, c]));

  it("lands once and records it: a second accept on the same mention leaves the text alone", () => {
    const spent = new Set<number>();
    const first = acceptPick(spent, table(claim), claim, "看看@潮", "潮汐.png", nameHas("潮汐.png"));
    expect(first).toEqual({ text: "看看@[潮汐.png]", landed: { id: 1, start: 2, end: 4, delta: 7 } });
    expect(spent.has(1)).toBe(true);
    // The `@` of the landed `@[潮汐.png]` is at the same start with an empty
    // query: the spent set stops it here, and `spliceMention`'s own guard
    // stops it where the set cannot see (another instance's pick).
    const again = acceptPick(spent, table(), { ...claim, query: "" }, first.text, "B.png", () => true);
    expect(again).toEqual({ text: "看看@[潮汐.png]", landed: null });
    const other = acceptPick(new Set(), table(), { id: 9, start: 2, query: "", glued: false }, first.text, "B.png", () => true);
    expect(other).toEqual({ text: "看看@[潮汐.png]", landed: null });
  });

  it("replaces the whole current query when the author kept narrowing the same mention while the file read", () => {
    expect(acceptPick(new Set(), table({ ...claim, query: "潮汐" }), claim, "看看@潮汐", "潮汐.png", nameHas("潮汐.png")).text)
      .toBe("看看@[潮汐.png]");
    // Narrowed by the group, as the picker allows: the picker's own rule decides.
    const stillListed = (q: string) => q === "插图/潮汐";
    expect(acceptPick(new Set(), table({ ...claim, query: "插图/潮汐" }), { ...claim, query: "插图/潮" }, "看看@插图/潮汐", "潮汐.png", stillListed).text)
      .toBe("看看@[潮汐.png]");
  });

  it("keeps prose typed after the mention when it is not a narrowing, and falls back to the snapshot", () => {
    expect(acceptPick(new Set(), table({ ...claim, query: "潮的图" }), claim, "看看@潮的图", "潮汐.png", nameHas("潮汐.png")).text)
      .toBe("看看@[潮汐.png]的图");
    // The grown query matches the name but is no longer in the text (「汐」
    // was selected and overtyped with 「，」: the mention closed with the claim
    // still at `潮汐`, and the text reads `@潮，`): the snapshot lands.
    expect(acceptPick(new Set(), table({ ...claim, query: "潮汐" }), claim, "看看@潮，", "潮汐.png", nameHas("潮汐.png")).text)
      .toBe("看看@[潮汐.png]，");
    // Only the tracked place is tried: a retry at the snapshot's place could
    // land on a never-picked `@潮` that happens to sit `delta` back.
    expect(acceptPick(new Set(), table({ ...claim, start: 5 }), claim, "看看@潮，看看@潮", "潮汐.png", nameHas("潮汐.png")))
      .toEqual({ text: "看看@潮，看看@潮", landed: null });
  });

  it("records and shifts nothing when nothing landed — the `@` the author is looking at is still theirs", () => {
    const spent = new Set<number>();
    const later = { id: 2, start: 7, query: "夜", glued: false };
    const pending = table(claim, later);
    // The mention was retyped as `@夜` during the read: `@潮` is gone.
    const r = acceptPick(spent, pending, claim, "看看@夜", "潮汐.png", nameHas("潮汐.png"));
    expect(r).toEqual({ text: "看看@夜", landed: null });
    expect(spent.has(1)).toBe(false);
    expect(pending.get(2)).toEqual(later);
    expect(pending.has(1)).toBe(false);
  });

  it("moves the claims after it by what the splice added", () => {
    const later = { id: 2, start: 7, query: "夜", glued: false };
    const earlier = { id: 3, start: 0, query: "", glued: false };
    const pending = table(claim, later, earlier);
    acceptPick(new Set(), pending, claim, "看看@潮，和@夜", "潮汐.png", nameHas("潮汐.png"));
    expect(pending.get(2)).toEqual({ id: 2, start: 14, query: "夜", glued: false });
    expect(pending.get(3)).toEqual(earlier);
  });
});

describe("where the caret goes after a landing", () => {
  const claim = { id: 1, start: 2, query: "潮", glued: false };
  const nameHas = (label: string) => (q: string) => label.includes(q);

  it("records the end of the `@query` it replaced: the grown one, or the snapshot's", () => {
    const grown = acceptPick(new Set(), new Map([[1, { ...claim, query: "潮汐" }]]), claim, "看看@潮汐，", "潮汐.png", nameHas("潮汐.png"));
    expect(grown).toEqual({ text: "看看@[潮汐.png]，", landed: { id: 1, start: 2, end: 5, delta: 6 } });
    // Prose typed after it that does not find the item: the snapshot's `@潮` is replaced.
    const prose = acceptPick(new Set(), new Map([[1, { ...claim, query: "潮的" }]]), claim, "看看@潮的，", "潮汐.png", nameHas("潮汐.png"));
    expect(prose).toEqual({ text: "看看@[潮汐.png]的，", landed: { id: 1, start: 2, end: 4, delta: 7 } });
  });

  it("leaves a caret before the `@`, puts one inside `@query` after the `]`, and moves one after it with the text", () => {
    const text = "看看@潮，后文";
    const r = acceptPick(new Set(), new Map([[1, claim]]), claim, text, "潮汐.png", nameHas("潮汐.png"));
    const landed = r.landed!;
    expect(r.text).toBe("看看@[潮汐.png]，后文");
    expect([0, 2].map((c) => caretThrough(c, landed))).toEqual([0, 2]);
    // Inside `@潮` or right after it — the author was typing it.
    expect([3, 4].map((c) => caretThrough(c, landed))).toEqual([11, 11]);
    expect(r.text.slice(0, 11)).toBe("看看@[潮汐.png]");
    // Typed on past it while the file read: the caret stays on the same letter.
    expect(caretThrough(6, landed)).toBe(13);
    expect(r.text.slice(13)).toBe(text.slice(6));
  });

  it("carries a selection through by both ends, keeping its direction", () => {
    const r = acceptPick(new Set(), new Map([[1, claim]]), claim, "看看@潮，后文", "潮汐.png", nameHas("潮汐.png"));
    const landed = r.landed!;
    // Wholly before the `@`, wholly after the mention: moved as the text is.
    expect(landSelection({ start: 0, end: 2, dir: "backward" }, landed)).toEqual({ start: 0, end: 2, dir: "backward" });
    expect(landSelection({ start: 5, end: 7, dir: "forward" }, landed)).toEqual({ start: 12, end: 14, dir: "forward" });
    expect(r.text.slice(12, 14)).toBe("后文");
    // From before the `@` into `@潮`: still a selection, now covering the reference.
    const across = landSelection({ start: 0, end: 4, dir: "forward" }, landed);
    expect(r.text.slice(across.start, across.end)).toBe("看看@[潮汐.png]");
  });
});

describe("a selection through an edit someone else made", () => {
  const sel = (start: number, end = start, dir: TextSelection["dir"] = "none"): TextSelection => ({ start, end, dir });
  const before = "看看@潮，后文";
  const after = "看看@[潮汐.png]，后文";

  it("leaves one before the edit, moves one after it with the text", () => {
    expect(selectionThrough(sel(0, 2), before, after)).toEqual(sel(0, 2));
    const moved = selectionThrough(sel(5, 7, "backward"), before, after);
    expect(moved).toEqual(sel(12, 14, "backward"));
    expect(after.slice(moved.start, moved.end)).toBe("后文");
  });

  it("puts a caret the author was typing `@潮` with just after the landed `]`", () => {
    expect(selectionThrough(sel(4), before, after)).toEqual(sel(11));
    expect(after.slice(0, 11)).toBe("看看@[潮汐.png]");
  });

  it("maps each end on its own: one across the edit covers the new text", () => {
    const across = selectionThrough(sel(1, 6, "forward"), before, after);
    expect(after.slice(across.start, across.end)).toBe("看@[潮汐.png]，后");
    expect(across.dir).toBe("forward");
  });

  it("puts a caret at a pure insertion's place after the inserted text, as typing would", () => {
    expect(selectionThrough(sel(2), "沈砚夜航", "沈砚与潮汐门夜航")).toEqual(sel(6));
    expect(selectionThrough(sel(1), "沈砚夜航", "沈砚与潮汐门夜航")).toEqual(sel(1));
  });

  it("goes to the end when the text replaced an empty draft or the whole of it", () => {
    expect(selectionThrough(sel(0), "", "回到这里重说")).toEqual(sel(6));
    expect(selectionThrough(sel(1, 3), "沈砚看书", "潮汐门夜航")).toEqual(sel(5));
    // A send clearing the draft.
    expect(selectionThrough(sel(2, 4), "沈砚看书", "")).toEqual(sel(0));
  });

  it("leaves a selection alone when nothing changed", () => {
    expect(selectionThrough(sel(1, 3, "backward"), before, before)).toEqual(sel(1, 3, "backward"));
  });
});

describe("a draft with a pick's file still reading", () => {
  /** A read the test settles by hand. */
  function deferred<T>() {
    let resolve!: (v: T) => void, reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it("counts from the read's start until it settles, and passes its result through", async () => {
    const read = deferred<string>();
    const tracked = trackMentionRead("chat:c1", read.promise);
    expect(isMentionReading("chat:c1")).toBe(true);
    read.resolve("潮汐.png");
    await expect(tracked).resolves.toBe("潮汐.png");
    expect(isMentionReading("chat:c1")).toBe(false);
  });

  it("stops counting a read that fails, and passes the failure through", async () => {
    const read = deferred<string>();
    const tracked = trackMentionRead("roleplay:沈砚", read.promise);
    read.reject(new Error("读不到"));
    await expect(tracked).rejects.toThrow("读不到");
    expect(isMentionReading("roleplay:沈砚")).toBe(false);
  });

  it("keeps drafts apart, and holds one until every read in it is done", async () => {
    const a = deferred<void>(), b = deferred<void>(), other = deferred<void>();
    const ta = trackMentionRead("chat:c2", a.promise);
    const tb = trackMentionRead("chat:c2", b.promise);
    const to = trackMentionRead("chat:c3", other.promise);
    a.resolve();
    await ta;
    expect(isMentionReading("chat:c2")).toBe(true);
    other.resolve();
    await to;
    expect(isMentionReading("chat:c3")).toBe(false);
    expect(isMentionReading("chat:c2")).toBe(true);
    b.resolve();
    await tb;
    expect(isMentionReading("chat:c2")).toBe(false);
  });

  it("is done by the time the code after the host's await runs", async () => {
    const read = deferred<string>();
    const seen: boolean[] = [];
    const pick = (async () => {
      await trackMentionRead("lore:r1", read.promise);
      seen.push(isMentionReading("lore:r1"));
    })();
    read.resolve("夜航");
    await pick;
    expect(seen).toEqual([false]);
  });
});

// ── The whole protocol, driven the way a host drives it ──────────────────────

describe("a pick across a file read", () => {
  const closed: MentionCore = { open: false, id: 0, query: "", active: 0, scope: "all", start: 0 };
  const pic = (rel: string): MentionItem =>
    ({ type: "file", file: { name: rel.split("/").pop()!, path: `/p/${rel}`, kind: "image" } }) as MentionItem;
  const label = (item: MentionItem) => (item.type === "file" ? item.file.name : "");

  /** A host in miniature: the state, the tables, and the four calls it makes. */
  function host() {
    let core = closed;
    const pending = new Map<number, MentionClaim>();
    const spent = new Set<number>();
    let text = "";
    const type = (next: string, caret = next.length) => { text = next; core = syncMention(core, next, caret); trackClaims(pending, core); };
    /** Another instance wrote the draft: what AgentChat's `ownDraft` effect does. */
    const external = (next: string) => { shiftClaims(pending, text, next); core = shiftCore(core, text, next); text = next; trackClaims(pending, core); };
    const claim = () => claimOf(pending, core, text)!;
    /** Tab in the picker: the host's `cycleScope`, reduced to what this test needs. */
    const narrow = (scope: MentionCore["scope"]) => { core = { ...core, scope }; };
    const accept = (value: string, item: MentionItem, c: MentionClaim) => {
      const r = acceptPick(spent, pending, c, value, label(item), (q) => matchesMention(item, q, "/p"));
      if (r.landed) { core = afterAccept(core, r.landed, r.landed.delta); trackClaims(pending, core); }
      return r.text;
    };
    return { type, external, claim, narrow, accept, state: () => core };
  }

  it("two slow files reading at once: the second lands where its mention is after the first", () => {
    const h = host();
    h.type("看看@潮");
    const a = h.claim();
    for (const t of ["看看@潮，", "看看@潮，和", "看看@潮，和@", "看看@潮，和@夜"]) h.type(t);
    const b = h.claim();
    expect(h.state()).toMatchObject({ open: true, id: 2, start: 6 });
    const afterA = h.accept("看看@潮，和@夜", pic("插图/潮汐.png"), a);
    expect(afterA).toBe("看看@[潮汐.png]，和@夜");
    expect(h.state()).toMatchObject({ open: true, id: 2, start: 13 });
    expect(h.accept(afterA, pic("插图/夜航.png"), b)).toBe("看看@[潮汐.png]，和@[夜航.png]");
    expect(h.state().open).toBe(false);
  });

  it("narrowed further, then another mention opened: the tail still goes, the later `@` stays", () => {
    const h = host();
    h.type("看看@潮");
    const a = h.claim();
    for (const t of ["看看@潮汐", "看看@潮汐，", "看看@潮汐，和@", "看看@潮汐，和@夜"]) h.type(t);
    expect(h.accept("看看@潮汐，和@夜", pic("插图/潮汐.png"), a)).toBe("看看@[潮汐.png]，和@夜");
    expect(h.state()).toMatchObject({ open: true, id: 2, query: "夜", start: 13 });
  });

  it("retyped as another name during the read: nothing lands, nothing closes, the next pick still can", () => {
    const h = host();
    h.type("看看@潮");
    const a = h.claim();
    // Esc (a terminator here), then the `@` retyped: a new mention on the same `@`.
    for (const t of ["看看@潮，", "看看@潮", "看看@", "看看@夜"]) h.type(t);
    expect(h.state()).toMatchObject({ open: true, id: 2, query: "夜", start: 2 });
    expect(h.accept("看看@夜", pic("插图/潮汐.png"), a)).toBe("看看@夜");
    expect(h.state()).toMatchObject({ open: true, id: 2, query: "夜" });
    const b = h.claim();
    expect(h.accept("看看@夜", pic("插图/夜航.png"), b)).toBe("看看@[夜航.png]");
  });

  it("Esc during the read, then the same name typed on: the reopened `@` is the claimed one, no tail", () => {
    const h = host();
    h.type("看看@潮");
    const a = h.claim();
    // Esc closes; the next letter reopens the same `@` under a new id.
    h.type("看看@潮，");
    for (const t of ["看看@潮", "看看@潮汐"]) h.type(t);
    expect(h.state()).toMatchObject({ open: true, id: 2, query: "潮汐", start: 2 });
    expect(h.accept("看看@潮汐", pic("插图/潮汐.png"), a)).toBe("看看@[潮汐.png]");
    expect(h.state().open).toBe(false);
  });

  it("accept fed the draft as it is now keeps what was typed since, and never lands on a landed reference", () => {
    // The chat composer remounts per conversation: the old instance keeps
    // its table but sees no more typing. What its host feeds `accept` is the
    // store's current draft (AgentChat does that through the store updater;
    // that line has no test of its own) — so what the author typed after
    // coming back stays.
    const old = host();
    old.type("帮我看看这张图@潮");
    const a = old.claim();
    const typedSince = "帮我看看这张图@潮汐，再和上一版对比";
    expect(old.accept(typedSince, pic("插图/潮汐.png"), a)).toBe("帮我看看这张图@[潮汐.png]汐，再和上一版对比");
    // Text inserted ahead of the `@` in the meantime: only the chip, no splice.
    const moved = host();
    moved.type("看看@潮");
    const m = moved.claim();
    expect(moved.accept("先看看@潮", pic("插图/潮汐.png"), m)).toBe("先看看@潮");
    // A bare `@` picked in the old instance, then picked again in the new one
    // before the first read finished: the new one's reference stands alone.
    const stale = host();
    stale.type("看看@");
    const s = stale.claim();
    const fresh = host();
    fresh.type("看看@");
    for (const t of ["看看@夜"]) fresh.type(t);
    const landedFirst = fresh.accept("看看@夜", pic("夜航.png"), fresh.claim());
    expect(landedFirst).toBe("看看@[夜航.png]");
    expect(stale.accept(landedFirst, pic("插图/潮汐.mp4"), s)).toBe("看看@[夜航.png]");
  });

  it("a reference landed ahead by another instance moves the open mention, keeping its scope and its waiting pick", () => {
    // A1 (unmounted) had `@潮` reading; A2 typed `，和@夜`, switched to 图片 and
    // picked a slow file there. A1 lands first, into the store; A2 sees the
    // draft change that was not its own.
    const a2 = host();
    for (const t of ["看看@潮，和@", "看看@潮，和@夜"]) a2.type(t);
    a2.narrow("image");
    const b = a2.claim();
    a2.external("看看@[潮汐.png]，和@夜");
    expect(a2.state()).toMatchObject({ open: true, id: 1, query: "夜", scope: "image", start: 13 });
    expect(a2.accept("看看@[潮汐.png]，和@夜", pic("插图/夜航.png"), b)).toBe("看看@[潮汐.png]，和@[夜航.png]");
    expect(a2.state().open).toBe(false);
    // Landed on the mention itself (`@潮` → `@[潮汐.png]汐`): the picker closes.
    const same = host();
    same.type("看看@潮汐");
    same.external("看看@[潮汐.png]汐");
    expect(same.state().open).toBe(false);
    // An empty query on that `@` (the author deleted back to a bare `@`): the
    // span starts right after the `@`, and the mention still closes — left
    // open, its next pick would be glued to the reference just landed.
    const bare = host();
    for (const t of ["看看@潮", "看看@"]) bare.type(t);
    bare.external("看看@[潮汐.png]");
    expect(bare.state().open).toBe(false);
    expect(shiftCore({ open: true, id: 1, query: "", active: 0, scope: "all", start: 2 }, "看看@", "看看@[x]").open).toBe(false);
    // A landing on a *later* `@` leaves this one where it is.
    const other = host();
    other.type("看@潮@", 3);
    other.external("看@潮@[夜航.png]");
    expect(other.state()).toMatchObject({ open: true, query: "潮", start: 1 });
    // The `@` glued to prose `[草稿]`: the landed `[潮汐.png]` shares its `[`
    // with the old text, so the greedy span sits one further right — the
    // mention on that `@` still closes.
    const glued = host();
    for (const t of [["看[草稿]第一章", 1], ["看@[草稿]第一章", 2]] as const) glued.type(t[0], t[1]);
    glued.external("看@[潮汐.png][草稿]第一章");
    expect(glued.state().open).toBe(false);
    // …and a glued pick still waiting on that `@` loses its `glued`: the `[`
    // after it is now the landed reference, and the guard applies.
    const waiting = host();
    waiting.type("看@[草稿]第一章", 2);
    const w = waiting.claim();
    expect(w.glued).toBe(true);
    waiting.type("看@[草稿]第一章，", 2);
    waiting.external("看@[潮汐.png][草稿]第一章，");
    expect(waiting.accept("看@[潮汐.png][草稿]第一章，", pic("沈砚.png"), w)).toBe("看@[潮汐.png][草稿]第一章，");
  });

  it("the edit moves a waiting pick whether its mention is closed, mid-sentence, or one of two alike", () => {
    // (a) closed by typing on: the claim at 6 must still move.
    const closed = host();
    for (const t of ["看看@潮，和@", "看看@潮，和@夜"]) closed.type(t);
    const a = closed.claim();
    closed.type("看看@潮，和@夜，");
    expect(closed.state().open).toBe(false);
    closed.external("看看@[潮汐.png]，和@夜，");
    expect(closed.accept("看看@[潮汐.png]，和@夜，", pic("插图/夜航.png"), a)).toBe("看看@[潮汐.png]，和@[夜航.png]，");
    // (b) open mid-sentence, caret after 夜: moved, same id and query.
    const mid = host();
    mid.type("看看@潮，和@夜再说", 8);
    const m = mid.claim();
    mid.external("看看@[潮汐.png]，和@夜再说");
    expect(mid.state()).toMatchObject({ open: true, id: 1, query: "夜", start: 13 });
    expect(mid.accept("看看@[潮汐.png]，和@夜再说", pic("插图/夜航.png"), m)).toBe("看看@[潮汐.png]，和@[夜航.png]再说");
    // (c) the same query twice, the pick on the first: it lands there, not on the second.
    const twice = host();
    twice.type("看看@潮，和@夜，还有@夜", 8);
    const w = twice.claim();
    twice.external("看看@[潮汐.png]，和@夜，还有@夜");
    expect(twice.accept("看看@[潮汐.png]，和@夜，还有@夜", pic("插图/夜航.png"), w)).toBe("看看@[潮汐.png]，和@[夜航.png]，还有@夜");
  });

  it("an `@` put in front of `[草稿]` lands its pick; a reference landed there since does not", () => {
    const h = host();
    h.type("@[草稿]第一章", 1);
    const g = h.claim();
    expect(g.glued).toBe(true);
    expect(h.accept("@[草稿]第一章", pic("沈砚.png"), g)).toBe("@[沈砚.png][草稿]第一章");
    // The same `@`, a slow pick waiting, then Esc, reopen, and a sync pick
    // that lands first: the `[` after the `@` is now that reference, and the
    // slow pick must not stack a third one in front of it.
    const twice = host();
    twice.type("@[草稿]第一章", 1);
    const slow = twice.claim();
    twice.type("，[草稿]第一章", 1);
    for (const t of [["@[草稿]第一章", 1], ["@沈[草稿]第一章", 2]] as const) twice.type(t[0], t[1]);
    const quick = twice.claim();
    const landed = twice.accept("@沈[草稿]第一章", pic("沈砚.png"), quick);
    expect(landed).toBe("@[沈砚.png][草稿]第一章");
    expect(twice.accept(landed, pic("插图/潮汐.png"), slow)).toBe("@[沈砚.png][草稿]第一章");
  });

  it("editRange bounds one replaced span, never overlapping prefix and suffix", () => {
    expect(editRange("看看@潮，和@夜", "看看@[潮汐.png]，和@夜")).toEqual({ start: 3, end: 4, delta: 7, lo: 3 });
    expect(editRange("abc", "abc")).toEqual({ start: 3, end: 3, delta: 0, lo: 3 });
    // A pure insertion of a repeat can be read anywhere along the repeat.
    expect(editRange("aa", "aaa")).toEqual({ start: 2, end: 2, delta: 1, lo: 0 });
    expect(editRange("看看@潮汐", "看看@[潮汐.png]汐")).toEqual({ start: 3, end: 4, delta: 7, lo: 3 });
    expect(editRange("看@[草稿]", "看@[潮汐.png][草稿]")).toEqual({ start: 3, end: 3, delta: 8, lo: 2 });
    // Every empty-query landing — a pure insertion, the one shape whose span
    // is ambiguous: `lo` still sits right after the `@` that got the
    // reference, so the mention on it closes and no other. A non-empty query
    // is a replacement, which starts right after the `@` anyway (a query
    // never opens with `[` or holds `]`); the explicit cases above pin that.
    const texts = ["看看@", "看看@潮", "看@[草稿]第一章", "@潮@潮", "看看@，和@夜", "@[沈砚]@", "a@b @c"];
    const labels = ["潮汐.png", "[草稿]第一章.md", "沈砚", "@2x.png"];
    for (const text of texts) {
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== "@") continue;
        for (const label of labels) {
          const after = `${text.slice(0, i)}@[${label}]${text.slice(i + 1)}`;
          expect(editRange(text, after).lo, `${text} @${i} ${label}`).toBe(i + 1);
          const on = shiftCore({ open: true, id: 1, query: "", active: 0, scope: "all", start: i }, text, after);
          expect(on.open, `${text} @${i} ${label}`).toBe(false);
        }
      }
    }
  });

  it("narrowed by group while the file read: the picker's rule sees it and no tail is left", () => {
    const h = host();
    for (const t of ["看看@", "看看@插", "看看@插图", "看看@插图/", "看看@插图/潮"]) h.type(t);
    const a = h.claim();
    h.type("看看@插图/潮汐");
    expect(h.accept("看看@插图/潮汐", pic("插图/潮汐.png"), a)).toBe("看看@[潮汐.png]");
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
