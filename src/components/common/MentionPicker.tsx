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
import { FileText, Image as ImageIcon } from "lucide-react";
import { useImageDataUrl } from "../lore/useImageDataUrl";
import { imageToDataUrl, type ProjectFile } from "../../lib/fs/images";
import type { LoreEntity } from "../../lib/lore";
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
 * Where an `@` mention begins, given the text and the caret.
 *
 * Returns null unless the caret sits in a live mention — one whose `@` is at a
 * word boundary and which has no whitespace since. `foo@bar` is an email, not
 * a mention; `@第三` mid-word is one.
 */
export function findMention(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  // Preceded by a word character ⇒ part of something else (an address, a handle).
  if (at > 0 && /[\w@]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  // A space ends the mention: the author moved on and is writing prose again.
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

interface MentionState {
  open: boolean;
  query: string;
  /** Call from the textarea's onChange, after the value is committed. */
  sync: (value: string, caret: number) => void;
  /** Replace the in-progress mention with `@[label]`, returning the new text. */
  accept: (value: string, label: string) => string;
  close: () => void;
}

/** @-detection and splicing over a controlled text value. */
export function useMentionState(): MentionState {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const startRef = useRef(0);

  return {
    open,
    query,
    sync: (value, caret) => {
      const hit = findMention(value, caret);
      if (!hit) { setOpen(false); return; }
      startRef.current = hit.start;
      setQuery(hit.query);
      setOpen(true);
    },
    accept: (value, label) => {
      const start = startRef.current;
      const after = value.slice(start + 1 + query.length);
      setOpen(false);
      return `${value.slice(0, start)}@[${label}]${after}`;
    },
    close: () => setOpen(false),
  };
}

// ── Thumbnails ───────────────────────────────────────────────────────────────

function FileThumb({ file }: { file: ProjectFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (file.kind === "image") {
      imageToDataUrl(file.path).then(({ dataUrl }) => setUrl(dataUrl)).catch(() => {});
    }
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
  onPick: (item: MentionItem) => void;
  onDismiss: () => void;
}

export function MentionPicker({ anchorRef, items, usedKeys, onPick, onDismiss }: MentionPickerProps) {
  const [style, setStyle] = useState<React.CSSProperties>({});
  const listRef = useRef<HTMLDivElement>(null);

  // Below the anchor, flipping above when the viewport is short on room.
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const height = Math.min(240, window.innerHeight * 0.4);
    setStyle(spaceBelow >= height
      ? { top: r.bottom + 4, left: r.left, width: r.width }
      : { bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width });
  }, [anchorRef, items.length]);

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
      {items.map((item) => {
        const key = mentionKey(item);
        const used = usedKeys.has(key);
        return (
          <button
            key={key}
            className={`${styles.pickerItem} ${used ? styles.pickerItemUsed : ""}`}
            // mousedown, not click: the textarea must not lose focus (and with
            // it the caret) before the mention is spliced in.
            onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
          >
            {item.type === "lore"
              ? <EntityThumb avatarPath={item.entity.avatarPath} />
              : <FileThumb file={item.file} />}
            <span className={styles.pickerName}>{mentionLabel(item)}</span>
            <span className={styles.pickerBadge}>
              {item.type === "lore" ? item.entity.category : item.file.kind}
            </span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
