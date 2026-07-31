/**
 * Pure logic for turning "the text currently selected somewhere in the app"
 * into a committed AI-task selection. Shared by the InlineAiBubble UI and the
 * global Mod+Shift+E/L/M dispatcher (useGlobalShortcuts) — split out so
 * neither has to import the other.
 */
import { useEditorStore } from "../../stores/editorStore";
import type { SelectionRange } from "../../stores/aiTaskStore";
import { clearTarget } from "./aiTarget";

/** True when the node lives inside an AI surface (the drawer or the inline
 *  bubble), so selecting text there shouldn't re-trigger the toolbar/shortcut. */
export function insideAiSurface(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return !!el?.closest("[data-ai-surface]");
}

/** True only for selections inside surfaces that support selection AI tasks
 *  (the manuscript CodeMirror editor and the preview pane, tagged
 *  `data-ai-selection`). Selections elsewhere — lore edit textareas, settings
 *  inputs, etc. — must not trigger a selection AI action: textarea selections
 *  don't even produce a DOM range, so a bubble anchored to one would render at
 *  the viewport origin, and a shortcut firing there would act on the wrong text. */
export function insideSelectableSurface(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return !!el?.closest("[data-ai-selection]");
}

/**
 * Drop any explicitly marked range before committing a dragged one.
 *
 * Both write the same target slot and the last action wins, but the marker
 * also paints the document — left behind, it would highlight one passage
 * while the assistant works on another. Clearing runs first so the marker's
 * own store sync (which fires inside the dispatch) can't wipe the commit that
 * follows.
 */
export function dropEditorMarker(): void {
  const view = useEditorStore.getState().editorView;
  if (view) clearTarget(view);
}

/** Resolve precise source offsets for the current selection, if it lives in
 *  the focused CodeMirror editor. Falls back to the rendered-text selection
 *  (no offsets) otherwise. */
export function resolveCommit(liveText: string): { text: string; range: SelectionRange | null } {
  const view = useEditorStore.getState().editorView;
  if (view && view.hasFocus) {
    const sel = view.state.selection.main;
    if (!sel.empty) {
      return { text: view.state.sliceDoc(sel.from, sel.to), range: { from: sel.from, to: sel.to } };
    }
  }
  return { text: liveText, range: null };
}
