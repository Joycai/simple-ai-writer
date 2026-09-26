/**
 * The `@` mention picker, shared by every composer that has one.
 *
 * Two pieces, because the hosts differ in the part that matters: the hook owns
 * @-detection and text splicing over a controlled value, and the component
 * renders the list. The lore modals wrap a MarkdownTextarea; the chat composer
 * has its own textarea with Enter-to-send and IME handling that must not be
 * wrapped. Sharing the *logic* rather than the whole control is what lets both
 * keep their input behaviour.
 *
 * The list is scoped (设计稿 02i): a chip row on top — 全部 / 条目 / 文档 /
 * 图片 — narrows the candidates to one kind, Tab cycles it, and every fresh
 * `@` starts at 全部. Matching and ranking live in `lib/search/mentionSearch`;
 * `useMentionSearch` runs it for a host and `mentionKeyDown` is the one copy
 * of the keyboard protocol, so the three composers differ only in what they
 * do with a pick. This component only draws. An empty scope still renders the
 * chip row plus one line saying where the hits are — a list that vanished on
 * zero matches left the author unable to see which scope they were in, let
 * alone leave it. No candidates at all is different: then there is nothing to
 * scope, and the picker stays off screen as it always did.
 *
 * Rendered through a portal so the list escapes the modal's overflow context —
 * inside it, the picker is clipped by the panel it is anchored to.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AudioLines, FileText, Film, Image as ImageIcon } from "lucide-react";
import { useImageDataUrl } from "../lore/useImageDataUrl";
import { imageToThumbnailDataUrl, isHtmlPath, type ProjectFile } from "../../lib/fs/images";
import { videoMimeOf } from "../../lib/fs/video";
import type { LoreEntity } from "../../lib/lore";
import { endsInsideToken, mentionToken } from "../../lib/agent/mentionText";
import {
  availableScopes,
  countByScope,
  cycleScope,
  hasHits,
  matchesMention,
  mentionSub,
  searchMentions,
  type MentionHit,
  type MentionScope,
  type ScopedKind,
} from "../../lib/search/mentionSearch";
import { Highlighted } from "./Highlighted";
// The pure vocabulary function, not stores/projectStore's useTerms hook: this
// module's helpers (findMention, mentionKeyDown, useMentionSearch) are imported by node-side
// tests, and a store import would drag appStore's module-scope theme work —
// which touches `document` — into that chain. Same words either way: useTerms
// is appTerms keyed on the app language, which i18n already knows.
import { appTerms } from "../../lib/profile/model";
import styles from "./MentionPicker.module.css";

export type MentionItem =
  | { type: "lore"; entity: LoreEntity }
  | { type: "file"; file: ProjectFile };

/** Stable identity, used for dedupe and React keys. */
export function mentionKey(item: MentionItem): string {
  return item.type === "lore" ? `lore:${item.entity.id}` : `file:${item.file.path}`;
}

function mentionLabel(item: MentionItem): string {
  return item.type === "lore" ? item.entity.name : item.file.name;
}

/**
 * Longest run after `@` still read as a query.
 *
 * A space is the natural terminator, and Chinese prose does not have one — so
 * without a cap, a single `@` typed mid-sentence left the mention "open" for
 * the rest of the message. Nothing was on screen (the picker then rendered
 * nothing with no matches) while the composer kept treating every keystroke as
 * part of a mention. Longer than any entity or chapter name worth recognising.
 */
const MAX_QUERY_LEN = 24;

/** What ends a mention besides ASCII whitespace: full-width space and CJK punctuation. */
const CJK_TERMINATORS = /[　、。，；：？！（）【】「」“”]/;

/**
 * Where an `@` mention begins, given the text and the caret.
 *
 * Returns null unless the caret sits in a live mention — one whose `@` is at a
 * word boundary and which has no terminator since. `foo@bar` is an email, not
 * a mention; `@第三` mid-word is one. A landed reference is not: `@[沈砚]的`
 * is what a pick leaves behind plus the prose typed straight after it (no
 * space in Chinese) — reading it as a query reopened a picker that could
 * match nothing, and now that an empty picker stays on screen it would sit
 * there eating ↑↓, Tab and the first Esc. So `@[` never opens, an `@` inside
 * an unclosed `@[…` (a name that itself holds one, `封面@2x.png`) never opens,
 * and a name that starts with `[` is reached by a word inside it — the same
 * as a name starting with `【`, which was always a terminator. Brackets are
 * counted the way the token's readers count them (mentionText
 * `endsInsideToken`). The unclosed `@[…` ends at a newline, at the next `@[`
 * (a name never holds one) or at a CJK terminator, not at a space (names
 * have spaces), so an author-typed `@[` costs the `@`s up to the next 「，」
 * or `@[` on that line — a deliberate price.
 */
export function findMention(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  // Preceded by an ASCII word character ⇒ part of something else (an address,
  // a handle). Deliberately ASCII: a Chinese sentence runs straight into the
  // `@` with no space, so treating CJK as a word character here would stop
  // the picker from ever opening in the language it matters most in.
  if (at > 0 && /[\w@]/.test(before[at - 1])) return null;
  // Inside a landed reference: `@[图标@2x.png]的` — the last `@` is the name's.
  // Brackets counted the way the token's readers count them (mentionText):
  // `@[手稿[旧]@2x.png]` is still open after its inner `@`.
  if (endsInsideToken(before.slice(0, at), (c) => CJK_TERMINATORS.test(c))) return null;
  const query = before.slice(at + 1);
  // A landed reference, or the caret after one whose name held an `@` past a
  // 「（」 or 「，」 (where the rule above stops): a query never holds `]`.
  if (query.startsWith("[") || query.includes("]")) return null;
  // The author moved on and is writing prose again.
  if (/\s/.test(query) || CJK_TERMINATORS.test(query)) return null;
  if (query.length > MAX_QUERY_LEN) return null;
  return { start: at, query };
}

