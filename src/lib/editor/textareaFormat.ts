/**
 * Markdown formatting for plain `<textarea>` surfaces (e.g. the lore editor),
 * mirroring the CodeMirror commands in `format.ts`.
 *
 * The transforms are split into pure functions (`*Edit`, unit-testable without a
 * DOM) that compute a single contiguous replacement + resulting selection, and
 * thin DOM appliers that write the change back through React by dispatching an
 * `input` event so controlled `onChange` handlers fire.
 */

export interface TextEdit {
  /** Replace `value.slice(from, to)` with `insert`. */
  from: number;
  to: number;
  insert: string;
  /** Selection to restore afterwards, in the post-edit document. */
  selStart: number;
  selEnd: number;
}

/* ---- Pure transforms --------------------------------------------------- */

/** Wrap (or unwrap) the selection with an inline marker like `**`. */
export function wrapEdit(v: string, s: number, e: number, marker: string, end = marker): TextEdit {
  const before = v.slice(Math.max(0, s - marker.length), s);
  const after = v.slice(e, e + end.length);

  // Markers sit just outside the selection → strip them.
  if (before === marker && after === end) {
    return { from: s - marker.length, to: e + end.length, insert: v.slice(s, e),
      selStart: s - marker.length, selEnd: e - marker.length };
  }

  const sel = v.slice(s, e);
  // Markers are part of the selection → strip them.
  if (sel.length >= marker.length + end.length && sel.startsWith(marker) && sel.endsWith(end)) {
    const inner = sel.slice(marker.length, sel.length - end.length);
    return { from: s, to: e, insert: inner, selStart: s, selEnd: s + inner.length };
  }

  // Otherwise wrap. Empty selection → cursor lands between the markers.
  return { from: s, to: e, insert: marker + sel + end,
    selStart: s + marker.length, selEnd: e + marker.length };
}

/** Bounds of the line block the selection touches. */
function blockBounds(v: string, s: number, e: number): [number, number] {
  const from = v.lastIndexOf("\n", s - 1) + 1;
  let to = v.indexOf("\n", e);
  if (to === -1) to = v.length;
  return [from, to];
}

/** Selection for a rewritten block: collapse to the end for a caret, else cover it. */
function blockSelection(from: number, out: string, collapsed: boolean): [number, number] {
  return collapsed ? [from + out.length, from + out.length] : [from, from + out.length];
}

/** Set every touched line to heading `level`, or clear it if already there. */
export function headingEdit(v: string, s: number, e: number, level: number): TextEdit {
  const [from, to] = blockBounds(v, s, e);
  const lines = v.slice(from, to).split("\n");
  const target = "#".repeat(level) + " ";
  const atLevel = new RegExp(`^#{${level}} `);
  const allAt = lines.every((l) => atLevel.test(l));
  const out = lines
    .map((l) => {
      const m = /^#{1,6} +/.exec(l);
      const body = m ? l.slice(m[0].length) : l;
      return allAt ? body : target + body;
    })
    .join("\n");
  const [selStart, selEnd] = blockSelection(from, out, s === e);
  return { from, to, insert: out, selStart, selEnd };
}

/** Add or remove a line prefix (`> `, `- `) on every touched line. */
export function linePrefixEdit(v: string, s: number, e: number, prefix: string): TextEdit {
  const [from, to] = blockBounds(v, s, e);
  const lines = v.slice(from, to).split("\n");
  const allPrefixed = lines.every((l) => l.startsWith(prefix));
  const out = lines
    .map((l) => (allPrefixed ? l.slice(prefix.length) : prefix + l))
    .join("\n");
  const [selStart, selEnd] = blockSelection(from, out, s === e);
  return { from, to, insert: out, selStart, selEnd };
}

/** Insert a markdown link, wrapping the selection as the label. */
export function linkEdit(v: string, s: number, e: number): TextEdit {
  const label = v.slice(s, e);
  const insert = `[${label}](url)`;
  const urlFrom = s + label.length + 3; // past `[label](`
  return { from: s, to: e, insert, selStart: urlFrom, selEnd: urlFrom + 3 };
}

/* ---- DOM appliers ------------------------------------------------------ */

