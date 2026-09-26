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
 * `@` starts at 全部. Matching and ranking live in `lib/search/mentionSearch`
 * (the hosts call it and hand the result in); this component only draws.
 * An empty scope still renders the chip row plus one line saying where the
 * hits are — a list that vanished on zero matches left the author unable to
 * see which scope they were in, let alone leave it.
 *
 * Rendered through a portal so the list escapes the modal's overflow context —
 * inside it, the picker is clipped by the panel it is anchored to.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AudioLines, FileText, Film, Image as ImageIcon } from "lucide-react";
import { useImageDataUrl } from "../lore/useImageDataUrl";
import { imageToThumbnailDataUrl, isHtmlPath, type ProjectFile } from "../../lib/fs/images";
import { videoMimeOf } from "../../lib/fs/video";
import type { LoreEntity } from "../../lib/lore";
import type { MatchRange } from "../../lib/search/globalSearch";
import {
  cycleScope,
  mentionSub,
  type MentionHit,
  type MentionScope,
  type ScopedKind,
} from "../../lib/search/mentionSearch";
// The pure vocabulary function, not stores/projectStore's useTerms hook: this
// module's helpers (findMention, useMentionState) are imported by node-side
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
 * the rest of the message. Nothing was on screen (the picker renders nothing
 * with no matches) while the composer kept treating every keystroke as part of
 * a mention. Longer than any entity or chapter name worth recognising.
 */
const MAX_QUERY_LEN = 24;

/** What ends a mention besides ASCII whitespace: full-width space and CJK punctuation. */
const CJK_TERMINATORS = /[　、。，；：？！（）【】「」“”]/;

/**
 * Where an `@` mention begins, given the text and the caret.
 *
 * Returns null unless the caret sits in a live mention — one whose `@` is at a
 * word boundary and which has no terminator since. `foo@bar` is an email, not
 * a mention; `@第三` mid-word is one.
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
  const query = before.slice(at + 1);
  // The author moved on and is writing prose again.
  if (/\s/.test(query) || CJK_TERMINATORS.test(query)) return null;
  if (query.length > MAX_QUERY_LEN) return null;
  return { start: at, query };
}

interface MentionState {
  open: boolean;
  query: string;
  /** Highlighted row — hosts drive it with ↑/↓ and confirm with Enter. */
  active: number;
  /** Which kind the list is narrowed to. 全部 on every fresh `@`. */
  scope: MentionScope;
  /** Call from the textarea's onChange, after the value is committed. */
  sync: (value: string, caret: number) => void;
  /** Replace the in-progress mention with `@[label]`, returning the new text. */
  accept: (value: string, label: string) => string;
  /** Move the highlight within a list of `count` items, wrapping at both ends. */
  move: (delta: number, count: number) => void;
  /** Pick a scope chip; the highlight goes back to the top of the new list. */
  setScope: (scope: MentionScope) => void;
  /** Tab / Shift+Tab: the next chip among those on offer. */
  cycleScope: (scopes: readonly MentionScope[], dir: 1 | -1) => void;
  close: () => void;
}