export interface MentionState {
  open: boolean;
  query: string;
  /** Highlighted row — hosts drive it with ↑/↓ and confirm with Enter. */
  active: number;
  /** Which kind the list is narrowed to. 全部 on every fresh `@`. */
  scope: MentionScope;
  /** Call from the textarea's onChange, after the value is committed. */
  sync: (value: string, caret: number) => void;
  /**
   * For a change to the text that was not the author's typing (another
   * instance landing a reference into the same draft): move the open
   * mention and the waiting picks by the edit. See editRange.
   */
  external: (before: string, after: string) => void;
  /**
   * A pick's handle on the mention it came from — take it *before* any
   * await, with the text as it is then, and hand it to `accept` after. Null
   * when no mention is open.
   */
  claim: (text: string) => MentionClaim | null;
  /**
   * Replace the claimed mention with `@[名字]`, returning the new text and
   * selection (below) — at the place the mention is *now*, after whatever was
   * typed or landed during the read (see acceptPick). A second accept on the same mention
   * is a no-op (a double-click, or Enter twice on a slow file); a mention
   * opened since on a later `@` is shifted by the splice; one reopened on
   * the claimed `@` closes with it. `projectPath` is for judging whether
   * letters typed during the read still point at `item`.
   *
   * `sel` is the input's selection as the host reads it now (`selectionOf`);
   * the returned one is that selection carried through the splice, both
   * ends (`landSelection`) — null when nothing landed or none was given. The
   * host puts it back after the render (`useKeptSelection`): replacing a
   * controlled value moves the caret to the end.
   */
  accept: (
    value: string,
    item: MentionItem,
    claim: MentionClaim,
    projectPath: string | null,
    sel: TextSelection | null,
  ) => { text: string; sel: TextSelection | null };
  /** Move the highlight within a list of `count` items, wrapping at both ends. */
  move: (delta: number, count: number) => void;
  /** Pick a scope chip; the highlight goes back to the top of the new list. */
  setScope: (scope: MentionScope) => void;
  /**
   * Tab / Shift+Tab: the next chip among those on offer. With `counts` (an
   * empty list), the step skips chips that hold nothing for this query.
   */
  cycleScope: (scopes: readonly MentionScope[], dir: 1 | -1, counts?: Record<ScopedKind, number>) => void;
  close: () => void;
}

/** The mention's state, one object: `sync` transitions from the committed value, never from a stale closure. */
export interface MentionCore {
  open: boolean;
  /** Serial of the mention: each fresh `@` gets the next one, and a close keeps the last. */
  id: number;
  query: string;
  active: number;
  scope: MentionScope;
  /** Index of the `@` in the host's text; meaningful while open. */
  start: number;
}

/** What a pick holds on to across its file read: which mention, where it was, and what stood after it. */
interface MentionClaim {
  id: number;
  start: number;
  query: string;
  /**
   * A `[` already followed the mention when the claim was taken — the `@` was
   * put in front of prose like `[草稿]第一章` (`+ 引用`, or typed there). Then
   * `@[` at the place of landing is that prose, not a reference landed
   * since, and `spliceMention`'s guard must let the pick through.
   */
  glued: boolean;
}

const CLOSED: MentionCore = { open: false, id: 0, query: "", active: 0, scope: "all", start: 0 };
const shut = (s: MentionCore): MentionCore => ({ ...CLOSED, id: s.id });

/**
 * One keystroke's transition, pure: what the mention becomes when the host's
 * text is `value` with the caret at `caret`.
 *
 * - No live mention → closed, and closed keeps nothing: the next `@` is a
 *   fresh one.
 * - A fresh `@` — one that opens the mention, or one at a different `@`
 *   than the open one (`@潮@`, or a click to another `@` in the text) —
 *   searches everything, from the top. The scope is not remembered across
 *   mentions: one message can open the picker a dozen times, and a narrow
 *   scope left over from the last one is a silent trap — the author types
 *   `@` for a picture and concludes the picture is gone. Nor is the
 *   highlight: a closed-and-reopened mention shows 全部's list, and the row
 *   index the author had reached in 条目 names another item there.
 * - Continuing one (same `@`) keeps the scope. A changed query is a different
 *   list, so the old highlight index means nothing — back to the top rather
 *   than pointing at whatever happens to occupy that slot now.
 */
export function syncMention(prev: MentionCore, value: string, caret: number): MentionCore {
  const hit = findMention(value, caret);
  if (!hit) return prev.open ? shut(prev) : prev;
  if (!prev.open || prev.start !== hit.start) {
    return { open: true, id: prev.id + 1, query: hit.query, active: 0, scope: "all", start: hit.start };
  }
  return { ...prev, query: hit.query, active: hit.query === prev.query ? prev.active : 0 };
}

/**
 * Replace the mention at `start` (its `@` plus `query`) with `@[label]`.
 * Pure, and defensive: a file pick reads the file *before* it splices, and
 * during that read the text may have changed under it. If the text at
 * `start` is no longer `@query`, the mention as claimed is gone and nothing
 * is spliced; the attachment the host already made stands on its own.
 *
 * Only that — whatever follows `@query` is left alone. `findMention` reads
 * up to the caret, so a mention typed into the middle of a sentence
 * (`我想让@沈更生动`, or `+ 引用` with the caret mid-line) is followed by prose
 * that was always there; a rule that refused a following character once
 * left every such mention as a bare `@沈` with the chip attached.
 *
 * One thing that can stand at `start` and still pass an empty query's check
 * is a reference already landed there — `@[夜航.png]` begins with `@`, and
 * landing again would give `@[A][B]`. The `spent` set cannot see it across
 * instances: the chat composer remounts per conversation, and an instance
 * unmounted mid-read lands into the draft the new one has been writing. But
 * `@[` is also what an `@` put in front of `[草稿]第一章` looks like —
 * `findMention` reads only up to the caret, so that empty-query mention is
 * live. The two are told apart by `glued`, recorded when the claim was
 * taken: a `[` that was already there is prose; one that was not is a
 * reference landed since.
 *
 * The token itself is `mentionToken`'s, the definition its readers share — a
 * name holding brackets lands in the shape they can read back.
 */
export function spliceMention(value: string, start: number, query: string, label: string, glued = false): string {
  const end = start + 1 + query.length;
  if (value.slice(start, end) !== `@${query}`) return value;
  if (!glued && value.charAt(start + 1) === "[") return value;
  return `${value.slice(0, start)}${mentionToken(label)}${value.slice(end)}`;
}

