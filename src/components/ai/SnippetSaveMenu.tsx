/**
 * 存为片段 — the save half of the snippet library, and the patch this whole
 * feature turns on.
 *
 * Before this, keeping an instruction meant leaving the sentence you were
 * writing, opening Settings, and pasting it back into a drawer. Now it is a
 * right-click where the text already is. The two-step is deliberate:
 *
 *   ① The menu. The three assistant input boxes are bare `<textarea>`s, so
 *      their right-click today is the OS clipboard menu. Replacing it means we
 *      must *carry* 剪切／复制／粘贴／全选 ourselves — dropping them to make
 *      room for one new item would be a straight downgrade. On a message bubble
 *      the list changes to what is actually possible there (no cut, no paste;
 *      「全选」 becomes 「复制整条」).
 *   ② The naming popover replaces the menu **in place** — same coordinates, no
 *      re-anchor — so it never jumps out from under the cursor or covers the
 *      selection it is about to save. One field, name pre-filled from the body,
 *      ⏎ saves. No group picker: at save time the author's attention is on the
 *      sentence he is writing, and asking him to file it there is what kills the
 *      path. Everything lands in 「未分组」, the inbox the settings page exists
 *      to drain.
 *
 * With no selection the item saves the **whole** box rather than greying out —
 * making the author select-all first is pure tax (设计稿 1c②). Only a genuinely
 * empty box disables it.
 *
 * 设计稿 1c / 1l 流程 A.
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { Bookmark, ClipboardPaste, Copy, CornerUpLeft, Scissors, TextSelect } from "lucide-react";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import { IS_MAC } from "../../lib/platform";
import {
  taCopy, taCut, taHasSelection, taPaste, taSelectAll,
} from "../../lib/editor/textareaFormat";
import { SNIPPET_SCENE, type Prompt } from "../../lib/ai/configDb";
import { defaultSnippetName, findSnippetByName, previewLine, snippetsOf } from "../../lib/ai/snippets";
import { useAiStore } from "../../stores/aiStore";
import { showSnippetTrace } from "./snippetTrace";
import styles from "./SnippetSaveMenu.module.css";

function sc(...keys: string[]): string {
  if (IS_MAC) {
    return keys.map((k) => (k === "Mod" ? "⌘" : k === "Shift" ? "⇧" : k)).join("");
  }
  return keys.map((k) => (k === "Mod" ? "Ctrl" : k)).join("+");
}

/** What the pending save is about to store, and whether it came from a
 *  selection — the menu says which, so nothing is saved by surprise. */
interface Pending {
  x: number;
  y: number;
  body: string;
  fromSelection: boolean;
}

type State =
  | { phase: "menu"; x: number; y: number; items: ContextMenuEntry[] }
  | { phase: "name"; pending: Pending }
  /** ⏎/存 hit a name that already exists — same spot, same width, the
   *  popover itself asks instead of silently forking into a second record. */
  | { phase: "confirm"; pending: Pending; name: string; existing: Prompt }
  | null;

export interface SnippetSave {
  /** Drop straight onto a `<textarea>`'s `onContextMenu`. */
  onTextareaContextMenu: (e: MouseEvent<HTMLTextAreaElement>) => void;
  /** For a message bubble: pass the message's full text, and optionally a way
   *  to quote it back into the composer. */
  onMessageContextMenu: (
    e: MouseEvent,
    fullText: string,
    opts?: { onQuote?: (text: string) => void },
  ) => void;
  /** Render this once inside the surface that owns the menu. */
  node: ReactNode;
}

