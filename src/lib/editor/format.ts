/**
 * Markdown formatting commands for the CodeMirror editor.
 *
 * Each command operates on the live `EditorView` and is safe to bind to a
 * keymap (returns `true` when it handled the key) or to call from the editor's
 * right-click menu. Inline wrappers toggle: applying bold to already-bold text
 * removes the markers again. Block commands (headings, quote, list) act on every
 * line the selection touches.
 */
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** Wrap (or unwrap) each selection range with an inline marker like `**`. */
export function toggleInlineWrap(view: EditorView, marker: string, end = marker): boolean {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const { from, to } = range;
    const before = state.sliceDoc(Math.max(0, from - marker.length), from);
    const after = state.sliceDoc(to, Math.min(state.doc.length, to + end.length));

    // Markers sit just outside the selection → strip them.
    if (before === marker && after === end) {
      return {
        changes: [
          { from: from - marker.length, to, insert: state.sliceDoc(from, to) },
          { from: to, to: to + end.length, insert: "" },
        ],
        range: EditorSelection.range(from - marker.length, to - marker.length),
      };
    }

    const selected = state.sliceDoc(from, to);
    // Markers are part of the selection itself → strip them.
    if (
      selected.length >= marker.length + end.length &&
      selected.startsWith(marker) &&
      selected.endsWith(end)
    ) {
      const inner = selected.slice(marker.length, selected.length - end.length);
      return {
        changes: { from, to, insert: inner },
        range: EditorSelection.range(from, from + inner.length),
      };
    }

    // Otherwise wrap. With an empty selection the cursor lands between markers.
    return {
      changes: { from, to, insert: marker + selected + end },
      range: EditorSelection.range(from + marker.length, to + marker.length),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
  view.focus();
  return true;
}

export const toggleBold = (view: EditorView) => toggleInlineWrap(view, "**");
export const toggleItalic = (view: EditorView) => toggleInlineWrap(view, "*");
export const toggleStrikethrough = (view: EditorView) => toggleInlineWrap(view, "~~");
export const toggleInlineCode = (view: EditorView) => toggleInlineWrap(view, "`");

/** Set the heading level of every touched line, or clear it if already at `level`. */
export function toggleHeading(view: EditorView, level: number): boolean {
  const { state } = view;
  const target = "#".repeat(level) + " ";
  const tr = state.changeByRange((range) => {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    const changes: { from: number; to: number; insert: string }[] = [];
    let headDelta = 0;
    let anchorDelta = 0;

    // Toggle off only when every line is already exactly `level`.
    const lines = [];
    for (let n = startLine.number; n <= endLine.number; n++) lines.push(state.doc.line(n));
    const allAtLevel = lines.every((l) => new RegExp(`^#{${level}} `).test(l.text));

    for (const line of lines) {
      const m = /^(#{1,6}) +/.exec(line.text);
      const insert = allAtLevel ? "" : target;
      const from = line.from;
      const to = line.from + (m ? m[0].length : 0);
      changes.push({ from, to, insert });
      const delta = insert.length - (to - from);
      if (line.from <= range.head) headDelta += delta;
      if (line.from <= range.anchor) anchorDelta += delta;
    }
    return {
      changes,
      range: EditorSelection.range(
        Math.max(startLine.from, range.anchor + anchorDelta),
        Math.max(startLine.from, range.head + headDelta),
      ),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
  view.focus();
  return true;
}

/** Add or remove a line prefix (e.g. `> ` for quotes, `- ` for bullets) per line. */
export function toggleLinePrefix(view: EditorView, prefix: string): boolean {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    const lines = [];
    for (let n = startLine.number; n <= endLine.number; n++) lines.push(state.doc.line(n));
    const allPrefixed = lines.every((l) => l.text.startsWith(prefix));

    const changes = [];
    let headDelta = 0;
    let anchorDelta = 0;
    for (const line of lines) {
      const insert = allPrefixed ? "" : prefix;
      const to = allPrefixed ? line.from + prefix.length : line.from;
      changes.push({ from: line.from, to, insert });
      const delta = insert.length - (to - line.from);
      if (line.from <= range.head) headDelta += delta;
      if (line.from <= range.anchor) anchorDelta += delta;
    }
    return {
      changes,
      range: EditorSelection.range(
        Math.max(startLine.from, range.anchor + anchorDelta),
        Math.max(startLine.from, range.head + headDelta),
      ),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
  view.focus();
  return true;
}

export const toggleQuote = (view: EditorView) => toggleLinePrefix(view, "> ");
export const toggleBulletList = (view: EditorView) => toggleLinePrefix(view, "- ");

/** Insert a markdown link, wrapping the selection as the label and selecting `url`. */
export function insertLink(view: EditorView): boolean {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const label = state.sliceDoc(range.from, range.to);
    const insert = `[${label}](url)`;
    const urlFrom = range.from + label.length + 3; // past `[label](`
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlFrom, urlFrom + 3),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
  view.focus();
  return true;
}

/* ---- Clipboard --------------------------------------------------------- */

export function hasSelection(view: EditorView): boolean {
  return !view.state.selection.main.empty;
}

export async function copySelection(view: EditorView): Promise<void> {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  if (text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard denied — nothing we can do from here */
    }
  }
  view.focus();
}

export async function cutSelection(view: EditorView): Promise<void> {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
  } catch {
    /* clipboard denied */
  }
  view.focus();
}

export async function pasteClipboard(view: EditorView): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) view.dispatch(view.state.replaceSelection(text));
  } catch {
    /* clipboard denied */
  }
  view.focus();
}