/**
 * Where `before` was edited to give `after`, as one replaced span: the
 * longest common prefix and suffix (never overlapping) bound it. This is
 * how a change that was not the author's typing — another instance of the
 * chat composer landing a reference into the same draft — is read: the
 * text after the span moved by `delta`, the text before it did not, and
 * whatever the span covered is gone. A single landed reference is one span:
 * what was replaced is exact, but *where* a pure insertion was made is
 * ambiguous wherever the inserted text repeats its neighbours (see `lo`);
 * reading the *caret* instead was tried and went wrong three ways (a closed mention was never moved, a mid-sentence one
 * was reopened with the wrong query, a repeated query was moved to the
 * wrong `@`).
 */
export function editRange(before: string, after: string): { start: number; end: number; delta: number; lo: number } {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  const end = before.length - s;
  const delta = after.length - before.length;
  // A pure insertion whose text repeats what stood before it can be read as
  // made anywhere along that repeat (`@[草稿]` + `[潮汐.png]` at the `[`: the
  // greedy prefix keeps the old `[` and puts the span one further right).
  // `lo` is the leftmost place it could have been made — what a mention
  // ending there must be compared against.
  let lo = p;
  if (end === p && delta > 0) {
    while (lo > 0 && after.charCodeAt(lo - 1) === after.charCodeAt(lo - 1 + delta)) lo--;
  }
  return { start: p, end, delta, lo };
}

/**
 * Whether a mention at `start` with `query` was run over by the replaced
 * span — overlapping it, or ending where it begins (at its leftmost reading,
 * `lo`): a reference landed on this very `@` keeps the `@` in the common
 * prefix, so the span begins after it, and an empty-query mention ends
 * there. Left open, that mention would then be claimed with `glued` set
 * (the `[` is in the text by now) and land a second reference in front of
 * the first.
 */
function inEdit(start: number, query: string, edit: { end: number; lo: number }): boolean {
  return start < edit.end && start + 1 + query.length >= edit.lo;
}

/**
 * The open mention after an edit that was not typing (see editRange): moved
 * by the edit when it lies after it — keeping id, scope and highlight, it
 * is the same mention — closed when the edit ran over it (a reference was
 * landed on that very `@`), untouched when it lies before it.
 */
export function shiftCore(core: MentionCore, before: string, after: string): MentionCore {
  if (!core.open) return core;
  const edit = editRange(before, after);
  if (core.start >= edit.end) return edit.delta === 0 ? core : { ...core, start: core.start + edit.delta };
  if (inEdit(core.start, core.query, edit)) return shut(core);
  return core;
}

/**
 * The waiting picks after the same edit: moved when they lie after it. One
 * the edit ran over is left where it is — at landing, the text there no
 * longer reads as its mention, and nothing is spliced — and loses `glued`:
 * whatever `[` now follows its `@` is the reference just landed there, not
 * the prose it was glued to (the same reset `acceptPick` makes for a
 * landing by this instance).
 */
export function shiftClaims(pending: Map<number, MentionClaim>, before: string, after: string): void {
  const edit = editRange(before, after);
  if (edit.delta === 0 && edit.start === edit.end) return;
  for (const [id, c] of pending) {
    if (c.start >= edit.end) { if (edit.delta !== 0) pending.set(id, { ...c, start: c.start + edit.delta }); }
    else if (c.glued && inEdit(c.start, c.query, edit)) pending.set(id, { ...c, glued: false });
  }
}

/**
 * What landing `claim`'s text does to the open state, pure:
 * - the claimed mention closes;
 * - a mention reopened on the same `@` (Esc during the read, then more
 *   letters) closes too — that `@` now belongs to the landed reference;
 * - a mention opened *after* it in the text (the author moved on to `@夜`
 *   while the file read) is theirs to keep, shifted by `delta`, the length
 *   the splice added — hosts land text programmatically, so no `sync` will
 *   re-read its position, and a stale `start` would make its own pick land
 *   nothing.
 */
export function afterAccept(core: MentionCore, landed: Pick<MentionClaim, "id" | "start">, delta: number): MentionCore {
  if (!core.open) return core;
  if (core.id === landed.id || core.start === landed.start) return shut(core);
  if (core.start > landed.start) return { ...core, start: core.start + delta };
  return core;
}

/**
 * The claims still waiting on a file read, by mention id, each kept at that
 * mention's *current* place. Called on every render: while the claimed
 * mention is open, its entry follows the author's typing (`@潮` → `@潮汐`),
 * and it keeps its last place once the mention closes (a 「，」 typed, Esc, a
 * click outside — `CLOSED`'s 0 / "" would splice at the head of the draft,
 * which once ate its first character). Keyed by id, so a claim is found
 * again however many mentions were opened after it — and a mention reopened
 * on the same `@` (Esc during the read, then more letters, which gives that
 * `@` a new id) is followed too: it is the claimed `@`, as `afterAccept`
 * already treats it. One table is one draft: every host mounts one
 * `useMentionState` per draft (the chat composer remounts per
 * conversation), so nothing here needs to tell drafts apart.
 */
export function trackClaims(pending: Map<number, MentionClaim>, core: MentionCore): void {
  if (!core.open) return;
  for (const [id, c] of pending) {
    if (id === core.id || c.start === core.start) pending.set(id, { ...c, start: core.start, query: core.query });
  }
}

/**
 * A pick's claim on the open mention, registered in `pending` so
 * `trackClaims` follows it from here on. Null when no mention is open. The
 * one place a claim is made, for the hook and the tests alike. `text` is
 * the draft as it is now, for `glued` (see MentionClaim).
 */
export function claimOf(pending: Map<number, MentionClaim>, core: MentionCore, text: string): MentionClaim | null {
  if (!core.open) return null;
  const glued = text.charAt(core.start + 1 + core.query.length) === "[";
  const c: MentionClaim = { id: core.id, start: core.start, query: core.query, glued };
  pending.set(c.id, c);
  return c;
}

/** Where a pick landed, for `afterAccept` — and which mention it was. */
interface Landed {
  id: number;
  start: number;
  /** Where the replaced `@query` ended, before the splice. */
  end: number;
  /** The length the splice added; later claims and mentions move by it. */
  delta: number;
}

/**
 * `caret` carried through a landing. Before the `@`: where it was. Inside
 * the replaced `@query` — the usual case, the author was typing it — just
 * after the new `]`. After it (letters typed further on while the file
 * read): moved with the text by `delta`, so the author keeps writing where
 * they were rather than being pulled back to the reference.
 */
export function caretThrough(caret: number, landed: Landed): number {
  if (caret <= landed.start) return caret;
  if (caret <= landed.end) return landed.end + landed.delta;
  return caret + landed.delta;
}

