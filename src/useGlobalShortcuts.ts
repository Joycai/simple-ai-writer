/**
 * The app's one global keydown listener. Dispatches every "dispatch"-scope
 * entry in the shortcuts registry (src/lib/shortcuts.ts) — replaces what used
 * to be three separate window-level listeners (App.tsx, EditorArea.tsx,
 * InlineAiBubble.tsx), each with its own hand-rolled modifier check.
 */
import { useEffect } from "react";
import {
  comboNeedsIdleCaret,
  inTextEntry,
  matchesCombo,
  NAV_BACK_COMBOS,
  NAV_FORWARD_COMBOS,
  SCREEN_COMBOS,
  type Combo,
} from "./lib/shortcuts";
import { navBack, navForward } from "./stores/navStore";
import { screenNeedsProject, useAppStore } from "./stores/appStore";
import { useEditorStore } from "./stores/editorStore";
import { useProjectStore } from "./stores/projectStore";
import { useAiTaskStore, type TaskKind } from "./stores/aiTaskStore";
import { findTask } from "./lib/profile";
import { insideAiSurface, insideSelectableSurface, dropEditorMarker, resolveCommit } from "./lib/editor/aiSelection";

const AI_SHORTCUT_TASKS: Record<string, TaskKind> = { e: "rewrite", l: "polish", m: "summary" };

/** Any of an action's bindings, minus the ones a caret has first claim on. */
function matchesAny(e: KeyboardEvent, combos: Combo[]): boolean {
  return combos.some(
    (c) => matchesCombo(e, c) && !(comboNeedsIdleCaret(c) && inTextEntry(e.target)),
  );
}

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
      // ⌘P ＝ 打开面板并落到「文档」档（VS Code / IDEA 的「按文件名跳」）；面板已开着时
      // 直接切档。它从不像 ⌘K 那样 toggle：肌肉记忆里 ⌘P 是「去找文件」，不是「关掉」。
      if (matchesCombo(e, { mod: true, key: "p" })) {
        e.preventDefault();
        useAppStore.getState().openCommandPalette("files");
        return;
      }
      if (matchesCombo(e, { mod: true, key: "l" })) {
        e.preventDefault();
        if (showAiDrawer && aiDrawerMode === "chat") setShowAiDrawer(false);
        else setShowAiDrawer(true, "chat");
        return;
      }
      // ⌘J is the panel's own switch, not a tab's: it names no mode, so the
      // drawer comes back on whichever tab the author left it on — the same
      // thing the icon rail's and title bar's buttons already do. Dropping the
      // mode costs no reachability: ⌘L still lands on 对话 from any tab, and
      // the command palette opens 生成 (with the query as the selection) and
      // 一致性检查 by name.
      if (matchesCombo(e, { mod: true, key: "j" })) {
        e.preventDefault();
        setShowAiDrawer(!showAiDrawer);
        return;
      }
      if (matchesCombo(e, { key: "Escape" })) {
        setShowCommandPalette(false);
        setShowAiDrawer(false);
        return;
      }
      if (matchesCombo(e, { mod: true, key: "," })) {
        e.preventDefault();
        useAppStore.getState().openSettings();
        return;
      }
      // ⌘1‥⌘5 — the icon rail from the keyboard. Ahead of the AI block and
      // free of any caret guard: a modifier+digit is not text input, so these
      // work with the cursor sitting in the manuscript.
      for (const { screen, combo } of SCREEN_COMBOS) {
        if (!matchesCombo(e, combo)) continue;
        e.preventDefault();
        // 知识库 / 文库 are a folder's data — before one is open there is
        // nothing behind ⌘3 and ⌘4, and the rail's own buttons are disabled
        // for the same reason (appStore.screenNeedsProject). Swallowed rather
        // than let through: the digit is still this listener's.
        if (screenNeedsProject(screen) && !useProjectStore.getState().projectPath) return;
        useAppStore.getState().showScreen(screen);
        return;
      }
      if (matchesCombo(e, { mod: true, key: "s" })) {
        e.preventDefault();
        useEditorStore.getState().saveNow();
        return;
      }
      if (matchesAny(e, NAV_BACK_COMBOS)) {
        e.preventDefault();
        navBack();
        return;
      }
      if (matchesAny(e, NAV_FORWARD_COMBOS)) {
        e.preventDefault();
        navForward();
        return;
      }

      for (const [letter, task] of Object.entries(AI_SHORTCUT_TASKS)) {
        if (!matchesCombo(e, { mod: true, shift: true, key: letter })) continue;
        // A task this project's profile doesn't offer.
        if (!findTask(task)) return;
        // A run already in flight — same protection as InlineAiBubble's
        // disabled buttons: triggering another task here would set
        // requestedTask while isRunning, and the point of that guard (see
        // AiPanel's requestedTask effect) is to queue the request rather
        // than let this shortcut silently interrupt the live run.
        if (useAiTaskStore.getState().isRunning) return;
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
