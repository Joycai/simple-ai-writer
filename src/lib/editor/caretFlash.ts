/**
 * Caret-landing feedback: a fading band over the line the caret was just
 * moved to.
 *
 * `EditorScrollNav`'s "jump to end" silently relocates the caret and steals
 * focus, while its twin "jump to top" leaves the caret alone — two identical
 * buttons, two different contracts, and nothing on screen saying which just
 * happened. `highlightActiveLine` is tuned to 4% alpha so it does not nag
 * during writing, which also means it cannot catch the eye after a jump.
 *
 * A line decoration rather than `insertFlash`'s mark: the caret lands at
 * `doc.length`, and a document ending in a newline puts that on an EMPTY
 * line — a mark over a zero-width range paints nothing, while a line
 * decoration still gives the band its line-height.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

const setCaretFlash = StateEffect.define<number | null>();

/** How long the band stays before it is torn down. Matches insertFlash.ts. */
const FLASH_MS = 1600;

let pending: number | null = null;

function caretFlashField(className: string): StateField<DecorationSet> {
  const lineMark = Decoration.line({ class: className });
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      // Cleared on any edit rather than mapped forward: once the author types,
      // the cue has done its job and should get out of the way. Mapping would
      // also risk carrying a line decoration off a line start, which
      // CodeMirror rejects.
      if (tr.docChanged) deco = Decoration.none;
      for (const e of tr.effects) {
        if (e.is(setCaretFlash)) {
          deco = e.value === null
            ? Decoration.none
            : Decoration.set([lineMark.range(tr.state.doc.lineAt(e.value).from)]);
        }
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/**
 * Editor extension holding the landing band.
 *
 * @param className Class applied to the landing line. Passed in rather than
 *   hardcoded so the styling stays in the editor's own CSS module — the same
 *   reason `aiTargetExtension` takes one, and here also a correctness
 *   requirement: `.cm-activeLine` is styled from that module at a higher
 *   specificity than a `baseTheme` rule could reach.
 */
export function caretFlashExtension(className: string): Extension {
  return [caretFlashField(className)];
}

/** Paint the line containing `pos`, then tear it down. Does NOT scroll — the caller already did. */
export function flashCaretLanding(view: EditorView, pos: number): void {
  const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
  if (pending !== null) window.clearTimeout(pending);
  // 先摘掉再下一帧挂回：CSS 动画在类名已存在时不会重启，而「跳到结尾」总是
  // 落在同一行（doc.length），CodeMirror 复用同一个 .cm-line 节点——不清一次
  // 的话 1.6s 内的第二次跳转一帧都不闪，而这条色带是光标被搬走的唯一告知。
  view.dispatch({ effects: setCaretFlash.of(null) });
  window.requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    view.dispatch({ effects: setCaretFlash.of(clamped) });
  });
  pending = window.setTimeout(() => {
    pending = null;
    // The view may already be gone (file switch, project close) — check
    // before dispatching into a destroyed editor.
    if (view.dom.isConnected) view.dispatch({ effects: setCaretFlash.of(null) });
  }, FLASH_MS);
}