export function useSnippetSave(): SnippetSave {
  const { t } = useTranslation();
  const prompts = useAiStore((s) => s.prompts);
  const addPrompt = useAiStore((s) => s.addPrompt);
  const updatePrompt = useAiStore((s) => s.updatePrompt);
  const removePrompt = useAiStore((s) => s.removePrompt);
  const [state, setState] = useState<State>(null);

  // Stable across renders: these handlers are passed into memoised turn
  // components, and a fresh identity each render would defeat that memo.
  const saveItem = useCallback((body: string, fromSelection: boolean, x: number, y: number): ContextMenuEntry => ({
    kind: "item",
    icon: <Bookmark size={13} />,
    label: t("ai.snippets.saveAs", { defaultValue: "存为片段" }),
    // The count doubles as the guard against saving the wrong thing: it says
    // "selection" or "whole box" in the same glance as the item itself.
    shortcut: body
      ? fromSelection
        ? t("ai.snippets.savePartCount", { defaultValue: "选中 {{n}} 字", n: body.length })
        : t("ai.snippets.saveAllCount", { defaultValue: "整框 {{n}} 字", n: body.length })
      : undefined,
    disabled: !body.trim(),
    action: () => setState({ phase: "name", pending: { x, y, body, fromSelection } }),
  }), [t]);

  const onTextareaContextMenu = useCallback((e: MouseEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.focus();
    const sel = taHasSelection(el);
    const body = sel ? el.value.slice(el.selectionStart, el.selectionEnd) : el.value;
    const { clientX: x, clientY: y } = e;
    setState({
      phase: "menu",
      x, y,
      items: [
        { kind: "item", icon: <Scissors size={13} />, label: t("editor.menu.cut"),
          shortcut: sc("Mod", "X"), disabled: !sel, action: () => void taCut(el) },
        { kind: "item", icon: <Copy size={13} />, label: t("editor.menu.copy"),
          shortcut: sc("Mod", "C"), disabled: !sel, action: () => void taCopy(el) },
        { kind: "item", icon: <ClipboardPaste size={13} />, label: t("editor.menu.paste"),
          shortcut: sc("Mod", "V"), action: () => void taPaste(el) },
        { kind: "item", icon: <TextSelect size={13} />, label: t("editor.menu.selectAll"),
          shortcut: sc("Mod", "A"), action: () => taSelectAll(el) },
        { kind: "divider" },
        saveItem(body, sel, x, y),
      ],
    });
  }, [t, saveItem]);

  const onMessageContextMenu = useCallback((
    e: MouseEvent,
    fullText: string,
    opts?: { onQuote?: (text: string) => void },
  ) => {
    const picked = window.getSelection()?.toString() ?? "";
    // Only honour a selection that actually lies in the bubble being clicked —
    // a stale selection elsewhere on screen would otherwise be saved instead.
    const inside = picked.trim().length > 0 && fullText.includes(picked.trim());
    const sel = inside ? picked.trim() : "";
    const body = sel || fullText;
    e.preventDefault();
    const { clientX: x, clientY: y } = e;
    const items: ContextMenuEntry[] = [
      { kind: "item", icon: <Copy size={13} />, label: t("editor.menu.copy"),
        shortcut: sc("Mod", "C"), disabled: !sel,
        action: () => void navigator.clipboard.writeText(sel) },
      { kind: "item", icon: <Copy size={13} />,
        label: t("ai.snippets.copyWhole", { defaultValue: "复制整条" }),
        action: () => void navigator.clipboard.writeText(fullText) },
    ];
    if (opts?.onQuote) {
      items.push({
        kind: "item", icon: <CornerUpLeft size={13} />,
        label: t("ai.snippets.quote", { defaultValue: "引用到输入框" }),
        action: () => opts.onQuote?.(body),
      });
    }
    items.push({ kind: "divider" }, saveItem(body, !!sel, x, y));
    setState({ phase: "menu", x, y, items });
  }, [t, saveItem]);

  /**
   * ⏎/存 from the name field. A name that exactly matches an existing
   * snippet does **not** silently fork into a second record — that was the
   * shipped bug (see the session notes): insert grows the box, a re-save
   * under the same name looked like "editing" but was always `addPrompt`,
   * so the library grew a same-named duplicate with never-quite-the-same
   * body every time. Detecting it here means the check runs on the one path
   * that can create the collision — no schema-level unique constraint,
   * because renames must stay free.
   */
  const trySave = (name: string) => {
    if (state?.phase !== "name") return;
    const clash = findSnippetByName(snippetsOf(prompts), name);
    if (clash) {
      setState({ phase: "confirm", pending: state.pending, name, existing: clash });
      return;
    }
    void commitNew(name, state.pending.body);
  };

  const commitNew = async (name: string, body: string) => {
    setState(null);
    const id = await addPrompt({
      name: name.trim() || defaultSnippetName(body),
      content: body,
      scene: SNIPPET_SCENE,
      group: "",
      useCount: 0,
      lastUsedAt: 0,
    });
    showSnippetTrace({
      kind: "saved",
      name: name.trim(),
      group: t("ai.snippets.ungrouped", { defaultValue: "未分组" }),
      undo: () => void removePrompt(id),
    });
  };

  /** Overwrite keeps the existing row's id, group and usage history — only the
   *  body (and the name, in case casing/whitespace changed) move. Undo restores
   *  the exact prior body rather than deleting the row, since the row predates
   *  this save. */
  const commitOverwrite = async (existing: Prompt, name: string, body: string) => {
    setState(null);
    const before = existing.content;
    await updatePrompt({ ...existing, name: name.trim() || existing.name, content: body });
    showSnippetTrace({
      kind: "saved",
      name: name.trim() || existing.name,
      group: existing.group?.trim() || t("ai.snippets.ungrouped", { defaultValue: "未分组" }),
      undo: () => void updatePrompt({ ...existing, content: before }),
    });
  };

  const node = state?.phase === "menu" ? (
    <ContextMenu x={state.x} y={state.y} items={state.items} onClose={() => {
      // A pick switches us to the naming phase inside the item's own action,
      // which runs *after* ContextMenu calls onClose — so only clear when we
      // are still in the menu phase.
      setState((s) => (s?.phase === "menu" ? null : s));
    }} />
  ) : state?.phase === "name" ? (
    <NamePopover
      pending={state.pending}
      onCancel={() => setState(null)}
      onSave={trySave}
    />
  ) : state?.phase === "confirm" ? (
    <ConfirmPopover
      pending={state.pending}
      name={state.name}
      existing={state.existing}
      onCancel={() => setState(null)}
      onOverwrite={() => void commitOverwrite(state.existing, state.name, state.pending.body)}
      onSaveAsNew={() => void commitNew(state.name, state.pending.body)}
    />
  ) : null;

  return { onTextareaContextMenu, onMessageContextMenu, node };
}

