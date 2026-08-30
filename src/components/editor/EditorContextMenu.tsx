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
  Pilcrow,
  ImagePlus,
  Image as ImageIcon,
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
  tidyParagraphs,
} from "../../lib/editor/format";
import { normalizeParagraphs } from "../../lib/format/paragraphs";

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
  x, y, view, onClose, onIllustrate, onInsertImage,
}: {
  x: number;
  y: number;
  view: EditorView;
  onClose: () => void;
  /** Open the illustration flow. Absent when no image model is configured. */
  onIllustrate?: () => void;
  /** Pick a picture off disk. Absent for a document with no path to file it beside. */
  onInsertImage?: () => void;
}) {
  const { t } = useTranslation();
  const sel = hasSelection(view);
  // Counted here rather than after the fact: the menu is built on right-click,
  // so one pass over the document buys a label that says what the command would
  // do. Scoped like the command itself — the selection when there is one.
  const range = view.state.selection.main;
  const scope = range.empty
    ? view.state.doc.toString()
    : view.state.sliceDoc(
        view.state.doc.lineAt(range.from).from,
        view.state.doc.lineAt(range.to).to,
      );
  const counts = normalizeParagraphs(scope);
  const tidy = { total: counts.separated + counts.collapsed + counts.trimmed };

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
    // These sit with insertLink rather than the formatting block below: all
    // three put something new at the cursor instead of restyling what is
    // already there. 插入图片 comes first — bringing a picture you already have
    // is the ordinary case, and drawing a new one is the special one.
    ...(onInsertImage
      ? [{ kind: "item" as const, icon: <ImageIcon size={13} />, label: t("editor.menu.insertImage"),
           action: onInsertImage }]
      : []),
    ...(onIllustrate
      ? [{ kind: "item" as const, icon: <ImagePlus size={13} />, label: t("editor.menu.illustrate"),
           action: onIllustrate }]
      : []),
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
    { kind: "divider" },
    // The only entry here that rewrites the whole document rather than the
    // caret's surroundings, so it is the only one that says in advance how much
    // it will change — and greys itself out when the answer is nothing. That
    // ordering (know, then commit) is the same one the approval cards keep, and
    // it is what makes a document-wide edit reasonable to offer from a menu.
    {
      kind: "item",
      icon: <Pilcrow size={13} />,
      label: tidy.total
        ? t("editor.menu.tidyParagraphsN", { n: tidy.total })
        : t("editor.menu.tidyParagraphs"),
      disabled: tidy.total === 0,
      action: () => { tidyParagraphs(view); },
    },
  ];

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
