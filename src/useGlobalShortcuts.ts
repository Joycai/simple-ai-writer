/**
 * The app's one global keydown listener. Dispatches every "dispatch"-scope
 * entry in the shortcuts registry (src/lib/shortcuts.ts) — replaces what used
 * to be three separate window-level listeners (App.tsx, EditorArea.tsx,
 * InlineAiBubble.tsx), each with its own hand-rolled modifier check.
 */
import { useEffect } from "react";
import { matchesCombo } from "./lib/shortcuts";
import { useAppStore } from "./stores/appStore";
import { useEditorStore } from "./stores/editorStore";
import { useAiTaskStore, type TaskKind } from "./stores/aiTaskStore";
import { findTask } from "./lib/profile";
import { insideAiSurface, insideSelectableSurface, dropEditorMarker, resolveCommit } from "./lib/editor/aiSelection";

const AI_SHORTCUT_TASKS: Record<string, TaskKind> = { e: "rewrite", l: "polish", m: "summary" };

export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { showCommandPalette, setShowCommandPalette, showAiDrawer, aiDrawerMode, setShowAiDrawer } =
        useAppStore.getState();

      if (matchesCombo(e, { mod: true, key: "k" })) {
        e.preventDefault();
        setShowCommandPalette(!showCommandPalette);
        return;
      }
      if (matchesCombo(e, { mod: true, key: "l" })) {
        e.preventDefault();
        if (showAiDrawer && aiDrawerMode === "chat") setShowAiDrawer(false);
        else setShowAiDrawer(true, "chat");
        return;
      }
      if (matchesCombo(e, { mod: true, key: "j" })) {
        e.preventDefault();
        if (showAiDrawer && aiDrawerMode === "generate") setShowAiDrawer(false);
        else setShowAiDrawer(true, "generate");
        return;
      }
      if (matchesCombo(e, { key: "Escape" })) {
        setShowCommandPalette(false);
        setShowAiDrawer(false);
        return;
      }
      if (matchesCombo(e, { mod: true, key: "s" })) {
        e.preventDefault();
        useEditorStore.getState().saveNow();
        return;
      }

      for (const [letter, task] of Object.entries(AI_SHORTCUT_TASKS)) {
        if (!matchesCombo(e, { mod: true, shift: true, key: letter })) continue;
        // A task this project's profile doesn't offer.
        if (!findTask(task)) return;
        const sel = window.getSelection();
        const text = sel?.toString() ?? "";
        if (
          !text.trim() ||
          insideAiSurface(sel?.anchorNode ?? null) ||
          !insideSelectableSurface(sel?.anchorNode ?? null)
        ) return;
        e.preventDefault();
        const { text: committed, range } = resolveCommit(text);
        dropEditorMarker();
        const { setSelection, setRequestedTask } = useAiTaskStore.getState();
        setSelection(committed, range);
        setRequestedTask(task);
        setShowAiDrawer(true, "generate");
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
