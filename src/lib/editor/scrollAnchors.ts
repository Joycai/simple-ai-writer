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
import { lineAtOffset, offsetAtLine, type AnchorSource, type ScrollMapping } from "./scrollSync";

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
 * Anchor *elements* (and their parsed line spans — nothing that needs layout)
 * are cached until the debounced rebuild replaces them; their *positions* are
 * still measured fresh on every query, because image decodes, mermaid renders
 * and zoom changes all move blocks without any DOM swap — but lazily, through
 * an {@link AnchorSource}, so only the O(log n) blocks the binary search
 * probes pay a `getBoundingClientRect`. The eager version of this rebuilt the
 * whole anchor array inside the scroll handler: a 2000-paragraph chapter paid
 * ~2000 rect reads per scroll event for the ~11 that were consulted.
 * Measuring through rects also means the preview's CSS `zoom` needs no
 * special handling — rects and scrollTop live in the same, already-scaled
 * coordinate space.
 */
export function previewScrollMap(scroller: HTMLElement): ScrollMapping {
  /** The anchor elements with their line spans — the layout-free half. */
  let blocks: { el: HTMLElement; line: number; endLine: number }[] = [];
  /**
   * Identity of the rendered document's first block (scroller > page > first
   * child) at the last query. The debounced re-render swaps the page's
   * innerHTML, so this reference changes on every rebuild — and stays `null`
   * for an anchorless document, which is what the old `els.length === 0`
   * re-query condition got wrong: it walked the whole subtree with
   * `querySelectorAll` on every scroll event of such a document, forever.
   * `undefined` = never queried.
   */
  let lastProbe: Element | null | undefined;

  const refresh = () => {
    const probe = scroller.firstElementChild?.firstElementChild ?? null;
    const fresh =
      lastProbe !== undefined &&
      probe === lastProbe &&
      (blocks.length === 0 || blocks[0].el.isConnected);
    if (fresh) return;
    lastProbe = probe;
    blocks = [];
    for (const el of scroller.querySelectorAll<HTMLElement>("[data-line]")) {
      const line = Number(el.dataset.line);
      if (!Number.isFinite(line)) continue;
      const end = Number(el.dataset.lineEnd);
      blocks.push({
        el,
        line,
        endLine: Number.isFinite(end) && end > line ? end : line + 1,
      });
    }
  };

  /** One query's lazy view — measured against this instant's origin. */
  const source = (): AnchorSource | null => {
    refresh();
    if (blocks.length === 0) return null;
    // Content-space origin (where scrollTop 0 puts the viewport top), in
    // screen coordinates — subtracting it converts rects into offsets that
    // compare directly against scrollTop.
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
    return {
      length: blocks.length,
      at(i) {
        const b = blocks[i];
        const rect = b.el.getBoundingClientRect();
        return { line: b.line, endLine: b.endLine, top: rect.top - origin, bottom: rect.bottom - origin };
      },
    };
  };

  return {
    lineAtTop() {
      const s = source();
      return s ? lineAtOffset(s, scroller.scrollTop) : null;
    },
    scrollToLine(line) {
      const s = source();
      const y = s ? offsetAtLine(s, line) : null;
      if (y === null) return false;
      scroller.scrollTop = y;
      return true;
    },
  };
}
