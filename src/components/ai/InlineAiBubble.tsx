import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Wand2, AlignLeft, Sparkles } from "lucide-react";
import { useAiTaskStore, type SelectionRange } from "../../stores/aiTaskStore";
import { findTask, taskLabel } from "../../lib/profile";
import { insideAiSurface, insideSelectableSurface, dropEditorMarker, resolveCommit } from "../../lib/editor/aiSelection";
import { useAppStore } from "../../stores/appStore";
import { comboLabel } from "../../lib/shortcuts";
import styles from "./InlineAiBubble.module.css";

/**
 * The quick actions the floating toolbar can offer.
 *
 * A deliberately curated subset rather than the active profile's whole task
 * list: each one is bound to a keyboard shortcut, and the bubble has room for
 * three. Ids the profile doesn't define are filtered out below, so a profile
 * without 润色 doesn't advertise a shortcut that can't run.
 */
type ToolbarTask = "rewrite" | "polish" | "summary";

/** Keyboard shortcut letter per action. Chosen to avoid browser-reserved
 *  Ctrl/Cmd+Shift combos (R=reload, J=downloads, etc.). */
const SHORTCUTS: { task: ToolbarTask; letter: string }[] = [
  { task: "rewrite", letter: "E" },
  { task: "polish",  letter: "L" },
  { task: "summary", letter: "M" },
];

const shortcutLabel = (letter: string) => comboLabel({ mod: true, shift: true, key: letter });

interface LiveSelection {
  text: string;
  rect: { left: number; top: number; bottom: number; width: number };
}

/** Height budget used to decide whether the bubble fits above the selection. */
const BUBBLE_H = 150;

export function InlineAiBubble() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
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

  if (!live || dismissed) return null;

  const { rect } = live;
  const left = Math.max(16, Math.min(window.innerWidth - 360 - 16, rect.left + rect.width / 2 - 180));
  const above = rect.top - 8 - BUBBLE_H;
  const top = above >= 16 ? above : rect.bottom + 8;
  const flipped = above < 16;

  const commit = (): { text: string; range: SelectionRange | null } => {
    const { text, range } = resolveCommit(live.text);
    dropEditorMarker();
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
  const actions = SHORTCUTS.flatMap(({ task, letter }) => {
    const def = findTask(task);
    if (!def) return [];
    return [{
      id: task,
      icon: icons[task],
      // The profile's own wording for the task, not a hardcoded i18n key.
      label: taskLabel(def, isZh, t),
      key: shortcutLabel(letter),
    }];
  });

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
