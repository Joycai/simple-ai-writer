/**
 * Reusable @-mention composer for lore AI tasks: an instruction textarea whose
 * `@` opens a picker of other lore entities and project files/images. Picked
 * items become attachment chips and are reported to the host via
 * `onAttachedChange`; the host reads `attached` to build the AI request (see
 * `lib/lore/aiTask`). Attachment + instruction state are fully controlled.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Image, X } from "lucide-react";
import { MarkdownTextarea } from "../../common/MarkdownTextarea";
import { useImageDataUrl } from "../useImageDataUrl";
import { imageToDataUrl, readTextFileContent, type ProjectFile } from "../../../lib/fs/images";
import { attachedKey, type AttachedItem } from "../../../lib/lore/aiTask";
import type { LoreEntity } from "../../../lib/lore";
import styles from "./AttachmentTextarea.module.css";

type PickerItem =
  | { type: "lore"; entity: LoreEntity }
  | { type: "file"; file: ProjectFile };

// ── Lazy thumbnails for the @ picker ──────────────────────────────────────────

function PickerThumb({ file }: { file: ProjectFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (file.kind === "image") {
      imageToDataUrl(file.path).then(({ dataUrl }) => setUrl(dataUrl)).catch(() => {});
    }
  }, [file.path, file.kind]);

  if (file.kind === "text" || !url) {
    return (
      <div className={styles.pickerThumbPlaceholder}>
        {file.kind === "image" ? <Image size={12} /> : <FileText size={12} />}
      </div>
    );
  }
  return <img src={url} className={styles.pickerThumb} alt="" />;
}

/** Avatar thumb for a lore entity in the @ picker (data URL, not assetUrl). */
function EntityThumb({ avatarPath }: { avatarPath: string | null }) {
  const url = useImageDataUrl(avatarPath);
  if (!url) {
    return <div className={styles.pickerThumbPlaceholder}><FileText size={12} /></div>;
  }
  return <img src={url} className={styles.pickerThumb} alt="" />;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface AttachmentTextareaProps {
  instruction: string;
  onInstructionChange: (value: string) => void;
  attached: AttachedItem[];
  onAttachedChange: (next: AttachedItem[]) => void;
  /** Lore entities offered in the @ picker (caller excludes the current one). */
  entities?: LoreEntity[];
  /** Project files/images offered in the @ picker. */
  projectFiles?: ProjectFile[];
  disabled?: boolean;
  rows?: number;
  placeholder?: string;
  autoFocus?: boolean;
  /** Class for the textarea itself; the host owns its look. */
  textareaClassName?: string;
}

export function AttachmentTextarea({
  instruction,
  onInstructionChange,
  attached,
  onAttachedChange,
  entities = [],
  projectFiles = [],
  disabled = false,
  rows = 4,
  placeholder,
  autoFocus = false,
  textareaClassName,
}: AttachmentTextareaProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [atQuery, setAtQuery] = useState("");
  const [atIndex, setAtIndex] = useState(0);
  const [pickerStyle, setPickerStyle] = useState<React.CSSProperties>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Position the picker below the textarea, flipping above when short on room.
  useEffect(() => {
    if (showPicker && wrapRef.current) {
      const r = wrapRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const pickerH = Math.min(240, window.innerHeight * 0.4);
      if (spaceBelow >= pickerH) {
        setPickerStyle({ top: r.bottom + 4, left: r.left, width: r.width });
      } else {
        setPickerStyle({ bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width });
      }
    }
  }, [showPicker]);

  // Close the picker on outside click — but never when clicking inside it.
  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || pickerRef.current?.contains(target)) return;
      setShowPicker(false);
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [showPicker]);

  const pickerItems: PickerItem[] = [
    ...entities
      .filter((e) => !atQuery || e.name.toLowerCase().includes(atQuery))
      .map((e): PickerItem => ({ type: "lore", entity: e })),
    ...projectFiles
      .filter((f) => !atQuery || f.name.toLowerCase().includes(atQuery))
      .map((f): PickerItem => ({ type: "file", file: f })),
  ].slice(0, 10);

  const itemKey = (item: PickerItem) =>
    item.type === "lore" ? `lore:${item.entity.id}` : `file:${item.file.path}`;

  const attachedKeys = new Set(attached.map(attachedKey));

  // ── @ detection ────────────────────────────────────────────────────────────
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    onInstructionChange(val);
    const pos = e.target.selectionStart ?? val.length;
    const before = val.slice(0, pos);
    const match = before.match(/@(\w*)$/);
    if (match) {
      setAtIndex(pos - match[0].length);
      setAtQuery(match[1].toLowerCase());
      setShowPicker(true);
    } else {
      setShowPicker(false);
    }
  };

  const insertAtLabel = (label: string) => {
    const before = instruction.slice(0, atIndex);
    const after = instruction.slice(atIndex + 1 + atQuery.length);
    onInstructionChange(`${before}@[${label}]${after}`);
    setShowPicker(false);
    textareaRef.current?.focus();
  };

  const handlePickItem = async (item: PickerItem) => {
    if (attachedKeys.has(itemKey(item))) { setShowPicker(false); return; }
    if (item.type === "lore") {
      onAttachedChange([...attached, { kind: "lore", entity: item.entity }]);
      insertAtLabel(item.entity.name);
    } else {
      try {
        if (item.file.kind === "image") {
          const { dataUrl } = await imageToDataUrl(item.file.path);
          onAttachedChange([...attached, { kind: "image", file: item.file, dataUrl }]);
        } else {
          const content = await readTextFileContent(item.file.path);
          onAttachedChange([...attached, { kind: "text", file: item.file, content }]);
        }
        insertAtLabel(item.file.name);
      } catch { /* skip unreadable */ }
    }
  };

  const removeAttached = (key: string) =>
    onAttachedChange(attached.filter((a) => attachedKey(a) !== key));

  return (
    <div className={styles.root}>
      <div ref={wrapRef}>
        <MarkdownTextarea
          format={false}
          ref={textareaRef}
          className={textareaClassName}
          rows={rows}
          placeholder={placeholder}
          value={instruction}
          onChange={handleChange}
          onKeyDown={(e) => {
            // Consume Escape while the picker is open so it closes the picker
            // without also dismissing the surrounding modal (ModalShell).
            if (e.key === "Escape" && showPicker) { e.preventDefault(); setShowPicker(false); }
          }}
          disabled={disabled}
          autoFocus={autoFocus}
        />
      </div>

      {attached.length > 0 && (
        <div className={styles.chips}>
          {attached.map((a) => {
            const key = attachedKey(a);
            const label = a.kind === "lore" ? a.entity.name : a.file.name;
            return (
              <span key={key} className={`${styles.chip} ${a.kind === "image" ? styles.chipImage : ""}`}>
                {a.kind === "image" && <Image size={10} />}
                @{label}
                <button className={styles.chipRemove} onClick={() => removeAttached(key)}>
                  <X size={10} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Picker rendered via portal — escapes the modal's overflow context. */}
      {showPicker && pickerItems.length > 0 && createPortal(
        <div ref={pickerRef} className={styles.picker} style={{ position: "fixed", zIndex: 500, ...pickerStyle }}>
          {pickerItems.map((item) => {
            const key = itemKey(item);
            const used = attachedKeys.has(key);
            return (
              <button
                key={key}
                className={`${styles.pickerItem} ${used ? styles.pickerItemUsed : ""}`}
                onMouseDown={(e) => { e.preventDefault(); void handlePickItem(item); }}
              >
                {item.type === "lore"
                  ? <EntityThumb avatarPath={item.entity.avatarPath} />
                  : <PickerThumb file={item.file} />}
                <span className={styles.pickerName}>
                  {item.type === "lore" ? item.entity.name : item.file.name}
                </span>
                <span className={styles.pickerBadge}>
                  {item.type === "lore" ? item.entity.category : item.file.kind}
                </span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
