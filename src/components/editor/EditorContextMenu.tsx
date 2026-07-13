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
import { selectAll } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import { IS_MAC } from "../../lib/platform";
import {
  hasSelection,
  copySelection,
  cutSelection,
  pasteClipboard,
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleInlineCode,
  toggleHeading,
  toggleQuote,
  toggleBulletList,
  insertLink,
} from "../../lib/editor/format";

/** Render a shortcut hint using the platform's modifier glyphs. */
function sc(...keys: string[]): string {
  if (IS_MAC) {
    return keys
      .map((k) => (k === "Mod" ? "⌘" : k === "Shift" ? "⇧" : k === "Alt" ? "⌥" : k))
      .join("");
  }
  return keys.map((k) => (k === "Mod" ? "Ctrl" : k)).join("+");
}

/**
 * The markdown editor's right-click menu — clipboard actions on top, markdown
 * formatting below, mirroring the keyboard shortcuts. Reuses the shared
 * `ContextMenu` so it matches the FileTree / Lore menus.
 */
export function EditorContextMenu({
  x, y, view, onClose,
}: {
  x: number;
  y: number;
  view: EditorView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const sel = hasSelection(view);

  const items: ContextMenuEntry[] = [
    { kind: "item", icon: <Scissors size={13} />, label: t("editor.menu.cut"),
      shortcut: sc("Mod", "X"), disabled: !sel, action: () => void cutSelection(view) },
    { kind: "item", icon: <Copy size={13} />, label: t("editor.menu.copy"),
      shortcut: sc("Mod", "C"), disabled: !sel, action: () => void copySelection(view) },
    { kind: "item", icon: <ClipboardPaste size={13} />, label: t("editor.menu.paste"),
      shortcut: sc("Mod", "V"), action: () => void pasteClipboard(view) },
    { kind: "item", icon: <TextSelect size={13} />, label: t("editor.menu.selectAll"),
      shortcut: sc("Mod", "A"), action: () => { selectAll(view); view.focus(); } },
    { kind: "divider" },
    { kind: "item", icon: <Bold size={13} />, label: t("editor.menu.bold"),
      shortcut: sc("Mod", "B"), action: () => toggleBold(view) },
    { kind: "item", icon: <Italic size={13} />, label: t("editor.menu.italic"),
      shortcut: sc("Mod", "I"), action: () => toggleItalic(view) },
    { kind: "item", icon: <Strikethrough size={13} />, label: t("editor.menu.strikethrough"),
      shortcut: sc("Mod", "Shift", "X"), action: () => toggleStrikethrough(view) },
    { kind: "item", icon: <Code size={13} />, label: t("editor.menu.code"),
      shortcut: sc("Mod", "E"), action: () => toggleInlineCode(view) },
    { kind: "item", icon: <LinkIcon size={13} />, label: t("editor.menu.link"),
      shortcut: sc("Mod", "Shift", "K"), action: () => insertLink(view) },
    { kind: "divider" },
    { kind: "item", icon: <Heading1 size={13} />, label: t("editor.menu.heading1"),
      shortcut: sc("Mod", "Alt", "1"), action: () => toggleHeading(view, 1) },
    { kind: "item", icon: <Heading2 size={13} />, label: t("editor.menu.heading2"),
      shortcut: sc("Mod", "Alt", "2"), action: () => toggleHeading(view, 2) },
    { kind: "item", icon: <Heading3 size={13} />, label: t("editor.menu.heading3"),
      shortcut: sc("Mod", "Alt", "3"), action: () => toggleHeading(view, 3) },
    { kind: "item", icon: <Quote size={13} />, label: t("editor.menu.quote"),
      shortcut: sc("Mod", "Shift", "."), action: () => toggleQuote(view) },
    { kind: "item", icon: <List size={13} />, label: t("editor.menu.bulletList"),
      shortcut: sc("Mod", "Shift", "8"), action: () => toggleBulletList(view) },
  ];

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
