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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AudioLines, FileText, Film, Image as ImageIcon } from "lucide-react";
import { useImageDataUrl } from "../lore/useImageDataUrl";
import { imageToThumbnailDataUrl, isHtmlPath, type ProjectFile } from "../../lib/fs/images";
import { videoMimeOf } from "../../lib/fs/video";
import type { LoreEntity } from "../../lib/lore";
import { matchText } from "../../lib/search/globalSearch";
import {
  availableScopes,
  countByScope,
  cycleScope,
  hasHits,
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

export function mentionLabel(item: MentionItem): string {
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
 * as a name starting with `【`, which was always a terminator. An author-typed
 * `@[` is the price; it is a deliberate one.
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
  if (/@\[[^\]\n]*$/.test(before.slice(0, at))) return null;
  const query = before.slice(at + 1);
  if (query.startsWith("[")) return null;
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
   * A pick's handle on the mention it came from — take it *before* any
   * await, hand it to `accept` after. Null when no mention is open.
   */
  claim: () => MentionClaim | null;
  /**
   * Replace the claimed mention with `@[label]`, returning the new text.
   * A second accept on the same claim's mention is a no-op on the text (a
   * double-click, or Enter twice on a slow file), and a mention opened
   * since is left alone.
   */
  accept: (value: string, label: string, claim: MentionClaim) => string;
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

/** What a pick holds on to across its file read: which mention, and where it was. */
interface MentionClaim {
  id: number;
  start: number;
  query: string;
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
 * What `accept` splices by: the last *open* mention's place, kept past a
 * close. A file pick splices only after the file has been read, and the
 * mention can close in between (a 「，」 typed, Esc, a click outside) —
 * `CLOSED`'s 0 / "" would splice at the head of the draft, which once ate its
 * first character. Pure, so the "closed keeps" rule has a test.
 */
export function nextLive(prev: MentionClaim, core: MentionCore): MentionClaim {
  return core.open ? { id: core.id, start: core.start, query: core.query } : prev;
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
 */
export function spliceMention(value: string, start: number, query: string, label: string): string {
  const end = start + 1 + query.length;
  if (value.slice(start, end) !== `@${query}`) return value;
  return `${value.slice(0, start)}@[${label}]${value.slice(end)}`;
}

/**
 * What accepting `claim` does to the open state: closes the claimed mention
 * and no other. A mention opened since (the author moved on to `@夜` while
 * the file read) is theirs to keep; one already closed stays as it is.
 */
export function closeClaimed(core: MentionCore, claim: MentionClaim): MentionCore {
  return core.open && core.id === claim.id ? shut(core) : core;
}

/**
 * The text a pick lands, pure. `spent` holds the mentions a pick has already
 * landed on: a second Enter on a slow file, or a double-click, is one splice
 * (`spend` false, text unchanged). `live` is the mention as it is *now*: when
 * the claimed one is still open and the author has kept narrowing it while
 * the file read (`@潮` → `@潮汐`, and `潮汐` still matches the picked name), the
 * whole current query is replaced, not the snapshot's — otherwise the extra
 * letters would be left as a tail after `@[潮汐.png]`. Prose typed after it
 * that does not match (`@潮的图`) is prose, and stays.
 */
export function acceptMention(
  spent: ReadonlySet<number>,
  claim: MentionClaim,
  live: MentionClaim,
  value: string,
  label: string,
): { text: string; spend: boolean } {
  if (spent.has(claim.id)) return { text: value, spend: false };
  const grown = live.id === claim.id && live.query !== claim.query && matchText(label, live.query) !== null;
  const query = grown ? live.query : claim.query;
  return { text: spliceMention(value, claim.start, query, label), spend: true };
}

/** @-detection and splicing over a controlled text value. */
export function useMentionState(): MentionState {
  const [state, setState] = useState<MentionCore>(CLOSED);
  // The committed place of the last open mention (see nextLive) — the render
  // that made a handler may have closed over an older one.
  const live = useRef<MentionClaim>({ id: 0, start: 0, query: "" });
  live.current = nextLive(live.current, state);
  // Mentions a pick has already landed on: the second Enter on a slow file,
  // or a double-click, must not splice `@[名字]` a second time.
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
    claim: () => (state.open ? { ...live.current } : null),
    accept: (value, label, claim) => {
      const { text, spend } = acceptMention(spent.current, claim, live.current, value, label);
      if (spend) {
        spent.current.add(claim.id);
        setState((s) => closeClaimed(s, claim));
      }
      return text;
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
   * would show. Only the empty line and the Enter rule read it, so it is
   * computed only for an empty list.
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