/** One field, in the menu's own place. Nothing else fits the moment: the author
 *  is mid-sentence, and every extra control is a reason to abandon the save. */
function NamePopover({
  pending, onCancel, onSave,
}: {
  pending: Pending;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(() => defaultSnippetName(pending.body));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Pre-selected: type over it if the guess is wrong, press ⏎ if it is fine.
    el.select();
  }, []);

  const WIDTH = 320;
  const left = Math.min(pending.x, window.innerWidth - WIDTH - 8);
  const top = Math.min(pending.y, window.innerHeight - 150);

  return createPortal(
    <div className={styles.overlay} onMouseDown={onCancel}>
      <div
        className={styles.namePop}
        style={{ left, top, width: WIDTH }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className={styles.nameHead}>
          <span className={styles.nameTitle}>{t("ai.snippets.saveAs", { defaultValue: "存为片段" })}</span>
          <span className={styles.nameCount}>
            {t("ai.snippets.charCount", { defaultValue: "{{n}} 字", n: pending.body.length })}
          </span>
        </div>
        <input
          ref={inputRef}
          className={styles.nameInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onSave(name); }
            if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          }}
          placeholder={t("ai.snippets.namePlaceholder", { defaultValue: "给它起个名字" })}
        />
        <div className={styles.nameHint}>
          {t("ai.snippets.nameHint", { defaultValue: "分组稍后在设置里整理" })}
        </div>
        <div className={styles.nameFoot}>
          <button type="button" className={styles.nameCancel} onClick={onCancel}>
            esc {t("aiConfig.prompts.cancel")}
          </button>
          <button type="button" className={styles.nameSave} onClick={() => onSave(name)}>
            {t("ai.snippets.save", { defaultValue: "存" })} ⏎
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Same shell, same spot: the name field is not re-anchored, it just switches
 * what it is asking. Two ways out (覆盖 / 另存为新) plus esc, no third state —
 * a "back to editing the name" affordance was cut on purpose, since Escape
 * already gets there in one step by cancelling the whole save.
 */
function ConfirmPopover({
  pending, name, existing, onCancel, onOverwrite, onSaveAsNew,
}: {
  pending: Pending;
  name: string;
  existing: Prompt;
  onCancel: () => void;
  onOverwrite: () => void;
  onSaveAsNew: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const WIDTH = 320;
  const left = Math.min(pending.x, window.innerWidth - WIDTH - 8);
  const top = Math.min(pending.y, window.innerHeight - 190);

  return createPortal(
    <div className={styles.overlay} onMouseDown={onCancel}>
      <div
        className={styles.namePop}
        style={{ left, top, width: WIDTH }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className={styles.nameHead}>
          <span className={styles.nameTitle}>{t("ai.snippets.saveAs", { defaultValue: "存为片段" })}</span>
        </div>
        <div className={styles.warnBody}>
          {t("ai.snippets.duplicateWarn", { defaultValue: "已存在同名片段「{{name}}」", name })}
        </div>
        <div className={styles.warnPreview} title={previewLine(existing.content)}>
          {previewLine(existing.content)}
        </div>
        <div className={styles.nameFoot}>
          <button type="button" className={styles.nameCancel} onClick={onCancel}>
            esc {t("aiConfig.prompts.cancel")}
          </button>
          {/* .nameSave's own margin-left:auto is what pushes NamePopover's lone
              right button — here two buttons must move together, so the push
              lives on this wrapper instead of relying on that rule twice. */}
          <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
            <button type="button" className={styles.nameSaveNew} onClick={onSaveAsNew}>
              {t("ai.snippets.saveAsNew", { defaultValue: "另存为新" })}
            </button>
            <button type="button" className={`${styles.nameSave} ${styles.nameSaveInGroup}`} onClick={onOverwrite}>
              {t("ai.snippets.overwrite", { defaultValue: "覆盖" })}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
