/**
 * Reusable @-mention composer for lore AI tasks: an instruction textarea whose
 * `@` opens a picker of other lore entities and project files/images. Picked
 * items become attachment chips and are reported to the host via
 * `onAttachedChange`; the host reads `attached` to build the AI request (see
 * `lib/lore/aiTask`). Attachment + instruction state are fully controlled.
 *
 * The picker itself is shared with the chat composer — see
 * components/common/MentionPicker.
 */

import { useRef } from "react";
import { Image, X } from "lucide-react";
import { MarkdownTextarea } from "../../common/MarkdownTextarea";
import {
  MentionPicker,
  filterMentions,
  mentionKey,
  mentionLabel,
  useMentionState,
  type MentionItem,
} from "../../common/MentionPicker";
import { imageToDataUrl, readTextFileContent, type ProjectFile } from "../../../lib/fs/images";
import { attachedKey, type AttachedItem } from "../../../lib/lore/aiTask";
import type { LoreEntity } from "../../../lib/lore";
import styles from "./AttachmentTextarea.module.css";

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
  const mention = useMentionState();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const candidates: MentionItem[] = [
    ...entities.map((entity): MentionItem => ({ type: "lore", entity })),
    ...projectFiles.map((file): MentionItem => ({ type: "file", file })),
  ];
  const items = filterMentions(candidates, mention.query);
  const attachedKeys = new Set(attached.map(attachedKey));

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onInstructionChange(e.target.value);
    mention.sync(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  const handlePick = async (item: MentionItem) => {
    if (attachedKeys.has(mentionKey(item))) { mention.close(); return; }
    if (item.type === "lore") {
      onAttachedChange([...attached, { kind: "lore", entity: item.entity }]);
    } else {
      try {
        if (item.file.kind === "image") {
          const { dataUrl } = await imageToDataUrl(item.file.path);
          onAttachedChange([...attached, { kind: "image", file: item.file, dataUrl }]);
        } else {
          const content = await readTextFileContent(item.file.path);
          onAttachedChange([...attached, { kind: "text", file: item.file, content }]);
        }
      } catch {
        return; // skip unreadable
      }
    }
    onInstructionChange(mention.accept(instruction, mentionLabel(item)));
    textareaRef.current?.focus();
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
            if (e.key === "Escape" && mention.open) { e.preventDefault(); mention.close(); }
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

      {mention.open && (
        <MentionPicker
          anchorRef={wrapRef}
          items={items}
          usedKeys={attachedKeys}
          onPick={(item) => void handlePick(item)}
          onDismiss={mention.close}
        />
      )}
    </div>
  );
}