/**
 * A textarea's selection, whole: a landing that kept only `selectionStart`
 * turned a selected phrase into a caret. A collapsed one is the caret.
 */
export interface TextSelection {
  start: number;
  end: number;
  dir: "forward" | "backward" | "none";
}

/** The input's selection now; null without an input. */
export function selectionOf(el: HTMLTextAreaElement | null): TextSelection | null {
  if (!el) return null;
  return { start: el.selectionStart, end: el.selectionEnd, dir: el.selectionDirection ?? "none" };
}

/**
 * A selection carried through a landing: each end by `caretThrough`, the
 * direction as it was. The mapping never reorders two positions, so the
 * ends stay in order — one before the `@` and one inside `@query` becomes a
 * selection that covers the new reference.
 */
export function landSelection(sel: TextSelection, landed: Landed): TextSelection {
  return { start: caretThrough(sel.start, landed), end: caretThrough(sel.end, landed), dir: sel.dir };
}

/**
 * A selection carried through an edit this instance did not make and knows
 * nothing about but the texts on both sides — another instance landing a
 * reference into the same draft, a send clearing it. Read as one replaced
 * span (`editRange`), each end:
 * - strictly before the span: where it was;
 * - from its first character to its last, or at a pure insertion's place
 *   (typing inserts in front of the caret, and so does this): just after the
 *   new text. A caret at the span's very start counts as inside: the common
 *   prefix swallows the `@` a reference lands on, so `@|潮` → `@[潮汐.png]`
 *   puts the span's start right at that caret, and leaving it there would
 *   split the token at the next key — `caretThrough` sends it after the `]`
 *   too;
 * - after it: moved with the text by `delta`.
 * Empty → text, and a replacement with nothing in common at the head, put
 * the caret at the end. Where a pure insertion repeats its neighbours the
 * span is read at its rightmost place (`editRange`'s greedy prefix), so a
 * caret in that repeat stays put — off by the repeat's length at worst, and
 * only the caret. A rewind is not an edit to map: its hosts place the caret
 * at the end themselves.
 */
export function selectionThrough(sel: TextSelection, before: string, after: string): TextSelection {
  const e = editRange(before, after);
  const at = (pos: number) => (pos < e.start ? pos : pos <= e.end ? e.end + e.delta : pos + e.delta);
  return { start: at(sel.start), end: at(sel.end), dir: sel.dir };
}

/**
 * Land a pick's text, pure. In order:
 * - `spent` holds the mentions a pick has already landed on: a second Enter
 *   on a slow file, or a double-click, is one splice — text unchanged.
 * - The mention is spliced where it is *now* (`pending`, see trackClaims),
 *   not where the claim was taken: a landing before this one moved it.
 * - If the author kept narrowing that same mention while the file read
 *   (`@潮` → `@潮汐`, `@插图/潮` → `@插图/潮汐`) and the grown query still
 *   finds the picked item by the picker's own rule (`stillMatches`), the
 *   whole current query is replaced — otherwise the extra letters would be
 *   left as a tail after `@[潮汐.png]`. Failing that, the snapshot's query;
 *   prose typed after it that does not match (`@潮的图`) is prose, and stays.
 * - Nothing landed (the text at that place is no longer the mention) means
 *   nothing is recorded and nothing closes: the `@` the author is looking at
 *   is still theirs. Only a landing is spent, and only a landing shifts the
 *   claims after it — by `delta`, as `afterAccept` shifts the open mention.
 *   A retry at the snapshot's place was tried once and dropped: it could
 *   land on a different, never-picked `@潮` that happened to sit `delta`
 *   characters back.
 */
export function acceptPick(
  spent: Set<number>,
  pending: Map<number, MentionClaim>,
  claim: MentionClaim,
  value: string,
  label: string,
  stillMatches: (query: string) => boolean,
): { text: string; landed: Landed | null } {
  if (spent.has(claim.id)) return { text: value, landed: null };
  const cur = pending.get(claim.id) ?? claim;
  pending.delete(claim.id);
  const grown = cur.query !== claim.query && stillMatches(cur.query);
  const at = cur.start;
  let used = cur.query;
  let text = grown ? spliceMention(value, at, cur.query, label, cur.glued) : value;
  if (text === value) {
    used = claim.query;
    text = spliceMention(value, at, claim.query, label, cur.glued);
  }
  if (text === value) return { text, landed: null };
  spent.add(claim.id);
  const delta = text.length - value.length;
  for (const [id, c] of pending) {
    if (c.start > at) pending.set(id, { ...c, start: c.start + delta });
    // Another pick still waiting on this very `@` (Esc, reopen, pick again):
    // the `[` after it is now the reference just landed, not the prose the
    // claim was glued to — the guard applies to it from here on.
    else if (c.start === at && c.glued) pending.set(id, { ...c, glued: false });
  }
  return { text, landed: { id: claim.id, start: at, end: at + 1 + used.length, delta } };
}

/**
 * Keep the author's selection through a replacement of the input's value
 * that was not their typing. Replacing a controlled value puts the caret at
 * the end, and a pick lands after a file read, outside any event handler —
 * or in another instance altogether: the chat composer remounts per
 * conversation, the roleplay one per character, and a pick made before a
 * switch lands into the draft the new instance is showing.
 *
 * Two sources, the exact one first:
 * - `place(sel, text)`: this instance's own landing, which knows the span it
 *   replaced (`landSelection`).
 * - Otherwise, what the input showed before the commit. The render reads
 *   the DOM when it still shows something other than `value` — the text
 *   and the selection the author had before this replacement — and the
 *   layout effect carries that through the edit (`selectionThrough`). A
 *   read during render, because after the commit the browser has already
 *   moved the caret to the end and a layout effect is too late. It only
 *   reads, and a discarded render's reading is overwritten by the next
 *   render's (cleared when the input already shows `value`: typing — the
 *   DOM is ahead of the state — must never be carried through anything).
 *
 * A layout effect rather than the `requestAnimationFrame` that `+ 引用`
 * uses: that one runs inside a click, where React commits before the frame;
 * after an await nothing orders the two (and `+ 引用`'s frame, coming
 * later, still has the last word for its own insertion). It is applied only
 * to a focused input — one the author left is not theirs to have moved —
 * and only if it shows exactly `value`; `place`'s record is used only for
 * exactly the text it was computed for, and both records are cleared on
 * every run, so a placement never waits for some later edit.
 */
