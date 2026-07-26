/**
 * The AI target range — the passage AI tasks act on, marked explicitly.
 *
 * Dragging a selection is fine for a short passage you act on immediately, but
 * it cannot survive what writers actually do: click into the AI panel, scroll a
 * page, keep typing. A DOM selection dies on the first click elsewhere, and a
 * plain pair of offsets rots the moment anything above it is edited — which is
 * why every consumer of the old selection had to re-verify it by slicing the
 * document and fall back to searching for the text.
 *
 * Marking start and end explicitly puts the range in editor state instead,
 * where CodeMirror maps it through every change. It stays exact across
 * arbitrary edits, including edits inside the range itself, so consumers can
 * trust the offsets rather than re-derive them.
 *
 * A range is only usable once both ends are marked; `to: null` is the
 * half-marked state, which the UI surfaces rather than silently guessing at.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/** A marked range. `to` is null while only the start has been placed. */
export interface AiTargetRange {
  from: number;
  to: number | null;
}

export const setAiTargetStart = StateEffect.define<number>();
export const setAiTargetEnd = StateEffect.define<number>();
export const clearAiTarget = StateEffect.define<null>();

/**
 * Where the marked range lives. Null when nothing is marked.
 *
 * Marking an end before the start swaps them rather than rejecting the action:
 * the author has named two boundaries, and which one they pointed at first is
 * not information worth an error message.
 */
export const aiTargetField = StateField.define<AiTargetRange | null>({
  create: () => null,
  update(value, tr) {
    // Map first, so an effect dispatched alongside a change wins over the
    // mapped-forward version of the range it is replacing.
    let next = value;
    if (next && tr.docChanged) {
      const from = tr.changes.mapPos(next.from, 1);
      const rawTo = next.to === null ? null : tr.changes.mapPos(next.to, -1);
      // Deleting the marked prose collapses the range; it must never invert.
      const to = rawTo === null ? null : Math.max(from, rawTo);
      // Identity is the signal consumers use to detect movement, so hold onto
      // the same object when an edit elsewhere left this range where it was.
      if (from !== next.from || to !== next.to) next = { from, to };
    }
    for (const effect of tr.effects) {
      if (effect.is(clearAiTarget)) {
        next = null;
      } else if (effect.is(setAiTargetStart)) {
        const to = next?.to ?? null;
        next = to !== null && to < effect.value
          ? { from: to, to: effect.value }
          : { from: effect.value, to };
      } else if (effect.is(setAiTargetEnd)) {
        const from = next?.from ?? null;
        next = from !== null && from > effect.value
          ? { from: effect.value, to: from }
          : { from: from ?? effect.value, to: effect.value };
      }
    }
    return next;
  },
});

/**
 * Paint the marked span. Deliberately NOT a fill: CodeMirror's own selection is
 * already a sienna wash, and a second fill would make "what I have selected
 * right now" and "what the AI will touch" indistinguishable.
 */
function targetDecorations(range: AiTargetRange | null, className: string): DecorationSet {
  if (!range || range.to === null || range.to <= range.from) return Decoration.none;
  return Decoration.set([Decoration.mark({ class: className }).range(range.from, range.to)]);
}

/**
 * Editor extension holding the target range and its highlight.
 *
 * @param className Class applied to the marked span. Passed in rather than
 *   hardcoded so the styling stays in the editor's own CSS module.
 */
export function aiTargetExtension(className: string): Extension {
  return [
    aiTargetField,
    EditorView.decorations.compute([aiTargetField], (state) =>
      targetDecorations(state.field(aiTargetField), className),
    ),
  ];
}

/** The marked range, only once both ends are placed. */
export function completeAiTarget(view: EditorView): { from: number; to: number } | null {
  const range = view.state.field(aiTargetField, false);
  if (!range || range.to === null || range.to <= range.from) return null;
  return { from: range.from, to: range.to };
}

/**
 * Mark the start of the target at the cursor.
 *
 * With text selected, the selection's own edge is used instead of the cursor —
 * having dragged over a passage, being made to also click at its edge would be
 * busywork.
 */
export function markTargetStart(view: EditorView): boolean {
  view.dispatch({ effects: setAiTargetStart.of(view.state.selection.main.from) });
  return true;
}

/** Mark the end of the target at the cursor (or the selection's trailing edge). */
export function markTargetEnd(view: EditorView): boolean {
  view.dispatch({ effects: setAiTargetEnd.of(view.state.selection.main.to) });
  return true;
}

/** Drop the marked range. */
export function clearTarget(view: EditorView): boolean {
  if (view.state.field(aiTargetField, false) == null) return false;
  view.dispatch({ effects: clearAiTarget.of(null) });
  return true;
}