function nativeSetValue(el: HTMLTextAreaElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Apply an edit, preserving native undo via execCommand when it takes effect. */
function apply(el: HTMLTextAreaElement, edit: TextEdit) {
  el.focus();
  el.setSelectionRange(edit.from, edit.to);
  const prev = el.value;
  let ok = false;
  try {
    ok = document.execCommand("insertText", false, edit.insert);
  } catch {
    ok = false;
  }
  if (!ok || el.value === prev) {
    nativeSetValue(el, prev.slice(0, edit.from) + edit.insert + prev.slice(edit.to));
  }
  el.setSelectionRange(edit.selStart, edit.selEnd);
}

const run = (fn: (v: string, s: number, e: number) => TextEdit) => (el: HTMLTextAreaElement) =>
  apply(el, fn(el.value, el.selectionStart, el.selectionEnd));

export const taBold = run((v, s, e) => wrapEdit(v, s, e, "**"));
export const taItalic = run((v, s, e) => wrapEdit(v, s, e, "*"));
export const taStrikethrough = run((v, s, e) => wrapEdit(v, s, e, "~~"));
export const taInlineCode = run((v, s, e) => wrapEdit(v, s, e, "`"));
export const taQuote = run((v, s, e) => linePrefixEdit(v, s, e, "> "));
export const taBulletList = run((v, s, e) => linePrefixEdit(v, s, e, "- "));
export const taLink = run(linkEdit);
export const taHeading = (el: HTMLTextAreaElement, level: number) =>
  apply(el, headingEdit(el.value, el.selectionStart, el.selectionEnd, level));

/* ---- Clipboard --------------------------------------------------------- */

export function taHasSelection(el: HTMLTextAreaElement): boolean {
  return el.selectionStart !== el.selectionEnd;
}

export async function taCopy(el: HTMLTextAreaElement) {
  const text = el.value.slice(el.selectionStart, el.selectionEnd);
  if (text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard denied */
    }
  }
  el.focus();
}

export async function taCut(el: HTMLTextAreaElement) {
  const s = el.selectionStart, e = el.selectionEnd;
  const text = el.value.slice(s, e);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    apply(el, { from: s, to: e, insert: "", selStart: s, selEnd: s });
  } catch {
    /* clipboard denied */
  }
}

export async function taPaste(el: HTMLTextAreaElement) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      const s = el.selectionStart, e = el.selectionEnd;
      apply(el, { from: s, to: e, insert: text, selStart: s + text.length, selEnd: s + text.length });
    }
  } catch {
    /* clipboard denied */
  }
}

export function taSelectAll(el: HTMLTextAreaElement) {
  el.focus();
  el.setSelectionRange(0, el.value.length);
}

/* ---- Keyboard shortcuts ------------------------------------------------ */

/** Handle a markdown formatting shortcut on a textarea. Returns true if handled.
 *  Uses `KeyboardEvent.code` for digits/punctuation so it survives Alt-on-macOS
 *  and non-US layouts. Mirrors the CodeMirror keymap in CodeEditor. */
export function handleTextareaShortcut(
  e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string; preventDefault: () => void },
  el: HTMLTextAreaElement | null,
): boolean {
  if (!el || !(e.metaKey || e.ctrlKey)) return false;
  const { shiftKey: shift, altKey: alt, code } = e;
  const go = (fn: (el: HTMLTextAreaElement) => void) => { e.preventDefault(); fn(el); return true; };

  if (!shift && !alt) {
    if (code === "KeyB") return go(taBold);
    if (code === "KeyI") return go(taItalic);
    if (code === "KeyE") return go(taInlineCode);
  }
  if (shift && !alt) {
    if (code === "KeyX") return go(taStrikethrough);
    if (code === "KeyK") return go(taLink);
    if (code === "Period") return go(taQuote);
    if (code === "Digit8") return go(taBulletList);
  }
  if (alt && !shift) {
    if (code === "Digit1") return go((el) => taHeading(el, 1));
    if (code === "Digit2") return go((el) => taHeading(el, 2));
    if (code === "Digit3") return go((el) => taHeading(el, 3));
  }
  return false;
}
