import { forwardRef, useRef, useState, type TextareaHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import {
  Scissors,
  Copy,
  ClipboardPaste,
  TextSelect,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link as LinkIcon,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  List,
} from "lucide-react";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { IS_MAC } from "../../lib/platform";
import {
  handleTextareaShortcut,
  taHasSelection,
  taCopy,
  taCut,
  taPaste,
  taSelectAll,
  taBold,
  taItalic,
  taStrikethrough,
  taInlineCode,
  taLink,
  taHeading,
  taQuote,
  taBulletList,
} from "../../lib/editor/textareaFormat";

/** Shortcut hint using the platform's modifier glyphs. */
function sc(...keys: string[]): string {
  if (IS_MAC) {
    return keys
      .map((k) => (k === "Mod" ? "⌘" : k === "Shift" ? "⇧" : k === "Alt" ? "⌥" : k))
      .join("");
  }
  return keys.map((k) => (k === "Mod" ? "Ctrl" : k)).join("+");
}

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Include markdown formatting items + shortcuts (default true). Set false for
   *  short plain-text inputs where only clipboard actions make sense. */
  format?: boolean;
}

/**
 * A drop-in `<textarea>` with the app's custom right-click menu and markdown
 * formatting shortcuts, replacing the webview's native context menu. Forwards
 * refs and composes any passed `onKeyDown`, so it slots into existing fields
 * (including the @-mention inputs) without changing their behaviour.
 */
export const MarkdownTextarea = forwardRef<HTMLTextAreaElement, Props>(function MarkdownTextarea(
  { format = true, onKeyDown, onContextMenu, ...rest },
  forwardedRef,
) {
  const { t } = useTranslation();
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const setRefs = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  const buildItems = (el: HTMLTextAreaElement): ContextMenuEntry[] => {
    const sel = taHasSelection(el);
    const clipboard: ContextMenuEntry[] = [
      { kind: "item", icon: <Scissors size={13} />, label: t("editor.menu.cut"),
        shortcut: sc("Mod", "X"), disabled: !sel, action: () => void taCut(el) },
      { kind: "item", icon: <Copy size={13} />, label: t("editor.menu.copy"),
        shortcut: sc("Mod", "C"), disabled: !sel, action: () => void taCopy(el) },
      { kind: "item", icon: <ClipboardPaste size={13} />, label: t("editor.menu.paste"),
        shortcut: sc("Mod", "V"), action: () => void taPaste(el) },
      { kind: "item", icon: <TextSelect size={13} />, label: t("editor.menu.selectAll"),
        shortcut: sc("Mod", "A"), action: () => taSelectAll(el) },
    ];
    if (!format) return clipboard;
    return [
      ...clipboard,
      { kind: "divider" },
      { kind: "item", icon: <Bold size={13} />, label: t("editor.menu.bold"),
        shortcut: sc("Mod", "B"), action: () => taBold(el) },
      { kind: "item", icon: <Italic size={13} />, label: t("editor.menu.italic"),
        shortcut: sc("Mod", "I"), action: () => taItalic(el) },
      { kind: "item", icon: <Strikethrough size={13} />, label: t("editor.menu.strikethrough"),
        shortcut: sc("Mod", "Shift", "X"), action: () => taStrikethrough(el) },
      { kind: "item", icon: <Code size={13} />, label: t("editor.menu.code"),
        shortcut: sc("Mod", "E"), action: () => taInlineCode(el) },
      { kind: "item", icon: <LinkIcon size={13} />, label: t("editor.menu.link"),
        shortcut: sc("Mod", "Shift", "K"), action: () => taLink(el) },
      { kind: "divider" },
      { kind: "item", icon: <Heading1 size={13} />, label: t("editor.menu.heading1"),
        shortcut: sc("Mod", "Alt", "1"), action: () => taHeading(el, 1) },
      { kind: "item", icon: <Heading2 size={13} />, label: t("editor.menu.heading2"),
        shortcut: sc("Mod", "Alt", "2"), action: () => taHeading(el, 2) },
      { kind: "item", icon: <Heading3 size={13} />, label: t("editor.menu.heading3"),
        shortcut: sc("Mod", "Alt", "3"), action: () => taHeading(el, 3) },
      { kind: "item", icon: <Quote size={13} />, label: t("editor.menu.quote"),
        shortcut: sc("Mod", "Shift", "."), action: () => taQuote(el) },
      { kind: "item", icon: <List size={13} />, label: t("editor.menu.bulletList"),
        shortcut: sc("Mod", "Shift", "8"), action: () => taBulletList(el) },
    ];
  };

  return (
    <>
      <textarea
        {...rest}
        ref={setRefs}
        onKeyDown={(e) => {
          if (format) handleTextareaShortcut(e, innerRef.current);
          onKeyDown?.(e);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          innerRef.current?.focus();
          setMenu({ x: e.clientX, y: e.clientY });
          onContextMenu?.(e);
        }}
      />
      {menu && innerRef.current && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildItems(innerRef.current)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
});