export function useKeptSelection(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): (sel: TextSelection | null, text: string) => void {
  const want = useRef<{ sel: TextSelection; text: string } | null>(null);
  const shown = useRef<{ sel: TextSelection; text: string } | null>(null);
  const live = ref.current;
  shown.current = live && live.value !== value ? { sel: selectionOf(live)!, text: live.value } : null;
  useLayoutEffect(() => {
    const w = want.current;
    const s = shown.current;
    want.current = null;
    shown.current = null;
    const el = ref.current;
    if (!el || el !== document.activeElement || el.value !== value) return;
    const sel = w && w.text === value ? w.sel : s && selectionThrough(s.sel, s.text, value);
    if (sel) el.setSelectionRange(sel.start, sel.end, sel.dir);
  }, [ref, value]);
  return useCallback((sel: TextSelection | null, text: string) => {
    want.current = sel === null ? null : { sel, text };
  }, []);
}

/**
 * Drafts with a pick's file still being read, by slot (one per draft: the
 * chat key, the roleplay character, a lore modal's own id). Such a draft must
 * not be sent: the message would leave as `@潮` without the attachment, and
 * the read, finishing, would put the attachment into the emptied composer to
 * ride along with the next one. Module state, as chatStash's `pasting`, for
 * the same reason: the instance that started the read may be gone — the chat
 * composer remounts per conversation — and the one on screen now must still
 * see the draft is not ready.
 */
const reads = new Map<string, number>();
const readListeners = new Set<() => void>();

function markMentionRead(slot: string, on: boolean): void {
  const n = (reads.get(slot) ?? 0) + (on ? 1 : -1);
  if (n > 0) reads.set(slot, n);
  else reads.delete(slot);
  for (const l of readListeners) l();
}

export function isMentionReading(slot: string): boolean {
  return reads.has(slot);
}

function subscribeReads(listener: () => void): () => void {
  readListeners.add(listener);
  return () => { readListeners.delete(listener); };
}

/**
 * Count `pick` against `slot` until it settles, resolved or rejected; its
 * outcome passes through. `pick` is the whole pick — the read *and* the
 * landing — not the read alone (see useMentionReads).
 */
export async function trackMentionRead<T>(slot: string, pick: () => Promise<T>): Promise<T> {
  markMentionRead(slot, true);
  try {
    return await pick();
  } finally {
    markMentionRead(slot, false);
  }
}

/** A pick's read that failed — the refusal to show, in the author's words. */
interface MentionReadFailure {
  readonly message: string;
}

/**
 * The last failed read of each draft, until an instance showing that draft
 * takes it. Beside the count, for the same reason: the instance that started
 * the read may be gone, and the one on screen now — or the next one mounted
 * on this draft — must still drop a send queued around the attachment and
 * say why no chip came. Kept until taken: a failure while no instance shows
 * the draft is shown once when one does, next to the `@潮` still in it.
 */
const failures = new Map<string, MentionReadFailure>();

export function failMentionRead(slot: string, message: string): void {
  failures.set(slot, { message });
  for (const l of readListeners) l();
}

export function mentionReadFailure(slot: string): MentionReadFailure | null {
  return failures.get(slot) ?? null;
}

/** Take `failure` off `slot` — only if it is still the one there, so taking an older one never drops a newer. */
export function takeMentionReadFailure(slot: string, failure: MentionReadFailure): void {
  if (failures.get(slot) !== failure) return;
  failures.delete(slot);
  for (const l of readListeners) l();
}

/**
 * `reading`: a file picked into this draft is still being read — hosts gray
 * out sending, as they do for a paste still becoming chips. `track(pick)`
 * counts a pick until it settles, either way, and `pick` must include the
 * landing (the attachment and the `@[名字]` written into the draft), not
 * only the read. Dropping the count notifies React, which re-renders in a
 * microtask of its own — ahead of whatever follows an `await` of the read —
 * and that render, draft still unlanded, runs effects: the chat composer's
 * queued send would go out with it. Counted to the end of the landing, the
 * render that lets sending through already has both.
 *
 * `failure`: a read of this draft failed, here or in an instance since
 * unmounted; the host shows it, drops anything queued, and `take`s it.
 * `fail(message)` records one — inside `pick`, for the reason above: the
 * render that sees the count drop must already see the failure.
 */
export function useMentionReads(slot: string): {
  reading: boolean;
  failure: MentionReadFailure | null;
  track: <T>(pick: () => Promise<T>) => Promise<T>;
  fail: (message: string) => void;
  take: (failure: MentionReadFailure) => void;
} {
  const reading = useSyncExternalStore(subscribeReads, () => isMentionReading(slot));
  const failure = useSyncExternalStore(subscribeReads, () => mentionReadFailure(slot));
  const track = useCallback(<T,>(pick: () => Promise<T>) => trackMentionRead(slot, pick), [slot]);
  const fail = useCallback((message: string) => failMentionRead(slot, message), [slot]);
  const take = useCallback((f: MentionReadFailure) => takeMentionReadFailure(slot, f), [slot]);
  return { reading, failure, track, fail, take };
}

/**
 * @-detection and splicing over a controlled text value — one per draft.
 * A host that shows several drafts remounts (the chat composer, per
 * conversation), so a mention, a claim and the table below never span two.
 * The instance an async pick belongs to may be unmounted by the time the
 * file is read; its `accept` still lands the text the host hands it, and the
 * host reads that text from its store, not from a ref of the dead instance.
 */
