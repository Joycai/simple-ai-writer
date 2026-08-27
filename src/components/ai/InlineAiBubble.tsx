import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight, AlignLeft, BookmarkPlus, CircleCheck, MessageSquare, RefreshCw, Send, Sparkles, Wand2,
} from "lucide-react";
import { useAiTaskStore, type SelectionRange } from "../../stores/aiTaskStore";
import { useLoreStore } from "../../stores/loreStore";
import { findTask, taskLabel } from "../../lib/profile";
import { insideAiSurface, insideSelectableSurface, dropEditorMarker, resolveCommit } from "../../lib/editor/aiSelection";
import { useAppStore } from "../../stores/appStore";
import { comboLabel } from "../../lib/shortcuts";
import { MOD_KEY } from "../../lib/platform";
import { useImeGuard } from "../../lib/ime";
import styles from "./InlineAiBubble.module.css";

/**
 * Generation tasks the toolbar can start, in the order the design lays them
 * out. Each is filtered against the active profile, so a profile that doesn't
 * define 润色 doesn't advertise it — and `letter` is only set where the global
 * keymap actually binds one (see useGlobalShortcuts's AI_SHORTCUT_TASKS).
 */
type ToolbarTask = "continue" | "polish" | "rewrite" | "summary";

const TASK_ACTIONS: { task: ToolbarTask; letter?: string }[] = [
  { task: "continue" },
  { task: "polish",  letter: "L" },
  { task: "rewrite", letter: "E" },
  { task: "summary", letter: "M" },
];

const shortcutLabel = (letter: string) => comboLabel({ mod: true, shift: true, key: letter });

interface LiveSelection {
  text: string;
  rect: { left: number; top: number; bottom: number; width: number };
}

/** Height budget used to decide whether the bubble fits above the selection. */
const BUBBLE_H = 300;

