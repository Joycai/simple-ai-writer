import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Bold,
  ChevronDown,
  Code,
  Heading,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table,
  Undo2,
} from "lucide-react";
import { redo, undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import { IS_MAC } from "../../lib/platform";
import {
  insertHorizontalRule,
  insertLink,
  insertTable,
  toggleBold,
  toggleBulletList,
  toggleCodeBlock,
  toggleHeading,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleQuote,
  toggleStrikethrough,
  toggleTaskList,
} from "../../lib/editor/format";
import styles from "./EditorToolbar.module.css";

/** Render a shortcut hint using the platform's modifier glyphs. */
function sc(...keys: string[]): string {
  if (IS_MAC) {
    return keys
      .map((k) => (k === "Mod" ? "⌘" : k === "Shift" ? "⇧" : k === "Alt" ? "⌥" : k))
      .join("");
  }
  return keys.map((k) => (k === "Mod" ? "Ctrl" : k)).join("+");
}

/** Heading levels the dropdown offers. 4–6 exist in markdown but never in a
 *  manuscript; offering them would push 正文 (the way *back*) off the top. */
const HEADING_LEVELS = [1, 2, 3, 4] as const;

interface Props {
  /** The live editor. Null for the frame before CodeMirror has built its view. */
  view: EditorView | null;
  /** Pick a picture off disk. Absent for a document with no path to file it beside. */
  onInsertImage?: () => void;
}

/**
 * The markdown editor's formatting strip.
 *
 * Every action here already existed as a keyboard shortcut or a right-click
 * entry — the bar is the *discoverable* face of the same commands, which is
 * why it stays icon-only and quiet: it sits above a manuscript, not above a
 * word processor. Nothing in it is stateful (no "bold is currently on"
 * highlight), because reflecting the caret's formatting means a store write
 * per keystroke, and the one place state genuinely helps — which heading level
 * this line is — is read on demand when the dropdown opens.
 */
export function EditorToolbar({ view, onInsertImage }: Props) {
  const { t, i18n } = useTranslation();
  /** Anchor rect of the heading dropdown, or null when it's closed. */
  const [headingAt, setHeadingAt] = useState<{ x: number; y: number } | null>(null);

  const run = (fn: (v: EditorView) => unknown) => () => {
    if (view) fn(view);
  };

  /** The heading level of the line the caret sits on, or 0 for body text. */
  const currentHeading = (): number => {
    if (!view) return 0;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    return /^(#{1,6}) /.exec(line.text)?.[1].length ?? 0;
  };

  const headingItems = (): ContextMenuEntry[] => {
    const level = currentHeading();
    const mark = (on: boolean) => (on ? "✓" : undefined);
    return [
      {
        kind: "item",
        icon: <Pilcrow size={13} />,
        label: t("editor.toolbar.paragraph"),
        shortcut: mark(level === 0),
        // Clearing = re-toggling the level that is already on, which is what
        // toggleHeading does with a level the line already carries.
        action: () => { if (view && level) toggleHeading(view, level); },
      },
      ...HEADING_LEVELS.map((n): ContextMenuEntry => ({
        kind: "item",
        icon: <span className={styles.hIcon}>H{n}</span>,
        label: t(`editor.menu.heading${n}`, { defaultValue: `H${n}` }),
        shortcut: mark(level === n),
        action: () => { if (view) toggleHeading(view, n); },
      })),
    ];
  };

  const btn = (
    key: string,
    icon: ReactNode,
    label: string,
    action: () => void,
    hint?: string,
  ) => (
    <button
      key={key}
      type="button"
      className={styles.btn}
      // The editor must keep the caret: a toolbar button that steals focus
      // would collapse the selection it is about to format.
      onMouseDown={(e) => e.preventDefault()}
      onClick={action}
      disabled={!view}
      title={hint ? `${label} · ${hint}` : label}
      aria-label={label}
    >
      {icon}
    </button>
  );

  const sep = (key: string) => <span key={key} className={styles.sep} aria-hidden />;

  // 列 / Column — the header labels a fresh table gets. Read here rather than
  // inside insertTable because the lib layer has no i18n.
  const tableHeader = i18n.language === "zh-CN" ? "列" : "Column";

  return (
    <div className={styles.bar} role="toolbar" aria-label={t("editor.toolbar.label")}>
      {btn("undo", <Undo2 size={14} />, t("editor.toolbar.undo"), run(undo), sc("Mod", "Z"))}
      {btn("redo", <Redo2 size={14} />, t("editor.toolbar.redo"), run(redo), sc("Mod", "Shift", "Z"))}
      {sep("s1")}

      <button
        type="button"
        className={`${styles.btn} ${styles.btnWide}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHeadingAt({ x: r.left, y: r.bottom + 4 });
        }}
        disabled={!view}
        title={t("editor.toolbar.heading")}
        aria-label={t("editor.toolbar.heading")}
      >
        <Heading size={14} />
        <ChevronDown size={10} className={styles.caret} />
      </button>
      {sep("s2")}

      {btn("bold", <Bold size={14} />, t("editor.menu.bold"), run(toggleBold), sc("Mod", "B"))}
      {btn("italic", <Italic size={14} />, t("editor.menu.italic"), run(toggleItalic), sc("Mod", "I"))}
      {btn("strike", <Strikethrough size={14} />, t("editor.menu.strikethrough"),
        run(toggleStrikethrough), sc("Mod", "Shift", "X"))}
      {btn("code", <Code size={14} />, t("editor.menu.code"), run(toggleInlineCode), sc("Mod", "E"))}
      {sep("s3")}

      {btn("ul", <List size={14} />, t("editor.menu.bulletList"),
        run(toggleBulletList), sc("Mod", "Shift", "8"))}
      {btn("ol", <ListOrdered size={14} />, t("editor.toolbar.orderedList"), run(toggleOrderedList))}
      {btn("task", <ListChecks size={14} />, t("editor.toolbar.taskList"), run(toggleTaskList))}
      {sep("s4")}

      {btn("quote", <Quote size={14} />, t("editor.menu.quote"), run(toggleQuote), sc("Mod", "Shift", "."))}
      {btn("codeblock", <SquareCode size={14} />, t("editor.toolbar.codeBlock"),
        run((v) => toggleCodeBlock(v)))}
      {btn("table", <Table size={14} />, t("editor.toolbar.table"),
        run((v) => insertTable(v, 3, 2, tableHeader)))}
      {btn("hr", <Minus size={14} />, t("editor.toolbar.horizontalRule"), run(insertHorizontalRule))}
      {sep("s5")}

      {btn("link", <LinkIcon size={14} />, t("editor.menu.link"), run(insertLink), sc("Mod", "Shift", "K"))}
      {onInsertImage &&
        btn("image", <ImageIcon size={14} />, t("editor.menu.insertImage"), onInsertImage)}

      {headingAt && (
        <ContextMenu
          x={headingAt.x}
          y={headingAt.y}
          items={headingItems()}
          onClose={() => setHeadingAt(null)}
        />
      )}
    </div>
  );
}
