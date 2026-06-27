import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight, Wand2, RefreshCw, MessageCircleQuestion, BookmarkPlus,
  CheckCircle2, Sparkles, Send,
} from "lucide-react";
import { useAiTaskStore, type TaskKind } from "../../stores/aiTaskStore";
import { useAppStore } from "../../stores/appStore";
import styles from "./InlineAiBubble.module.css";

interface Action {
  id: TaskKind | "ask" | "extract" | "check";
  icon: React.ReactNode;
  label: string;
  key?: string;
}

export function InlineAiBubble() {
  const { t } = useTranslation();
  const { selection, runTask } = useAiTaskStore();
  const setShowAiDrawer = useAppStore((s) => s.setShowAiDrawer);

  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const lastSelectionRef = useRef<string>("");

  // Reset dismissal whenever the selection changes to something new
  useEffect(() => {
    if (selection && selection !== lastSelectionRef.current) {
      setDismissed(false);
      lastSelectionRef.current = selection;
      // Position the bubble near the selection
      const range = window.getSelection()?.getRangeAt(0);
      if (range) {
        const rect = range.getBoundingClientRect();
        // Anchor above selection, with pointer pointing down to it
        const left = Math.max(16, Math.min(window.innerWidth - 360 - 16, rect.left + rect.width / 2 - 60));
        const top = Math.max(16, rect.top - 8 - 280);
        setPos({ left, top });
      }
    }
    if (!selection) {
      setDismissed(false);
      setPos(null);
    }
  }, [selection]);

  // Dismiss on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!selection || dismissed || !pos) return null;

  const actions: Action[] = [
    { id: "continue", icon: <ArrowRight size={13} strokeWidth={1.6} />, label: t("ai.tasks.continue"), key: "⌘ J" },
    { id: "polish",   icon: <Wand2 size={13} strokeWidth={1.6} />,      label: t("ai.tasks.polish"),   key: "⌘ L" },
    { id: "rewrite",  icon: <RefreshCw size={13} strokeWidth={1.6} />,  label: t("ai.tasks.rewrite"),  key: "⌘ R" },
    { id: "ask",      icon: <MessageCircleQuestion size={13} strokeWidth={1.6} />, label: t("ai.inline.ask", { defaultValue: "问 AI" }), key: "⌘ /" },
    { id: "extract",  icon: <BookmarkPlus size={13} strokeWidth={1.6} />, label: t("ai.inline.extract", { defaultValue: "提取为设定" }) },
    { id: "check",    icon: <CheckCircle2 size={13} strokeWidth={1.6} />, label: t("ai.inline.check", { defaultValue: "核对一致性" }) },
  ];

  const handleAction = (id: Action["id"]) => {
    if (id === "check") {
      setShowAiDrawer(true, "consistency");
      setDismissed(true);
      return;
    }
    if (id === "extract") {
      // Future hook — for now open generator drawer
      setShowAiDrawer(true, "generate");
      setDismissed(true);
      return;
    }
    if (id === "ask") {
      setShowAiDrawer(true, "generate");
      setDismissed(true);
      return;
    }
    // Direct task
    runTask(id as TaskKind);
    setShowAiDrawer(true, "generate");
    setDismissed(true);
  };

  const handlePromptSubmit = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && prompt.trim()) {
      runTask("custom", prompt.trim());
      setShowAiDrawer(true, "generate");
      setDismissed(true);
    }
  };

  return (
    <div className={styles.bubble} style={{ left: pos.left, top: pos.top }}>
      <div className={styles.pointer} />
      <div className={styles.head}>
        <Sparkles size={13} color="var(--color-sienna)" strokeWidth={1.6} />
        <span className={styles.headLabel}>
          AI · {t("ai.panel.selectedChars", { count: selection.length })}
        </span>
        <span className={styles.headHint}>⌘ K · {t("ai.inline.drawer", { defaultValue: "抽屉" })}</span>
      </div>

      <div className={styles.grid}>
        {actions.map((a) => (
          <button key={a.id} className={styles.action} onClick={() => handleAction(a.id)}>
            <span className={styles.actionIcon}>{a.icon}</span>
            <span className={styles.actionLabel}>{a.label}</span>
            {a.key && <span className={styles.actionKey}>{a.key}</span>}
          </button>
        ))}
      </div>

      <div className={styles.prompt}>
        <div className={styles.promptInputWrap}>
          <Send size={11} color="var(--color-sienna)" strokeWidth={1.6} />
          <input
            className={styles.promptInput}
            placeholder={t("ai.inline.customPlaceholder", { defaultValue: "自定义指令…" })}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handlePromptSubmit}
          />
          <span className={styles.promptKey}>⏎</span>
        </div>
      </div>
    </div>
  );
}