export function InlineAiBubble() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const setSelection = useAiTaskStore((s) => s.setSelection);
  const setRequestedTask = useAiTaskStore((s) => s.setRequestedTask);
  const isRunning = useAiTaskStore((s) => s.isRunning);
  const setShowAiDrawer = useAppStore((s) => s.setShowAiDrawer);
  const setMainView = useAppStore((s) => s.setMainView);
  const requestExtract = useLoreStore((s) => s.requestExtract);

  const [live, setLive] = useState<LiveSelection | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [instruction, setInstruction] = useState("");
  const lastTextRef = useRef("");
  // Typing in the bubble's own instruction box moves focus into the bubble,
  // which collapses the document selection — and the listener below would read
  // that as "the author deselected" and close the toolbar out from under the
  // sentence they were mid-way through writing. While the box has focus, the
  // captured selection is held as-is; `resolveCommit` works from the stored
  // text, so the action still lands on the right passage.
  const editingRef = useRef(false);
  const ime = useImeGuard();

  // Track the live DOM selection (independent of the committed task selection).
  useEffect(() => {
    const onChange = () => {
      if (editingRef.current) return;
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
        // A different passage is a different question — an instruction typed
        // for the last one would silently apply to this one.
        setInstruction("");
        lastTextRef.current = text;
      }
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  // Close the toolbar and stop holding the selection open. Every exit goes
  // through here: leaving `editingRef` armed would make the listener above
  // ignore selections for the rest of the session.
  const dismiss = () => {
    editingRef.current = false;
    setDismissed(true);
  };

  // Dismiss on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      editingRef.current = false;
      setDismissed(true);
    };
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

  /** Hand the passage to the 生成 drawer, optionally with a typed brief. */
  const openWithTask = (task: string, brief?: string) => {
    if (isRunning) return; // buttons are disabled for this too — see below
    commit();
    setRequestedTask(task, brief);
    setShowAiDrawer(true, "generate");
    dismiss();
  };

  /** Hand it to a different surface instead — the drawer's other two tabs. */
  const openDrawer = (mode: "chat" | "consistency") => {
    commit();
    setShowAiDrawer(true, mode);
    dismiss();
  };

  const extractToLore = () => {
    const { text } = commit();
    requestExtract(text);
    setMainView("lore-wall");
    dismiss();
  };

  const icons: Record<ToolbarTask, React.ReactNode> = {
    continue: <ArrowRight size={13} strokeWidth={1.6} />,
    polish: <Wand2 size={13} strokeWidth={1.6} />,
    rewrite: <RefreshCw size={13} strokeWidth={1.6} />,
    summary: <AlignLeft size={13} strokeWidth={1.6} />,
  };
  const actions = TASK_ACTIONS.flatMap(({ task, letter }) => {
    const def = findTask(task);
    if (!def) return [];
    return [{
      id: task,
      icon: icons[task],
      // The profile's own wording for the task, not a hardcoded i18n key.
      label: taskLabel(def, isZh, t),
      key: letter ? shortcutLabel(letter) : "",
    }];
  });

  // The freeform task the 自定义指令 box runs. Resolved from the profile rather
  // than hardcoded to "custom": a profile renames and re-scopes its tasks, and
  // one that offers no freeform task simply doesn't get the box.
  const freeformTask = ["custom", "ask"].map(findTask).find((d) => d?.freeform) ?? null;

  const submitInstruction = () => {
    const brief = instruction.trim();
    if (!brief || !freeformTask) return;
    openWithTask(freeformTask.id, brief);
  };

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
        {/* Names the escape hatch: everything here is the short version, and
            the drawer is where the same passage gets the full controls. */}
        <span className={styles.headHint}>
          {MOD_KEY === "⌘" ? "⌘J" : "Ctrl J"} · {t("ai.bubble.drawer", { defaultValue: "抽屉" })}
        </span>
      </div>

      <div className={styles.grid}>
        {actions.map((a) => (
          <button
            key={a.id}
            className={styles.action}
            onClick={() => openWithTask(a.id)}
            disabled={isRunning}
            title={isRunning ? t("ai.panel.busyTitle") : undefined}
          >
            <span className={styles.actionIcon}>{a.icon}</span>
            <span className={styles.actionLabel}>{a.label}</span>
            <span className={styles.actionKey}>{a.key}</span>
          </button>
        ))}
      </div>

      {/* Second group: these don't generate anything here, they carry the
          passage to another surface. Separated so the two kinds of outcome
          aren't read as one list. */}
      <div className={`${styles.grid} ${styles.gridHandoff}`}>
        <button className={styles.action} onClick={() => openDrawer("chat")}>
          <span className={styles.actionIcon}><MessageSquare size={13} strokeWidth={1.6} /></span>
          <span className={styles.actionLabel}>{t("ai.bubble.ask", { defaultValue: "问 AI" })}</span>
          <span className={styles.actionKey}>{MOD_KEY === "⌘" ? "⌘L" : "Ctrl L"}</span>
        </button>
        <button className={styles.action} onClick={extractToLore}>
          <span className={styles.actionIcon}><BookmarkPlus size={13} strokeWidth={1.6} /></span>
          <span className={styles.actionLabel}>{t("ai.bubble.extractLore", { defaultValue: "提取为条目" })}</span>
        </button>
        <button className={styles.action} onClick={() => openDrawer("consistency")}>
          <span className={styles.actionIcon}><CircleCheck size={13} strokeWidth={1.6} /></span>
          <span className={styles.actionLabel}>{t("ai.bubble.checkConsistency", { defaultValue: "核对一致性" })}</span>
        </button>
      </div>

      {freeformTask && (
        <div className={styles.customRow}>
          <div className={styles.customField}>
            <Send size={11} strokeWidth={1.8} className={styles.customIcon} />
            <input
              className={styles.customInput}
              value={instruction}
              placeholder={t("ai.bubble.customPlaceholder", { defaultValue: "自定义指令…" })}
              disabled={isRunning}
              onChange={(e) => setInstruction(e.target.value)}
              // The bubble swallows mousedown to protect the selection; the
              // input needs it to place its own caret.
              onMouseDown={(e) => e.stopPropagation()}
              onFocus={() => { editingRef.current = true; }}
              onBlur={() => { editingRef.current = false; }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !ime.isComposing(e)) {
                  e.preventDefault();
                  submitInstruction();
                }
              }}
              {...ime.imeProps}
            />
            <span className={styles.customKbd}>⏎</span>
          </div>
        </div>
      )}
    </div>
  );
}
