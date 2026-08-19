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
 * Rendered through a portal so the list escapes the modal's overflow context —
 * inside it, the picker is clipped by the panel it is anchored to.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FileText, Image as ImageIcon } from "lucide-react";
import { useImageDataUrl } from "../lore/useImageDataUrl";
import { imageToDataUrl, isHtmlPath, type ProjectFile } from "../../lib/fs/images";
import type { LoreEntity } from "../../lib/lore";
// The pure vocabulary function, not stores/projectStore's useTerms hook: this
// module's helpers (findMention, filterMentions) are imported by node-side
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

/** Longest list shown at once — a picker is for recognising, not browsing. */
const MAX_ITEMS = 10;

/**
 * Filter the candidates against what has been typed after the `@`.
 *
 * Matches anywhere in the name rather than only the start: a chapter is far
 * more likely to be recalled by a word from its title than by its numbering.
 */
export function filterMentions(items: MentionItem[], query: string): MentionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, MAX_ITEMS);
  return items.filter((i) => mentionLabel(i).toLowerCase().includes(q)).slice(0, MAX_ITEMS);
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

export interface MentionState {
  open: boolean;
  query: string;
  /** Highlighted row — hosts drive it with ↑/↓ and confirm with Enter. */
  active: number;
  /** Call from the textarea's onChange, after the value is committed. */
  sync: (value: string, caret: number) => void;
  /** Replace the in-progress mention with `@[label]`, returning the new text. */
  accept: (value: string, label: string) => string;
  /** Move the highlight within a list of `count` items, wrapping at both ends. */
  move: (delta: number, count: number) => void;
  close: () => void;
}

/** @-detection and splicing over a controlled text value. */
export function useMentionState(): MentionState {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const startRef = useRef(0);
  // Mirrors `query` so the splice length and the "did it change" test read the
  // committed value rather than the one this render closed over.
  const queryRef = useRef("");

  return {
    open,
    query,
    active,
    sync: (value, caret) => {
      const hit = findMention(value, caret);
      if (!hit) { setOpen(false); return; }
      startRef.current = hit.start;
      // A changed query is a different list, so the old highlight index means
      // nothing — start from the top rather than pointing at whatever happens
      // to occupy that slot now.
      if (queryRef.current !== hit.query) {
        queryRef.current = hit.query;
        setActive(0);
      }
      setQuery(hit.query);
      setOpen(true);
    },
    accept: (value, label) => {
      const start = startRef.current;
      const after = value.slice(start + 1 + queryRef.current.length);
      queryRef.current = "";
      setOpen(false);
      setActive(0);
      return `${value.slice(0, start)}@[${label}]${after}`;
    },
    move: (delta, count) => {
      if (count <= 0) return;
      setActive((i) => (((i + delta) % count) + count) % count);
    },
    close: () => { setOpen(false); setActive(0); },
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
    imageToDataUrl(file.path)
      .then(({ dataUrl }) => { if (!cancelled) setUrl(dataUrl); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [file.path, file.kind]);

  if (file.kind === "text" || !url) {
    return (
      <div className={styles.pickerThumbPlaceholder}>
        {file.kind === "image" ? <ImageIcon size={12} /> : <FileText size={12} />}
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

// ── The list ─────────────────────────────────────────────────────────────────

interface MentionPickerProps {
  /** Element the list anchors to — usually the textarea's wrapper. */
  anchorRef: React.RefObject<HTMLElement | null>;
  items: MentionItem[];
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
  onPick: (item: MentionItem) => void;
  onDismiss: () => void;
}

export function MentionPicker({
  anchorRef, items, usedKeys, activeIndex = 0, preferAbove = false, onPick, onDismiss,
}: MentionPickerProps) {
  const { t, i18n } = useTranslation();
  const terms = appTerms(i18n.language.startsWith("zh"));
  const [style, setStyle] = useState<React.CSSProperties>({});
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the keyboard highlight in view — the list scrolls at 10 items.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

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

  if (items.length === 0) return null;

  return createPortal(
    <div ref={listRef} className={styles.picker} style={{ position: "fixed", zIndex: 500, ...style }}>
      {items.map((item, i) => {
        const key = mentionKey(item);
        const used = usedKeys.has(key);
        const isActive = i === activeIndex;
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
            <span className={styles.pickerName}>{mentionLabel(item)}</span>
            {/* Lore keeps its category verbatim — that is the author's own
                vocabulary. File kinds are ours and get the workspace's words:
                terms.doc rather than 章节, because the workspace is a free file
                manager with no chapter model to classify against. */}
            <span className={styles.pickerBadge}>
              {item.type === "lore"
                ? item.entity.category
                : item.file.kind === "image"
                  ? t("ai.mention.badgeImage", { defaultValue: "图片" })
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
    </div>,
    document.body,
  );
}
