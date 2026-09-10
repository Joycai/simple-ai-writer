/**
 * Syntax highlighting for the manuscript editor — class names only, no colours.
 *
 * CodeMirror's `defaultHighlightStyle` carries its own light palette (a blue
 * `#00c` for URLs, a black-on-white heading weight), and it is a JavaScript
 * object: no token, no `data-scheme`, no way for a theme to reach it. So the
 * editor kept those colours at night, and the `.tok-*` rules in
 * `CodeEditor.module.css` — which *do* read tokens — matched nothing, because
 * the default style emits generated class names.
 *
 * This style assigns each tag one stable `.tok-*` class and nothing else. The
 * colours live in the module stylesheet with everything else the editor
 * draws, so a theme file recolours the editor the same way it recolours a
 * button — see docs/feature/theme-system-plan.md §8.
 */
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const manuscriptHighlight = HighlightStyle.define([
  // Markdown structure
  { tag: t.heading1, class: "tok-heading1" },
  { tag: t.heading2, class: "tok-heading2" },
  { tag: t.heading3, class: "tok-heading3" },
  { tag: t.heading4, class: "tok-heading4" },
  { tag: t.heading5, class: "tok-heading5" },
  { tag: t.heading6, class: "tok-heading6" },
  { tag: t.emphasis, class: "tok-emphasis" },
  { tag: t.strong, class: "tok-strong" },
  { tag: t.strikethrough, class: "tok-strikethrough" },
  { tag: t.link, class: "tok-link" },
  { tag: t.url, class: "tok-url" },
  { tag: t.quote, class: "tok-quote" },
  { tag: t.monospace, class: "tok-monospace" },
  { tag: t.contentSeparator, class: "tok-separator" },
  { tag: t.list, class: "tok-list" },
  // The markers themselves: `#`, `*`, `>`, the fence backticks.
  { tag: t.processingInstruction, class: "tok-processingInstruction" },
  { tag: t.meta, class: "tok-meta" },
  { tag: t.escape, class: "tok-meta" },

  // Fenced code, in whatever language the fence names.
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], class: "tok-keyword" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "tok-comment" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "tok-string" },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal], class: "tok-atom" },
  { tag: [t.typeName, t.className, t.namespace], class: "tok-type" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)], class: "tok-name" },
  { tag: [t.tagName, t.attributeName], class: "tok-tag" },
  { tag: t.invalid, class: "tok-invalid" },
]);