/** @-detection and splicing over a controlled text value. */
export function useMentionState(): MentionState {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [scope, setScopeState] = useState<MentionScope>("all");
  const startRef = useRef(0);
  // Mirrors `query` so the splice length and the "did it change" test read the
  // committed value rather than the one this render closed over.
  const queryRef = useRef("");
  // Mirrors `open` for the same reason: `sync` must know whether this
  // keystroke *opens* the mention (scope resets) or continues one (it keeps).
  const openRef = useRef(false);

  const setScope = (s: MentionScope) => { setScopeState(s); setActive(0); };

  return {
    open,
    query,
    active,
    scope,
    sync: (value, caret) => {
      const hit = findMention(value, caret);
      if (!hit) { setOpen(false); openRef.current = false; return; }
      startRef.current = hit.start;
      // A changed query is a different list, so the old highlight index means
      // nothing — start from the top rather than pointing at whatever happens
      // to occupy that slot now.
      if (queryRef.current !== hit.query) {
        queryRef.current = hit.query;
        setActive(0);
      }
      // A fresh `@` searches everything. The scope is not remembered across
      // mentions: one message can open the picker a dozen times, and a
      // narrow scope left over from the last one is a silent trap — the
      // author types `@` for a picture and concludes the picture is gone.
      if (!openRef.current) setScopeState("all");
      openRef.current = true;
      setQuery(hit.query);
      setOpen(true);
    },
    accept: (value, label) => {
      const start = startRef.current;
      const after = value.slice(start + 1 + queryRef.current.length);
      queryRef.current = "";
      openRef.current = false;
      setOpen(false);
      setActive(0);
      return `${value.slice(0, start)}@[${label}]${after}`;
    },
    move: (delta, count) => {
      if (count <= 0) return;
      setActive((i) => (((i + delta) % count) + count) % count);
    },
    setScope,
    cycleScope: (scopes, dir) => setScope(cycleScope(scopes, scope, dir)),
    close: () => { openRef.current = false; setOpen(false); setActive(0); },
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

/** Text with its matched fragments marked — ranges come from the search, merged and sorted. */
function Highlighted({ text, ranges }: { text: string; ranges: readonly MatchRange[] | undefined }) {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start > at) parts.push(text.slice(at, r.start));
    parts.push(<span key={r.start} className={styles.hl}>{text.slice(r.start, r.end)}</span>);
    at = r.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

// ── The list ─────────────────────────────────────────────────────────────────

interface MentionPickerProps {
  /** Element the list anchors to — usually the textarea's wrapper. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Already scoped, ranked and cut — `searchMentions(...).items`. */
  items: MentionItem[];
  /** `searchMentions(...).hits`: where each shown row matched. Absent for an empty query. */
  hits?: ReadonlyMap<number, MentionHit>;
  /** The project root, for a document's group-path line. */
  projectPath: string | null;
  /** Chips on offer — `availableScopes(candidates)`. */
  scopes: readonly MentionScope[];
  scope: MentionScope;
  onScopeChange: (scope: MentionScope) => void;
  /** What has been typed after the `@`; the empty line quotes it. */
  query: string;
  /**
   * Hits per kind for this query, ignoring the scope — what the *other*
   * chips would show. Only read when `items` is empty, so a host may skip
   * computing it otherwise.
   */
  counts?: Record<ScopedKind, number>;
  /** Keys already attached; shown dimmed and inert. */
  usedKeys: Set<string>;
  /** Row the host's ↑/↓ has highlighted, and what Enter will pick. */
  activeIndex?: number;
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
  onDismiss: () => void;
}

export function MentionPicker({
  anchorRef, items, hits, projectPath, scopes, scope, onScopeChange, query, counts,
  usedKeys, activeIndex = 0, preferAbove = false, noteFor, onPick, onDismiss,
}: MentionPickerProps) {
  const { t, i18n } = useTranslation();
  const terms = appTerms(i18n.language.startsWith("zh"));
  const [style, setStyle] = useState<React.CSSProperties>({});
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // The chips keep the author's own words — 条目 / 文档 are whatever the
  // workspace calls them; only 全部 and 图片 are the picker's.
  const scopeLabel = (s: MentionScope): string =>
    s === "all" ? t("ai.mention.scopeAll", { defaultValue: "全部" })
      : s === "lore" ? terms.entry
        : s === "text" ? terms.doc
          : t("ai.mention.scopeImage", { defaultValue: "图片" });

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

  /**
   * The empty scope's one line: what is missing here, what the other chips
   * hold, and the key that gets there. Three cases — nothing anywhere,
   * nothing here for this query, nothing here at all (a scope emptied by a
   * model change) — each a plain fact, never an instruction to click.
   */
  const emptyLine = () => {
    const here = scopeLabel(scope);
    const q = query.trim();
    const others = (["lore", "text", "image"] as const)
      .filter((k) => k !== scope && scopes.includes(k) && (counts?.[k] ?? 0) > 0);
    if (others.length === 0) {
      return q
        ? t("ai.mention.emptyAll", { q, defaultValue: "没有匹配「{{q}}」" })
        : t("ai.mention.emptyScope", { scope: here, defaultValue: "{{scope}}里还没有内容" });
    }
    const head = scope === "all"
      ? null
      : q
        ? t("ai.mention.emptyIn", { scope: here, q, defaultValue: "{{scope}}里没有「{{q}}」" })
        : t("ai.mention.emptyScope", { scope: here, defaultValue: "{{scope}}里还没有内容" });
    // The count is the one thing on this line worth the eye: interpolate a
    // sentinel for {{n}} and put the number back in a <b>.
    const SENT = "\u0000";
    const parts = others.map((k) => {
      const n = counts?.[k] ?? 0;
      const text = t(
        k === "lore" ? "ai.mention.countLore" : k === "text" ? "ai.mention.countText" : "ai.mention.countImage",
        { scope: scopeLabel(k), n: SENT, defaultValue: k === "lore" ? "{{scope}}里有 {{n}} 条" : k === "text" ? "{{scope}}里有 {{n}} 篇" : "{{scope}}里有 {{n}} 张" },
      );
      const [before, after] = text.split(SENT);
      return <span key={k}>{before}<b>{n}</b>{after ?? ""}</span>;
    });
    return (
      <>
        {head && <>{head}{" · "}</>}
        {parts.map((p, i) => <span key={i}>{i > 0 && " · "}{p}</span>)}
        {" · "}<i>Tab</i> {t("ai.mention.switchOver", { defaultValue: "切过去" })}
      </>
    );
  };

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
            onMouseDown={(e) => { e.preventDefault(); onScopeChange(s); }}
          >
            {scopeLabel(s)}
          </button>
        ))}
        <span className={styles.scopeHint}><b>Tab</b> {t("ai.mention.tabHint", { defaultValue: "切档" })}</span>
      </div>
      <div ref={rowsRef} className={styles.list}>
      {items.length === 0 && <div className={styles.empty}>{emptyLine()}</div>}
      {items.map((item, i) => {
        const key = mentionKey(item);
        const used = usedKeys.has(key);
        const isActive = i === activeIndex;
        const hit = hits?.get(i);
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
