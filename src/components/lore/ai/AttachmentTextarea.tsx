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
  mentionLabel,
  useMentionState,
  type MentionItem,
} from "../../common/MentionPicker";
import { readTextFileContent, type ProjectFile } from "../../../lib/fs/images";
import { imageForModel } from "../../../lib/image/normalize";
import { attachedKey, type AttachedItem } from "../../../lib/lore/aiTask";
import type { LoreEntity } from "../../../lib/lore";
import { availableScopes, countByScope, searchMentions } from "../../../lib/search/mentionSearch";
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
  // Scoped, ranked and cut in lib/search/mentionSearch (设计稿 02i), same as
  // the chat composers; the chip row is `availableScopes` and nothing else.
  const scopes = useMemo(() => availableScopes(candidates), [candidates]);
  const search = useMemo(
    () => searchMentions(candidates, mention.query, mention.scope, projectPath),
    [candidates, mention.query, mention.scope, projectPath],
  );
  const items = search.items;
  const counts = useMemo(
    () => (items.length === 0 ? countByScope(candidates, mention.query, projectPath) : undefined),
    [candidates, mention.query, projectPath, items.length],
  );
  const attachedKeys = new Set(attached.map(attachedKey));

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onInstructionChange(e.target.value);
    mention.sync(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  const handlePick = async (item: MentionItem) => {
    if (attachedKeys.has(mentionKey(item))) { mention.close(); return; }
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
        if (latest.current.attached.some((a) => attachedKey(a) === mentionKey(item))) {
          mention.close();
          return; // picked twice while the read was running
        }
        onAttachedChange([...latest.current.attached, attachment]);
      } catch {
        return; // skip unreadable
      }
    }
    onInstructionChange(mention.accept(latest.current.instruction, mentionLabel(item)));
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
            // Only while the picker is on screen — which, empty scope
            // included, is whenever the mention is open. Other keys fall
            // through to the textarea.
            if (!mention.open) return;
            // Consume Escape here so it closes the picker without also
            // dismissing the surrounding modal (ModalShell).
            if (e.key === "Escape") { e.preventDefault(); mention.close(); return; }
            // Tab cycles the scope, as in ⌘K; Enter alone picks (设计稿 02i).
            if (e.key === "Tab") { e.preventDefault(); mention.cycleScope(scopes, e.shiftKey ? -1 : 1); return; }
            if (e.key === "ArrowDown") { e.preventDefault(); mention.move(1, items.length); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); mention.move(-1, items.length); return; }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (items.length > 0) void handlePick(items[mention.active] ?? items[0]);
            }
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
          hits={search.hits}
          projectPath={projectPath}
          scopes={scopes}
          scope={mention.scope}
          onScopeChange={mention.setScope}
          query={mention.query}
          counts={counts}
          usedKeys={attachedKeys}
          activeIndex={mention.active}
          onPick={(item) => void handlePick(item)}
          onDismiss={mention.close}
        />
      )}
    </div>
  );
}