export function useMentionState(): MentionState {
  const [state, setState] = useState<MentionCore>(CLOSED);
  // Picks waiting on a file read, at their mention's current place (see
  // trackClaims — the render that made a handler may hold an older one).
  // Every render, so typing during the read is seen: the «narrowed further»
  // sequence tests in chatMentions.test.ts are what depend on this line.
  const pending = useRef(new Map<number, MentionClaim>());
  trackClaims(pending.current, state);
  // Mentions a pick has already landed on (see acceptPick).
  const spent = useRef(new Set<number>());
  // Stable: the picker's outside-click listener depends on it, and a chat
  // host re-renders on every streamed flush.
  const close = useCallback(() => setState((s) => (s.open ? shut(s) : s)), []);

  return {
    open: state.open,
    query: state.query,
    active: state.active,
    scope: state.scope,
    sync: (value, caret) => setState((s) => syncMention(s, value, caret)),
    external: (before, after) => {
      // The table first and outside the updater: React may run an updater
      // twice under StrictMode, and a shift must be applied once.
      shiftClaims(pending.current, before, after);
      setState((s) => shiftCore(s, before, after));
    },
    claim: (text) => claimOf(pending.current, state, text),
    accept: (value, item, claim, projectPath, sel) => {
      const { text, landed } = acceptPick(
        spent.current, pending.current, claim, value, mentionLabel(item),
        (q) => matchesMention(item, q, projectPath),
      );
      if (!landed) return { text, sel: null };
      setState((s) => afterAccept(s, landed, landed.delta));
      return { text, sel: sel && landSelection(sel, landed) };
    },
    move: (delta, count) => {
      if (count <= 0) return;
      setState((s) => ({ ...s, active: (((s.active + delta) % count) + count) % count }));
    },
    setScope: (scope) => setState((s) => ({ ...s, scope, active: 0 })),
    cycleScope: (scopes, dir, counts) =>
      setState((s) => ({ ...s, scope: cycleScope(scopes, s.scope, dir, counts), active: 0 })),
    close,
  };
}

/**
 * Tells this instance's writes to its draft from anyone else's, and moves the
 * open mention and the picks waiting on a file read by the others' (see
 * `MentionState.external`). The draft lives in a store and a host remounts
 * per draft owner (a conversation, a roleplay character), so an instance
 * unmounted by a switch can still land a `@` reference into this draft once
 * its file read finishes; the picker would otherwise sit open over the landed
 * reference, and a pick claimed on a `@` after it would miss its mention.
 *
 * Returns `own(write)`: every write this instance makes to the draft goes
 * through it. Before the write, a store value that is not the one we last
 * wrote is someone else's edit not rendered yet — two reads finishing in the
 * same tick — and is moved by first, or our own landing would splice with an
 * unshifted claim and then record the other's edit as ours. After it, the
 * value is recorded; otherwise the render's effect finds the difference. A
 * value, not a flag: a write that leaves the draft as it was (a pick that
 * landed nothing, a clear of an empty draft) never renders, and a flag set for
 * it would swallow the next write that was not ours. The instance that lands
 * after a switch is the unmounted one, and it catches up the same way: the
 * author's edits in the new instance move its waiting claim too.
 *
 * Our own writes move the *open* mention themselves: they carry their own
 * `sync` (typing, `+ 引用`) or land text the picker's outside click has
 * already closed on (a snippet insert, 回到这里重说). A claim still waiting
 * on a read whose mention was closed is not moved by an own rewrite ahead of
 * it (`+ 引用`, roleplay's line kinds) — see the brief's 未做、可做.
 */
export function useOwnDraft(draft: string, read: () => string, mention: MentionState): (write: () => void) => void {
  const own = useRef(draft);
  // Through refs, so `own` is stable and a host's `setDraft` built on it is too.
  const readNow = useRef(read);
  readNow.current = read;
  const external = useRef(mention.external);
  external.current = mention.external;
  const catchUp = useCallback((now: string) => {
    const before = own.current;
    if (now === before) return;
    own.current = now;
    external.current(before, now);
  }, []);
  useEffect(() => { catchUp(draft); }, [draft, catchUp]);
  return useCallback((write: () => void) => {
    catchUp(readNow.current());
    write();
    own.current = readNow.current();
  }, [catchUp]);
}

// ── Thumbnails ───────────────────────────────────────────────────────────────

