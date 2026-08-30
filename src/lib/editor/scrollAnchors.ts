/**
 * The two concrete `ScrollMapping`s the split view links (see scrollSync.ts):
 * the CodeMirror side reads line geometry off the view, the preview side reads
 * it off the `data-line` anchors renderMarkdown stamps in split view.
 *
 * Everything here is measurement plumbing over real layout, which is exactly
 * what jsdom can't exercise — the interpolation math these feed lives as pure
 * functions in scrollSync.ts, where it is tested.
 */
import type { EditorView } from "@codemirror/view";
import { lineAtOffset, offsetAtLine, type LineAnchor, type ScrollMapping } from "./scrollSync";

/**
 * Line mapping for the editor pane, backed by CodeMirror's block geometry.
 *
 * Positions are taken in *document space* (the space `lineBlockAtHeight` and
 * `block.top` share), reached from screen coordinates via `view.documentTop`
 * rather than from `scrollTop` arithmetic — that way the scroller's own
 * padding never enters the math. Heights for unmeasured lines are CodeMirror's
 * estimates, which is still per-line truth the whole-pane `scrollHeight` ratio
 * never had.
 */
export function editorScrollMap(view: EditorView): ScrollMapping {
  /** The viewport top's position in document space. */
  const viewportTop = () => view.scrollDOM.getBoundingClientRect().top - view.documentTop;
  return {
    lineAtTop() {
      const y = viewportTop();
      const block = view.lineBlockAtHeight(y);
      const line = view.state.doc.lineAt(block.from).number - 1;
      if (block.height <= 0) return line;
      const frac = Math.min(Math.max((y - block.top) / block.height, 0), 1);
      return line + frac;
    },
    scrollToLine(line) {
      const doc = view.state.doc;
      const clamped = Math.min(Math.max(line, 0), doc.lines - 1);
      const n = Math.floor(clamped);
      const block = view.lineBlockAt(doc.line(n + 1).from);
      const target = block.top + (clamped - n) * block.height;
      view.scrollDOM.scrollTop += target - viewportTop();
      return true;
    },
  };
}

/**
 * Line mapping for the preview pane, backed by the `data-line` /
 * `data-line-end` attributes on its top-level blocks.
 *
 * Anchor *elements* are cached until the debounced rebuild replaces them
 * (checked by `isConnected`); their *positions* are measured fresh on every
 * call, because image decodes, mermaid renders and zoom changes all move
 * blocks without any DOM swap. Measuring through rects also means the
 * preview's CSS `zoom` needs no special handling — rects and scrollTop live in
 * the same, already-scaled coordinate space.
 */
export function previewScrollMap(scroller: HTMLElement): ScrollMapping {
  let els: HTMLElement[] = [];
  const anchors = (): LineAnchor[] => {
    if (els.length === 0 || !els[0].isConnected) {
      els = [...scroller.querySelectorAll<HTMLElement>("[data-line]")];
    }
    // Content-space origin (where scrollTop 0 puts the viewport top), in
    // screen coordinates — subtracting it converts rects into offsets that
    // compare directly against scrollTop.
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const out: LineAnchor[] = [];
    for (const el of els) {
      const line = Number(el.dataset.line);
      if (!Number.isFinite(line)) continue;
      const end = Number(el.dataset.lineEnd);
      const rect = el.getBoundingClientRect();
      out.push({
        line,
        endLine: Number.isFinite(end) && end > line ? end : line + 1,
        top: rect.top - origin,
        bottom: rect.bottom - origin,
      });
    }
    return out;
  };
  return {
    lineAtTop() {
      return lineAtOffset(anchors(), scroller.scrollTop);
    },
    scrollToLine(line) {
      const y = offsetAtLine(anchors(), line);
      if (y === null) return false;
      scroller.scrollTop = y;
      return true;
    },
  };
}
