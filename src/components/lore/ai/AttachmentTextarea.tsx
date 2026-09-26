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

import { useMemo, useRef } from "react";
import { Image, X } from "lucide-react";
import { MarkdownTextarea } from "../../common/MarkdownTextarea";
import {
  MentionPicker,
  mentionKey,
  mentionKeyDown,
  useMentionSearch,
  useMentionState,
  usePendingCaret,
  type MentionItem,
} from "../../common/MentionPicker";
import { readTextFileContent, type ProjectFile } from "../../../lib/fs/images";
import { imageForModel } from "../../../lib/image/normalize";
import { attachedKey, type AttachedItem } from "../../../lib/lore/aiTask";
import type { LoreEntity } from "../../../lib/lore";
import { useImeGuard } from "../../../lib/ime";
import { useProjectStore } from "../../../stores/projectStore";
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
  // A pinyin Enter commits the word being typed; it must not also pick a row.
  const ime = useImeGuard();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const placeCaret = usePendingCaret(textareaRef, instruction);
  const wrapRef = useRef<HTMLDivElement>(null);
  // `attached` and `instruction` are props captured at render. Reading a large
  // image as base64 takes long enough for the author to keep typing, and for a
  // second pick to start — both of which the pre-await values would undo.
  const latest = useRef({ attached, instruction });
  latest.current = { attached, instruction };

  // For a document's group-path line and its share of the match.
  const projectPath = useProjectStore((s) => s.projectPath);
  const candidates: MentionItem[] = useMemo(() => [
    ...entities.map((entity): MentionItem => ({ type: "lore", entity })),
    // No recordings on a lore surface: nothing here can read or transcribe
    // one, and the fallback branch below would try to read it as text.
    ...projectFiles.filter((f) => f.kind !== "media").map((file): MentionItem => ({ type: "file", file })),
  ], [entities, projectFiles]);
  // Scoped, ranked and cut (设计稿 02i) by the same hook as the chat
  // composers; `search.open` is the picker's one gate.
  const search = useMentionSearch(candidates, mention, projectPath);
  const attachedKeys = new Set(attached.map(attachedKey));

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onInstructionChange(e.target.value);
    mention.sync(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  const handlePick = async (item: MentionItem) => {
    if (attachedKeys.has(mentionKey(item))) { mention.close(); return; }
    // Before the await: the mention this pick came from.
    const claim = mention.claim(latest.current.instruction);
    if (!claim) return;
    if (item.type === "lore") {
      onAttachedChange([...latest.current.attached, { kind: "lore", entity: item.entity }]);
    } else {
      try {
        // Resolve first, then append to whatever the list is *now*: appending
        // to the array this closure captured would drop a chip attached while
        // the read was in flight.
        const attachment: AttachedItem = item.file.kind === "image"
          ? { kind: "image", file: item.file, dataUrl: (await imageForModel(item.file.path)).dataUrl }
          : { kind: "text", file: item.file, content: await readTextFileContent(item.file.path) };
        // Picked twice while the read was running: the first pick's accept
        // already closed the claimed mention, and a mention opened since is
        // not this pick's to close.
        if (latest.current.attached.some((a) => attachedKey(a) === mentionKey(item))) return;
        onAttachedChange([...latest.current.attached, attachment]);
      } catch {
        return; // skip unreadable
      }
    }
    const landed = mention.accept(
      latest.current.instruction, item, claim, projectPath,
      textareaRef.current?.selectionStart ?? null,
    );
    placeCaret(landed.caret, landed.text);
    onInstructionChange(landed.text);
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
          // The picker's keys while it is on screen; everything else falls
          // through to the textarea. Escape is consumed there so it closes the
          // picker without also dismissing the surrounding modal (ModalShell).
          onKeyDown={(e) => { mentionKeyDown(e, mention, search, ime.isComposing(e), (item) => void handlePick(item)); }}
          disabled={disabled}
          autoFocus={autoFocus}
          {...ime.imeProps}
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

      {search.open && (
        <MentionPicker
          anchorRef={wrapRef}
          mention={mention}
          search={search}
          projectPath={projectPath}
          usedKeys={attachedKeys}
          onPick={(item) => void handlePick(item)}
        />
      )}
    </div>
  );
}
