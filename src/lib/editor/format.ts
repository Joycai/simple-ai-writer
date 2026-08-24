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

/**
 * Add or remove a per-line marker across every touched line.
 *
 * `detect` matches the marker already sitting at the start of a line (it is
 * what "already on" means, and what gets replaced when turning off), and
 * `make` builds the marker to add, taking the line's index within the
 * selection so an ordered list can count. Turning off happens only when
 * *every* touched line is already marked — a half-marked block completes
 * rather than clears, which is what makes dragging over a ragged region do
 * the obvious thing.
 */
export function toggleLineMarker(
  view: EditorView,
  detect: RegExp,
  make: (index: number) => string,
): boolean {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    const lines = [];
    for (let n = startLine.number; n <= endLine.number; n++) lines.push(state.doc.line(n));
    const allMarked = lines.every((l) => detect.test(l.text));

    const changes: { from: number; to: number; insert: string }[] = [];
    let headDelta = 0;
    let anchorDelta = 0;
    lines.forEach((line, i) => {
      const existing = detect.exec(line.text)?.[0] ?? "";
      // Turning on *replaces* any marker already there rather than skipping the
      // line, so numbering a block that already holds `5.` renumbers it from
      // the top instead of leaving one item counting from somewhere else.
      const insert = allMarked ? "" : make(i);
      const to = line.from + existing.length;
      changes.push({ from: line.from, to, insert });
      const delta = insert.length - (to - line.from);
      if (line.from <= range.head) headDelta += delta;
      if (line.from <= range.anchor) anchorDelta += delta;
    });
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

/** Escape a literal string for use inside a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Add or remove a line prefix (e.g. `> ` for quotes, `- ` for bullets) per line. */
export function toggleLinePrefix(view: EditorView, prefix: string): boolean {
  return toggleLineMarker(view, new RegExp(`^${reEscape(prefix)}`), () => prefix);
}

export const toggleQuote = (view: EditorView) => toggleLinePrefix(view, "> ");
export const toggleBulletList = (view: EditorView) => toggleLinePrefix(view, "- ");

/**
 * `1. `, `2. `, … across the touched lines; strips the numbering again when
 * every line already carries one. The count restarts at the top of the
 * selection rather than continuing a list above it — markdown renumbers an
 * ordered list from its own first item anyway, so the visible result is the
 * same and the source stays legible.
 */
export const toggleOrderedList = (view: EditorView) =>
  toggleLineMarker(view, /^\d+[.)] /, (i) => `${i + 1}. `);

/**
 * GitHub-style task list. `detect` accepts a ticked box too, so turning a
 * finished checklist back into prose doesn't leave `[x]` behind.
 */
export const toggleTaskList = (view: EditorView) =>
  toggleLineMarker(view, /^[-*+] \[[ xX]\] /, () => "- [ ] ");

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

/* ---- Block insertion --------------------------------------------------- */