function FileThumb({ file }: { file: ProjectFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (file.kind !== "image") return;
    // Cancellation flag, same as useImageDataUrl: the picker unmounts the
    // moment an item is chosen, and a large image can still be decoding.
    let cancelled = false;
    // Thumbnail tier — this renders at pickerThumb size; a full photo inlined
    // as base64 is megabytes of string for a 24px square (lib/fs/images).
    imageToThumbnailDataUrl(file.path, 96)
      .then((dataUrl) => { if (!cancelled) setUrl(dataUrl); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [file.path, file.kind]);

  if (file.kind !== "image" || !url) {
    return (
      <div className={styles.pickerThumbPlaceholder}>
        {file.kind === "image"
          ? <ImageIcon size={12} />
          : file.kind === "media"
            ? videoMimeOf(file.path) ? <Film size={12} /> : <AudioLines size={12} />
            : <FileText size={12} />}
      </div>
    );
  }
  return <img src={url} className={styles.pickerThumb} alt="" />;
}

function EntityThumb({ avatarPath }: { avatarPath: string | null }) {
  const url = useImageDataUrl(avatarPath);
  if (!url) return <div className={styles.pickerThumbPlaceholder}><FileText size={12} /></div>;
  return <img src={url} className={styles.pickerThumb} alt="" />;
}

// ── Search and keys, shared by the hosts ─────────────────────────────────────

/** What `useMentionSearch` hands a host: the picker's whole input for one keystroke. */
export interface MentionSearch {
  /**
   * The picker is on screen: a mention is open *and* the host has something
   * to offer. With no candidates at all there is nothing to scope — the
   * picker stays off and the keys fall through, as before it learned to
   * stay open on an empty scope.
   */
  open: boolean;
  /** Chips on offer — `availableScopes(candidates)`; empty while off screen. */
  scopes: readonly MentionScope[];
  /** Already scoped, ranked and cut. */
  items: MentionItem[];
  /** Where each shown row matched, by index; empty for an empty query. */
  hits: ReadonlyMap<number, MentionHit>;
  /**
   * Hits per kind for this query, ignoring the scope — what the *other* chips
   * would show. Only an empty list reads it — the empty line, the Enter
   * rule, and Tab skipping empty chips — so it is computed only then.
   */
  counts: Record<ScopedKind, number> | undefined;
}

const NO_ITEMS: MentionItem[] = [];
const NO_HITS: ReadonlyMap<number, MentionHit> = new Map();

/**
 * Run the search for a host's candidates. One place, so the three composers
 * cannot drift on *what* the list holds; nothing is computed while the picker
 * is off screen — the candidates change on every lore write and file-tree
 * refresh, and re-scoring them for a list nobody sees is pure waste.
 */
export function useMentionSearch(
  candidates: readonly MentionItem[],
  mention: MentionState,
  projectPath: string | null,
): MentionSearch {
  const open = mention.open && candidates.length > 0;
  const { query, scope } = mention;
  const scopes = useMemo(() => (open ? availableScopes(candidates) : []), [open, candidates]);
  const result = useMemo(
    () => (open ? searchMentions(candidates, query, scope, projectPath) : null),
    [open, candidates, query, scope, projectPath],
  );
  const items = result?.items ?? NO_ITEMS;
  const counts = useMemo(
    () => (open && items.length === 0 ? countByScope(candidates, query, projectPath) : undefined),
    [open, candidates, query, projectPath, items.length],
  );
  return { open, scopes, items, hits: result?.hits ?? NO_HITS, counts };
}

/** The fields of a keyboard event this reads — a React event, or a test's literal. */
interface KeyEventLike {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
}

/**
 * The picker's share of a host's keydown — the one copy of the protocol.
 * Returns true when the key was the picker's and the host should stop; false
 * when it falls through to the host's own handling, Enter-to-send included.
 *
 * - Off screen → nothing claimed.
 * - Esc closes, mid-composition or not: it always did, and a chat host would
 *   otherwise read the same Esc as 「stop the run」.
 * - While an IME owns the keys (`composing` — pass `useImeGuard().isComposing(e)`,
 *   not a bare composition flag; lib/ime says why), the rest is left alone: a
 *   pinyin Enter commits letters, not a row.
 * - Tab / Shift+Tab cycle the scope, as ⌘K does — and from an empty list they
 *   skip chips that are empty too, so the line's «Tab 切过去» is one press;
 *   ↑ / ↓ move; Enter alone picks (设计稿 02i 1z §1).
 * - Enter on an empty list is swallowed only while another scope has the hit —
 *   sending now would send a half-formed mention. With nothing anywhere the
 *   `@` is probably just an `@`, and Enter goes through to the host.
 */
export function mentionKeyDown(
  e: KeyEventLike,
  mention: Pick<MentionState, "active" | "close" | "move" | "cycleScope">,
  search: MentionSearch,
  composing: boolean,
  onPick: (item: MentionItem) => void,
): boolean {
  if (!search.open) return false;
  if (e.key === "Escape") { e.preventDefault(); mention.close(); return true; }
  if (composing) return false;
  const { items, scopes, counts } = search;
  if (e.key === "Tab") {
    e.preventDefault();
    mention.cycleScope(scopes, e.shiftKey ? -1 : 1, items.length === 0 ? counts : undefined);
    return true;
  }
  if (e.key === "ArrowDown") { e.preventDefault(); mention.move(1, items.length); return true; }
  if (e.key === "ArrowUp") { e.preventDefault(); mention.move(-1, items.length); return true; }
  if (e.key === "Enter" && !e.shiftKey) {
    if (items.length > 0) { e.preventDefault(); onPick(items[mention.active] ?? items[0]); return true; }
    if (counts && hasHits(counts)) { e.preventDefault(); return true; }
  }
  return false;
}

// ── The list ─────────────────────────────────────────────────────────────────

interface MentionPickerProps {
  /** Element the list anchors to — the textarea itself (chat, roleplay) or its wrapper (the lore modals). */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** The host's `useMentionState()`: query, scope, the highlighted row, and the chip / dismiss actions. */
  mention: MentionState;
  /** The host's `useMentionSearch(...)`: what the list holds. Render only while `search.open`. */
  search: MentionSearch;
  /** The project root, for a document's group-path line. */
  projectPath: string | null;
  /** Keys already attached; shown dimmed and inert. */
  usedKeys: Set<string>;
  /**
   * Anchor the list above the input instead of below. The chat composer sits at
   * the panel's bottom edge, so above is where the room is — and where the 2b
   * design puts it. The lore modals keep the below-first default: their
   * textareas are mid-modal and a list opening upwards would cover the field
   * being typed in.
   */
  preferAbove?: boolean;
  /**
   * A word about *this composer's* relationship with the row — today
   * 「已常驻」 in the roleplay composer, where an entry the character already
   * carries is still pickable but will not be inlined a second time.
   *
   * A callback rather than a set of keys, so the shared picker learns no
   * vocabulary from any one host: the roleplay drawer, the lore modals and the
   * chat composer all render the same list and mean different things by it.
   */
  noteFor?: (item: MentionItem) => string | null;
  onPick: (item: MentionItem) => void;
}

/**
 * The scopes' names. The chips keep the app's own words — 条目 / 文档 from
 * `appTerms`, the same words the row badges use; only 全部 and 图片 are the
 * picker's. Two spellings because English has them and Chinese does not: a
 * chip is a title («Entries»), the empty line's sentence wants the plain
 * plural («3 in entries»).
 */
function useScopeLabels() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const terms = appTerms(isZh);
  const word = (s: MentionScope): string =>
    s === "all" ? t("ai.mention.scopeAll", { defaultValue: "全部" })
      : s === "lore" ? terms.entries
        : s === "text" ? terms.docs
          : t("ai.mention.scopeImage", { defaultValue: "图片" });
  const chip = (s: MentionScope): string => {
    const w = word(s);
    return isZh ? w : w.charAt(0).toUpperCase() + w.slice(1);
  };
  const plain = (s: MentionScope): string => (isZh ? word(s) : word(s).toLowerCase());
  return { t, terms, chip, plain };
}

/**
 * The empty scope's one line: what is missing here, what the other chips
 * hold, and the key that gets there. Three cases — nothing anywhere, nothing
 * here for this query, nothing here at all (a scope emptied by a model
 * change) — each a plain fact, never an instruction to click. Its own
 * component so the tests can render it without the portal around it.
 */
export function EmptyLine({ scope, query, scopes, counts }: {
  scope: MentionScope;
  query: string;
  scopes: readonly MentionScope[];
  counts: Record<ScopedKind, number> | undefined;
}) {
  const { t, plain } = useScopeLabels();
  const here = plain(scope);
  const q = query.trim();
  const others = (["lore", "text", "image"] as const)
    .filter((k) => k !== scope && scopes.includes(k) && (counts?.[k] ?? 0) > 0);
  if (others.length === 0) {
    return q
      ? t("ai.mention.emptyAll", { q, defaultValue: "没有匹配「{{q}}」" })
      : t("ai.mention.emptyScope", { scope: here, defaultValue: "{{scope}}里还没有内容" });
  }
  // Past this point the scope is a narrow one: 全部 with an empty list means
  // nothing matched anywhere, which the branch above has already answered.
  const head = q
    ? t("ai.mention.emptyIn", { scope: here, q, defaultValue: "{{scope}}里没有「{{q}}」" })
    : t("ai.mention.emptyScope", { scope: here, defaultValue: "{{scope}}里还没有内容" });
  // The count is the one thing on this line worth the eye: interpolate a
  // sentinel for {{n}} and put the number back in a <b>. A translation that
  // lost its {{n}} still reads: the whole sentence lands in `before` and the
  // number follows it.
  const SENT = "\u0000";
  const parts = others.map((k) => {
    const n = counts?.[k] ?? 0;
    const text = t(
      k === "lore" ? "ai.mention.countLore" : k === "text" ? "ai.mention.countText" : "ai.mention.countImage",
      { scope: plain(k), n: SENT, defaultValue: k === "lore" ? "{{scope}}里有 {{n}} 条" : k === "text" ? "{{scope}}里有 {{n}} 篇" : "{{scope}}里有 {{n}} 张" },
    );
    const [before, after] = text.split(SENT);
    return <span key={k}>{" · "}{before}<b>{n}</b>{after ?? ""}</span>;
  });
  return (
    <>
      {head}
      {parts}
      {" · "}<i>Tab</i> {t("ai.mention.switchOver", { defaultValue: "切过去" })}
    </>
  );
}

export function MentionPicker({
  anchorRef, mention, search, projectPath, usedKeys, preferAbove = false, noteFor, onPick,
}: MentionPickerProps) {
  const { items, hits, scopes, counts } = search;
  const { scope, query, active: activeIndex, setScope, close: onDismiss } = mention;
  const { t, terms, chip } = useScopeLabels();
  const [style, setStyle] = useState<React.CSSProperties>({});
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the keyboard highlight in view — the list scrolls at 10 items.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);
  // A new scope is a new list: back to its top, whatever the old one had
  // scrolled to (the highlight index is already 0 and would not move it).
  useEffect(() => {
    if (rowsRef.current) rowsRef.current.scrollTop = 0;
  }, [scope]);

  // Below the anchor by default, flipping above when the viewport is short on
  // room; `preferAbove` swaps the roles and falls back below the same way.
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const height = Math.min(240, window.innerHeight * 0.4);
    const above = { bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width };
    const below = { top: r.bottom + 4, left: r.left, width: r.width };
    if (preferAbove) {
      const spaceAbove = r.top - 8;
      setStyle(spaceAbove >= height ? above : below);
    } else {
      const spaceBelow = window.innerHeight - r.bottom - 8;
      setStyle(spaceBelow >= height ? below : above);
    }
  }, [anchorRef, items.length, preferAbove]);

  // Outside click closes — but a click inside the list is a selection.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target) || listRef.current?.contains(target)) return;
      onDismiss();
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [anchorRef, onDismiss]);

  return createPortal(
    <div ref={listRef} className={styles.picker} style={{ position: "fixed", zIndex: 500, ...style }}>
      <div className={styles.scopes}>
        {scopes.map((s) => (
          <button
            key={s}
            type="button"
            className={`${styles.scope} ${s === scope ? styles.scopeOn : ""}`}
            // mousedown, not click, and prevented: the textarea keeps focus and
            // its caret, the same reason the rows do it.
            onMouseDown={(e) => { e.preventDefault(); setScope(s); }}
          >
            {chip(s)}
          </button>
        ))}
        <span className={styles.scopeHint}><b>Tab</b> {t("ai.mention.tabHint", { defaultValue: "切档" })}</span>
      </div>
      <div ref={rowsRef} className={styles.list}>
      {items.length === 0 && <div className={styles.empty}><EmptyLine scope={scope} query={query} scopes={scopes} counts={counts} /></div>}
      {items.map((item, i) => {
        const key = mentionKey(item);
        const used = usedKeys.has(key);
        const isActive = i === activeIndex;
        const hit = hits.get(i);
        // Second line: a document's group, or — for an entry found by one of
        // its aliases — that alias, else a name with no visible match would
        // look like a wrong answer.
        const sub = hit?.alias ?? mentionSub(item, projectPath);
        const subRanges = hit?.alias ? hit.aliasRanges : hit?.sub;
        return (
          <button
            key={key}
            ref={isActive ? activeRef : undefined}
            className={`${styles.pickerItem} ${used ? styles.pickerItemUsed : ""} ${isActive ? styles.pickerItemActive : ""}`}
            // mousedown, not click: the textarea must not lose focus (and with
            // it the caret) before the mention is spliced in.
            onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
          >
            {item.type === "lore"
              ? <EntityThumb avatarPath={item.entity.avatarPath} />
              : <FileThumb file={item.file} />}
            <span className={styles.pickerText}>
              <span className={styles.pickerName}><Highlighted text={mentionLabel(item)} ranges={hit?.label} /></span>
              {/* A document's group: two chapters with one name are told apart
                  here, and a hit on the group path is shown where it landed. */}
              {sub && <span className={styles.pickerSub}><Highlighted text={sub} ranges={subRanges} /></span>}
            </span>
            {noteFor?.(item) && <span className={styles.pickerNote}>{noteFor(item)}</span>}
            {/* Lore keeps its category verbatim — that is the author's own
                vocabulary. File kinds are ours and get the workspace's words:
                terms.doc rather than 章节, because the workspace is a free file
                manager with no chapter model to classify against. */}
            <span className={styles.pickerBadge}>
              {item.type === "lore"
                ? item.entity.category
                : item.file.kind === "image"
                  ? t("ai.mention.badgeImage", { defaultValue: "图片" })
                : item.file.kind === "media" && videoMimeOf(item.file.path)
                  ? t("ai.mention.badgeVideo", { defaultValue: "视频" })
                : item.file.kind === "media"
                  ? t("ai.mention.badgeMedia", { defaultValue: "音频" })
                  // HTML files are read as text like any other, but calling one
                  // 文档 in a list beside the chapters hides the one thing that
                  // distinguishes it — it is the page, not prose about it.
                  : isHtmlPath(item.file.path)
                    ? "HTML"
                    : terms.doc}
            </span>
          </button>
        );
      })}
      </div>
    </div>,
    document.body,
  );
}
