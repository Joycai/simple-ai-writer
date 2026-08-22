/**
 * "Insert to document" landing feedback: a fading highlight over the span
 * that was just written.
 *
 * `handleApply` in AiPanel is a hard, silent cut — generated text lands in
 * CodeMirror with no visual trace, and the replaceRange branch overwrites the
 * author's own prose with nothing marking what changed. This paints the
 * landed span with the same "something was pointed out here" wash lore
 * mentions use, then lets it fade — structured like `aiTarget.ts`
 * (StateEffect + StateField + `Decoration.mark`).
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

const setFlash = StateEffect.define<{ from: number; to: number } | null>();

const flashMark = Decoration.mark({ class: "cm-insert-flash" });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        deco = e.value
          ? Decoration.set([flashMark.range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// The fade is a CSS animation: the mark's class plays it once on mount and
// holds transparent when it ends; the dispatch 1.6s later just removes the
// decoration itself (the animation would otherwise have nothing left to
// clean up on the next insert).
const flashTheme = EditorView.baseTheme({
  "@keyframes cm-insert-flash-fade": {
    from: { backgroundColor: "var(--color-mention-bg)" },
    to: { backgroundColor: "transparent" },
  },
  ".cm-insert-flash": {
    animation: "cm-insert-flash-fade 1.6s var(--ease-out) forwards",
  },
});

export const insertFlashExtension: Extension = [flashField, flashTheme];

/** Highlight [from, to) and scroll to the landing spot. Range is clamped to the current document length. */
export function flashInserted(view: EditorView, from: number, to: number): void {
  const len = view.state.doc.length;
  const f = Math.max(0, Math.min(from, len));
  const t = Math.max(f, Math.min(to, len));
  if (t === f) return;
  view.dispatch({
    effects: [setFlash.of({ from: f, to: t }), EditorView.scrollIntoView(f, { y: "center" })],
  });
  window.setTimeout(() => {
    // The view may already be gone (file switch, project close) — check
    // before dispatching into a destroyed editor.
    if (view.dom.isConnected) view.dispatch({ effects: setFlash.of(null) });
  }, 1600);
}
