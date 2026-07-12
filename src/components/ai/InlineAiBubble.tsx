import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Wand2, AlignLeft, Sparkles } from "lucide-react";
import { useAiTaskStore, type TaskKind, type SelectionRange } from "../../stores/aiTaskStore";
import { useEditorStore } from "../../stores/editorStore";
import { useAppStore } from "../../stores/appStore";
import { IS_MAC } from "../../lib/platform";
import styles from "./InlineAiBubble.module.css";

type ToolbarTask = Extract<TaskKind, "rewrite" | "polish" | "summary">;

/** Keyboard shortcut letter per action. Chosen to avoid browser-reserved
 *  Ctrl/Cmd+Shift combos (R=reload, J=downloads, etc.). */
const SHORTCUTS: { task: ToolbarTask; letter: string }[] = [
  { task: "rewrite", letter: "E" },
  { task: "polish",  letter: "L" },
  { task: "summary", letter: "M" },
];

const shortcutLabel = (letter: string) => (IS_MAC ? `⌘⇧${letter}` : `Ctrl+Shift+${letter}`);

interface LiveSelection {
  text: string;
  rect: { left: number; top: number; bottom: number; width: number };
}

/** Height budget used to decide whether the bubble fits above the selection. */
const BUBBLE_H = 150;

/** True when the node lives inside an AI surface (the drawer or this bubble),
 *  so selecting text there shouldn't re-trigger the toolbar. */
function insideAiSurface(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return !!el?.closest("[data-ai-surface]");
}

/** True only for selections inside surfaces that support selection AI tasks
 *  (the manuscript CodeMirror editor and the preview pane, tagged
 *  `data-ai-selection`). Selections elsewhere — lore edit textareas, settings
 *  inputs, etc. — must not trigger the toolbar: textarea selections don't even
 *  produce a DOM range, so the bubble would render at the viewport origin. */
function insideSelectableSurface(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return !!el?.closest("[data-ai-selection]");
}

/** Resolve precise source offsets for the current selection, if it lives in the
 *  focused CodeMirror editor. Returns rendered-text fallback (no offsets) otherwise. */
function resolveCommit(liveText: string): { text: string; range: SelectionRange | null } {
  const view = useEditorStore.getState().editorView;
  if (view && view.hasFocus) {
    const sel = view.state.selection.main;
    if (!sel.empty) {
      return { text: view.state.sliceDoc(sel.from, sel.to), range: { from: sel.from, to: sel.to } };
    }
  }
  return { text: liveText, range: null };
}

export function InlineAiBubble() {
  const { t } = useTranslation();
  const setSelection = useAiTaskStore((s) => s.setSelection);
  const setRequestedTask = useAiTaskStore((s) => s.setRequestedTask);
  const setShowAiDrawer = useAppStore((s) => s.setShowAiDrawer);

  const [live, setLive] = useState<LiveSelection | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const lastTextRef = useRef("");

  // Track the live DOM selection (independent of the committed task selection).
  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      if (
        !text.trim() || !sel || sel.rangeCount === 0 ||
        insideAiSurface(sel.anchorNode) || !insideSelectableSurface(sel.anchorNode)
      ) {
        setLive(null);
        lastTextRef.current = "";
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setLive({ text, rect: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width } });
      if (text !== lastTextRef.current) {
        setDismissed(false);
        lastTextRef.current = text;
      }
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  // Dismiss on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDismissed(true); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Global action shortcuts — Mod+Shift+E/L/M run on the current selection even
  // when the toolbar is dismissed, as long as text is selected in the document.
  useEffect(() => {
    const map: Record<string, ToolbarTask> = { e: "rewrite", l: "polish", m: "summary" };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      const task = map[e.key.toLowerCase()];
      if (!task) return;
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      if (
        !text.trim() ||
        insideAiSurface(sel?.anchorNode ?? null) ||
        !insideSelectableSurface(sel?.anchorNode ?? null)
      ) return;
      e.preventDefault();
      const { text: committed, range } = resolveCommit(text);
      setSelection(committed, range);
      setRequestedTask(task);
      setShowAiDrawer(true, "generate");
      setDismissed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSelection, setRequestedTask, setShowAiDrawer]);

  if (!live || dismissed) return null;

  const { rect } = live;
  const left = Math.max(16, Math.min(window.innerWidth - 360 - 16, rect.left + rect.width / 2 - 180));
  const above = rect.top - 8 - BUBBLE_H;
  const top = above >= 16 ? above : rect.bottom + 8;
  const flipped = above < 16;

  const commit = (): { text: string; range: SelectionRange | null } => {
    const { text, range } = resolveCommit(live.text);
    setSelection(text, range);
    return { text, range };
  };

  const openWithTask = (task: ToolbarTask) => {
    commit();
    setRequestedTask(task);
    setShowAiDrawer(true, "generate");
    setDismissed(true);
  };

  const icons: Record<ToolbarTask, React.ReactNode> = {
    rewrite: <RefreshCw size={13} strokeWidth={1.6} />,
    polish: <Wand2 size={13} strokeWidth={1.6} />,
    summary: <AlignLeft size={13} strokeWidth={1.6} />,
  };
  const actions = SHORTCUTS.map(({ task, letter }) => ({
    id: task,
    icon: icons[task],
    label: t(`ai.tasks.${task}`),
    key: shortcutLabel(letter),
  }));

  return (
    <div
      className={styles.bubble}
      data-ai-surface
      style={{ left, top }}
      // Keep the document selection alive when clicking the toolbar (mousedown
      // would otherwise collapse it before the action reads it).
      onMouseDown={(e) => e.preventDefault()}
    >
      {!flipped && <div className={styles.pointer} />}
      <div className={styles.head}>
        <Sparkles size={13} color="var(--color-sienna)" strokeWidth={1.6} />
        <span className={styles.headLabel}>
          AI · {t("ai.panel.selectedChars", { count: live.text.length })}
        </span>
      </div>

      <div className={styles.grid}>
        {actions.map((a) => (
          <button key={a.id} className={styles.action} onClick={() => openWithTask(a.id)}>
            <span className={styles.actionIcon}>{a.icon}</span>
            <span className={styles.actionLabel}>{a.label}</span>
            <span className={styles.actionKey}>{a.key}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
