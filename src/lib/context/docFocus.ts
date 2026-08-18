/**
 * What the conversation is told about the document the author has open.
 *
 * The chat used to seed the open document's tail window (plus its rolling
 * memory) into every session, unconditionally — 2.4k characters of manuscript
 * on the first turn whether the author asked "把这一段改紧凑些" or "帮我查一下
 * 艾尔登的设定". Most questions are not about the file that happens to be in the
 * editor, and the ones that are can say so.
 *
 * So the default is a **brief**: the path, the title, how long it is (an empty
 * file says so), and its heading outline — enough for the assistant to judge
 * whether the file is relevant at all, and, because the path is right there,
 * to go and read it with `read_file` when it decides that it is. The body is
 * injected only when the turn actually points at the document:
 *
 *   - the author pinned a passage from it to the message (an unambiguous
 *     "this is what I'm talking about"), or
 *   - the message uses the words that only make sense about the open file —
 *     这一段 / 本章 / 全文 / 继续写 / "this chapter" / "continue writing".
 *
 * Everything outside those two is left to the assistant's own judgement,
 * because it is the one holding the question and it has the tools. The cost of
 * guessing wrong in that direction is one `read_file` round; the cost of
 * guessing wrong in the other direction was paid on every single conversation.
 */

import i18n from "../../i18n";
import { countWords, extractHeadings } from "../fs/markdown";

/** How much of the heading outline the brief carries. */
const MAX_OUTLINE_HEADINGS = 12;
/** Longest single heading in the outline; longer ones are elided. */
const MAX_HEADING_CHARS = 40;

/** First H1/H2 of the document, if it opens with one. */
function documentTitle(text: string): string | null {
  const headings = extractHeadings(text);
  const first = headings[0];
  if (!first || first.level > 2) return null;
  return first.text.slice(0, MAX_HEADING_CHARS);
}

/**
 * The document's shape, as an indented outline.
 *
 * Headings are what tells the assistant whether the answer might be in this
 * file — "第三章 / 一 / 二 / 三" is a table of contents for the price of a
 * dozen short lines, and it is the difference between a judgement and a guess.
 */
function documentOutline(text: string): string | null {
  const headings = extractHeadings(text);
  if (headings.length === 0) return null;
  const shown = headings.slice(0, MAX_OUTLINE_HEADINGS);
  const lines = shown.map((h) => {
    const indent = "  ".repeat(Math.max(0, Math.min(h.level, 4) - 1));
    const title = h.text.length > MAX_HEADING_CHARS
      ? `${h.text.slice(0, MAX_HEADING_CHARS)}…`
      : h.text;
    return `${indent}- ${title}`;
  });
  if (headings.length > shown.length) {
    lines.push(
      `  ${i18n.t("ai.instructions.docBrief.moreHeadings", {
        defaultValue: "…还有 {{n}} 个小节",
        n: headings.length - shown.length,
      })}`,
    );
  }
  return lines.join("\n");
}

/**
 * What is open, without its contents — the lines that follow the path inside
 * the 【当前文件】 block (the caller supplies the path, which is also what the
 * notice below points the assistant at).
 *
 * Ends with that notice, because a model told a file exists and *not* told the
 * text was withheld reasons as though it had already seen it — a failure that
 * is silent and reads like confident hallucination. `withheld: false` drops
 * that line for the turns that do carry the window: the title, the length and
 * the outline are still worth having (the window is only the document's tail,
 * so the outline is the only thing that says what is above it).
 */
export function documentBrief(
  text: string,
  opts: { withheld?: boolean } = {},
): string {
  const label = (key: string, fallback: string) =>
    i18n.t(`ai.instructions.docBrief.${key}`, { defaultValue: fallback });

  const lines: string[] = [];

  const title = documentTitle(text);
  if (title) lines.push(`${label("title", "标题")}: ${title}`);

  lines.push(
    `${label("size", "篇幅")}: ${
      text.trim().length === 0
        ? label("empty", "空文件（还没有任何内容）")
        : i18n.t("ai.instructions.docBrief.words", {
            defaultValue: "约 {{n}} 字",
            n: countWords(text).toLocaleString(),
          })
    }`,
  );

  const outline = documentOutline(text);
  if (outline) lines.push(`${label("outline", "小节")}:\n${outline}`);

  // Only when the text really was withheld. Sent beside an injected window it
  // would contradict what the model can plainly see, and a context block that
  // argues with itself is worse than no block.
  if (opts.withheld !== false) {
    lines.push(
      i18n.t("ai.instructions.docBrief.notice", {
        defaultValue:
          "（正文没有随本次对话注入。判断这个文件与作者的问题有关时，用 read_file 读上面那个路径；"
          + "只想定位其中某处就用 search_text。）",
      }),
    );
  }
  return lines.join("\n");
}

/**
 * Words that only mean something about the file the author has open.
 *
 * Deliberately narrow: deixis (这一段 / 本章 / this passage), the document as a
 * whole (全文 / 正文 / the whole chapter), and continuation (继续写 / continue
 * writing), which is always about the text under the cursor. Bare editing verbs
 * — 润色, 改一下, "rewrite this" — are **not** here on purpose: they take an
 * object, and when that object is the open document one of these words is
 * almost always next to it. Guessing from the verb alone would put the file
 * back into every request that merely sounds like writing work.
 */
const DOC_CUES: RegExp[] = [
  // 这/那/本/此 + a unit of the open text
  /[这那本此][一几]?(段|句|节|章|篇|页|部分|块|处|文|稿|份文档|份文件|个文档|个文件|个段落|首诗|张表)/,
  // 当前/正在打开的文档
  /(当前|现在|正在(编辑|打开|写)的?|打开的|眼前的|手上的)(这)?(文档|文件|文章|稿子|章节|页面)/,
  // the document as a whole, or its surroundings
  /(全文|通篇|整篇|整章|整个文档|整个文件|正文|原文|上文|前文|下文|后文|文末|开头这|结尾这)/,
  // continuation always attaches to the text in the editor
  /(继续|接着|接下去|往下|再)(写|往下写)|续写|写下去|把它写完|写完它/,
  /[这那]里(的)?(内容|文字|正文|段落)/,
  // English
  /\bthis (document|file|chapter|section|passage|paragraph|scene|draft|page|text|story|article|note)\b/i,
  /\b(the )?(current|open|opened|active) (document|file|chapter|page|draft|note)\b/i,
  /\b(the )?(whole|entire|full) (document|file|chapter|text|thing)\b/i,
  /\b(continue|keep) writing\b|\bwrite (on|more|the rest)\b|\bfinish (this|the) (chapter|draft|scene|piece)\b/i,
  /\b(the )?(text|passage|paragraph|lines?) (above|below|here)\b/i,
];

/** Does this message point at the document the author has open? */
export function queryWantsDocument(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  return DOC_CUES.some((re) => re.test(q));
}

/**
 * Whether this turn earns the document's body.
 *
 * `alreadyAttached` is the author having `@`-referenced the open file itself:
 * its text is inlined in the message already, and injecting the window beside
 * it would send the same paragraphs twice.
 */
export function wantsDocumentBody(opts: {
  query: string;
  hasQuote: boolean;
  alreadyAttached: boolean;
}): boolean {
  if (opts.alreadyAttached) return false;
  // A pinned passage IS the author saying "this file, this part of it".
  return opts.hasQuote || queryWantsDocument(opts.query);
}