/** A line that is a fence, opening or closing, with any info string. */
const FENCE = /^\s*(```|~~~)/;

/**
 * Fence the touched lines as a code block, or unfence them when they already
 * are.
 *
 * Unlike the inline toggles this works on the primary range only: a fenced
 * block is a single structure, and applying one per cursor in a multi-cursor
 * selection would interleave fences rather than produce N blocks.
 */
export function toggleCodeBlock(view: EditorView, lang = ""): boolean {
  const { state } = view;
  const range = state.selection.main;
  const startLine = state.doc.lineAt(range.from);
  const endLine = state.doc.lineAt(range.to);

  // Already fenced, with the fences *inside* the touched lines.
  if (
    endLine.number > startLine.number &&
    FENCE.test(startLine.text) &&
    FENCE.test(endLine.text)
  ) {
    const inner = state.sliceDoc(state.doc.line(startLine.number + 1).from,
                                 state.doc.line(endLine.number - 1).to);
    view.dispatch(state.update({
      changes: { from: startLine.from, to: endLine.to, insert: inner },
      selection: EditorSelection.range(startLine.from, startLine.from + inner.length),
      scrollIntoView: true,
      userEvent: "input.format",
    }));
    view.focus();
    return true;
  }

  // Already fenced, with the fences on the lines just outside — the ordinary
  // case when the caret is sitting inside a code block.
  const before = startLine.number > 1 ? state.doc.line(startLine.number - 1) : null;
  const after = endLine.number < state.doc.lines ? state.doc.line(endLine.number + 1) : null;
  if (before && after && FENCE.test(before.text) && FENCE.test(after.text)) {
    const body = state.sliceDoc(startLine.from, endLine.to);
    view.dispatch(state.update({
      changes: { from: before.from, to: after.to, insert: body },
      selection: EditorSelection.range(before.from, before.from + body.length),
      scrollIntoView: true,
      userEvent: "input.format",
    }));
    view.focus();
    return true;
  }

  const body = state.sliceDoc(startLine.from, endLine.to);
  const open = "```" + lang + "\n";
  view.dispatch(state.update({
    changes: { from: startLine.from, to: endLine.to, insert: open + body + "\n```" },
    // The body stays selected (or, when it was empty, the caret lands on the
    // blank line between the fences ready to type).
    selection: EditorSelection.range(startLine.from + open.length,
                                     startLine.from + open.length + body.length),
    scrollIntoView: true,
    userEvent: "input.format",
  }));
  view.focus();
  return true;
}

/**
 * Put `text` in as a block of its own, separated from its neighbours by blank
 * lines, and leave the caret after it.
 *
 * Blocks that markdown only recognises at the start of a line — a table, a
 * thematic break — are broken by landing mid-paragraph, so this never inserts
 * at the raw cursor offset: it takes over the caret's line if that line is
 * blank, and otherwise opens a new paragraph below it.
 */
export function insertBlock(view: EditorView, text: string): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.to);
  const head = line.text.trim() === "" ? "" : line.text + "\n\n";
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  // A block butted up against the next paragraph would swallow it (a table
  // keeps eating rows); no next line means end of document, nothing to part from.
  const tail = next && next.text.trim() !== "" ? "\n" : "";
  const insert = head + text + tail;
  const caret = line.from + head.length + text.length;
  view.dispatch(state.update({
    changes: { from: line.from, to: line.to, insert },
    selection: EditorSelection.cursor(caret),
    scrollIntoView: true,
    userEvent: "input.insert",
  }));
  view.focus();
  return true;
}

/** `---` on its own line. */
export const insertHorizontalRule = (view: EditorView) => insertBlock(view, "---");

/**
 * A markdown table skeleton: a header row, the alignment rule, and `rows`
 * empty body rows. `header` labels the columns (`列` → `列 1`, `列 2`, …) —
 * passed in because the caller is the only side that knows the UI language.
 */
export function insertTable(view: EditorView, cols = 3, rows = 2, header = "Column"): boolean {
  const n = Math.max(1, Math.min(10, Math.round(cols)));
  const r = Math.max(1, Math.min(50, Math.round(rows)));
  const cells = Array.from({ length: n }, (_, i) => `${header} ${i + 1}`);
  const widths = cells.map((c) => Math.max(3, c.length));
  const row = (values: string[]) =>
    `| ${values.map((v, i) => v.padEnd(widths[i], " ")).join(" | ")} |`;
  const table = [
    row(cells),
    row(widths.map((w) => "-".repeat(w))),
    ...Array.from({ length: r }, () => row(widths.map(() => ""))),
  ].join("\n");
  return insertBlock(view, table);
}

/**
 * Drop `text` in at the cursor, leaving the caret after it.
 *
 * A dispatch rather than a rewrite of the store's `content`: replacing the
 * whole document would drop the undo history and the cursor with it. Used by
 * everything that puts a new block in — the illustration flows, and 插入图片.
 */
export function insertAtCursor(view: EditorView, text: string): void {
  const at = view.state.selection.main.to;
  view.dispatch(
    view.state.update({
      changes: { from: at, insert: text },
      selection: EditorSelection.cursor(at + text.length),
      scrollIntoView: true,
      userEvent: "input.insert",
    }),
  );
  view.focus();
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
