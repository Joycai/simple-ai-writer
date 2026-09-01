/**
 * markdown-it 的 token 流 → 一份中性的 `DocBlock[]`。
 *
 * 为什么从 token 流走，而不是把 `renderMarkdown` 的 HTML 拿来遍历 DOM：vitest
 * 跑在 `environment: "node"`，没有 DOM——走 DOM 就等于这一层不可测，而这一层
 * 正是全部逻辑所在。用的是 `lib/fs/markdown` 里**同一个** `md` 实例，所以方言
 * 不会分叉，自定义的 `lore_cite` token 也照样看得见。
 *
 * 这里**不做任何排版决定**。`DocBlock` 只说「这是二级标题」「这一段里这几个字
 * 是粗体」，字体字号行距全部来自 `DocFormat`——01-agent-design I1 那条推论的
 * 落点：结构来自 markdown，外观来自预设，中间没有第三种东西。
 */

import { parseMarkdown } from "../fs/markdown";
import type { Token } from "markdown-it";

export interface DocRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  /** 行内代码：等宽字体。 */
  mono?: boolean;
  link?: string;
}

export type DocBlock =
  | { kind: "heading"; level: number; runs: DocRun[] }
  | { kind: "paragraph"; runs: DocRun[]; quote: boolean }
  | { kind: "listItem"; ordered: boolean; level: number; runs: DocRun[] }
  | { kind: "code"; text: string }
  | { kind: "image"; src: string; alt: string }
  | { kind: "table"; rows: DocRun[][][]; headerRows: number }
  | { kind: "rule" };

export interface ParsedDoc {
  blocks: DocBlock[];
  /** 没有原样带过去的东西，一条一句，直接给作者看。 */
  degraded: string[];
}

/** 累计降级项，最后合成人话。数出现次数，因为「有一处」和「有四十处」是两回事。 */
class Degradations {
  private counts = new Map<string, number>();
  add(what: string): void {
    this.counts.set(what, (this.counts.get(what) ?? 0) + 1);
  }
  list(): string[] {
    return [...this.counts].map(([what, n]) => `${what}（${n} 处）`);
  }
}

export function markdownToBlocks(source: string): ParsedDoc {
  const tokens = parseMarkdown(source);
  const blocks: DocBlock[] = [];
  const deg = new Degradations();

  // 列表栈：每进一层 list_open 压一个，出栈时弹掉。层级直接给 docx 的
  // numbering level 用，所以从 0 开始。
  const lists: { ordered: boolean }[] = [];
  let quoteDepth = 0;
  // 当前 inline token 该落成什么。markdown-it 的 inline 是紧跟在 *_open 之后
  // 的独立 token，所以状态只需要活一步。
  let pending:
    | { kind: "heading"; level: number }
    | { kind: "paragraph" }
    | { kind: "listItem"; ordered: boolean; level: number }
    | null = null;
  // 一个列表项里的第一段是「项」，后续段落是这一项的续段——都缩在同一层，但
  // 后者不该再挂一个项目符号。
  let freshItem = false;
  let table: { rows: DocRun[][][]; headerRows: number; row: DocRun[][] | null; inHead: boolean } | null = null;

  for (const token of tokens) {
    switch (token.type) {
      case "heading_open":
        pending = { kind: "heading", level: Number(token.tag.slice(1)) || 1 };
        break;
      case "paragraph_open":
        pending =
          lists.length > 0 && freshItem
            ? { kind: "listItem", ordered: lists[lists.length - 1].ordered, level: lists.length - 1 }
            : { kind: "paragraph" };
        freshItem = false;
        break;
      case "bullet_list_open":
        lists.push({ ordered: false });
        break;
      case "ordered_list_open":
        lists.push({ ordered: true });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        lists.pop();
        break;
      case "list_item_open":
        freshItem = true;
        break;
      case "blockquote_open":
        quoteDepth++;
        break;
      case "blockquote_close":
        quoteDepth = Math.max(0, quoteDepth - 1);
        break;
      case "fence":
      case "code_block":
        // mermaid 在预览里是图，在 Word 里没有对应物。退回代码块是**说出来**的
        // 降级，不是悄悄丢掉——图还在，只是以源码的样子。
        if (/^mermaid\b/i.test(token.info?.trim() ?? "")) deg.add("mermaid 图退回成了代码块");
        blocks.push({ kind: "code", text: token.content.replace(/\n$/, "") });
        break;
      case "hr":
        blocks.push({ kind: "rule" });
        break;
      case "table_open":
        table = { rows: [], headerRows: 0, row: null, inHead: false };
        break;
      case "thead_open":
        if (table) table.inHead = true;
        break;
      case "thead_close":
        if (table) table.inHead = false;
        break;
      case "tr_open":
        if (table) table.row = [];
        break;
      case "tr_close":
        if (table?.row) {
          table.rows.push(table.row);
          if (table.inHead) table.headerRows++;
          table.row = null;
        }
        break;
      case "table_close":
        if (table && table.rows.length > 0) {
          blocks.push({ kind: "table", rows: table.rows, headerRows: table.headerRows });
        }
        table = null;
        break;
      case "math_block":
        // 公式一期不做 OMML（那是把 TeX 编译到 OMML，独立一件事），退回原文。
        deg.add("数学公式退回成了原始文本");
        blocks.push({ kind: "paragraph", runs: [{ text: `$$${token.content.trim()}$$` }], quote: false });
        break;
      case "inline": {
        const { runs, imageOnly } = inlineRuns(token, deg);
        // 表格单元格里的 inline 归表格，不进 blocks。
        if (table?.row) {
          table.row.push(runs);
          break;
        }
        if (!pending) break;
        if (imageOnly && pending.kind === "paragraph") {
          blocks.push({ kind: "image", src: imageOnly.src, alt: imageOnly.alt });
        } else if (pending.kind === "heading") {
          blocks.push({ kind: "heading", level: pending.level, runs });
        } else if (pending.kind === "listItem") {
          blocks.push({ kind: "listItem", ordered: pending.ordered, level: pending.level, runs });
        } else if (runs.length > 0) {
          blocks.push({ kind: "paragraph", runs, quote: quoteDepth > 0 });
        }
        pending = null;
        break;
      }
    }
  }

  return { blocks, degraded: deg.list() };
}

/**
 * 一个 inline token 的子 token → runs。
 *
 * `imageOnly` 只在整段就是一张图时给出（`![](assets/x.png)` 独占一行，最常见的
 * 插图写法）——那时它该是一个块，而不是一段里的一个字。行内插图退回替代文字：
 * 一张图挤在一行字中间，Word 里怎么排都是错的。
 */
function inlineRuns(token: Token, deg: Degradations): { runs: DocRun[]; imageOnly?: { src: string; alt: string } } {
  const runs: DocRun[] = [];
  const children = token.children ?? [];
  let bold = 0;
  let italic = 0;
  let strike = 0;
  let link: string | undefined;
  let images = 0;
  let firstImage: { src: string; alt: string } | undefined;
  let nonImageText = false;

  const push = (text: string, extra: Partial<DocRun> = {}) => {
    if (!text) return;
    runs.push({
      text,
      ...(bold > 0 ? { bold: true } : {}),
      ...(italic > 0 ? { italic: true } : {}),
      ...(strike > 0 ? { strike: true } : {}),
      ...(link ? { link } : {}),
      ...extra,
    });
  };

  for (const child of children) {
    switch (child.type) {
      case "text":
        if (child.content.trim()) nonImageText = true;
        push(child.content);
        break;
      case "strong_open": bold++; break;
      case "strong_close": bold--; break;
      case "em_open": italic++; break;
      case "em_close": italic--; break;
      case "s_open": strike++; break;
      case "s_close": strike--; break;
      case "link_open": link = child.attrGet("href")?.toString() ?? undefined; break;
      case "link_close": link = undefined; break;
      case "code_inline":
        nonImageText = true;
        push(child.content, { mono: true });
        break;
      case "softbreak":
        push(" ");
        break;
      case "hardbreak":
        push("\n");
        break;
      case "image": {
        images++;
        const src = child.attrGet("src")?.toString() ?? "";
        const alt = child.content || "";
        if (!firstImage) firstImage = { src, alt };
        break;
      }
      case "lore_cite": {
        const meta = child.meta as { label?: string } | undefined;
        nonImageText = true;
        deg.add("知识库引用退回成了纯文字");
        push(meta?.label ?? child.content);
        break;
      }
      default:
        if (child.type.startsWith("math")) {
          nonImageText = true;
          deg.add("数学公式退回成了原始文本");
          push(`$${child.content}$`);
        }
        break;
    }
  }

  if (images === 1 && !nonImageText && firstImage) {
    return { runs: [], imageOnly: firstImage };
  }
  if (images > 0) {
    for (let i = 0; i < images; i++) deg.add("行内插图退回成了替代文字");
    if (firstImage?.alt) push(firstImage.alt);
  }
  return { runs };
}

/**
 * 按一级标题切成若干「章」，给「每章页码从 1 开始」用。
 *
 * 纯函数，所以这条判断可以单测——而它有两个只会静默出错的边界：
 *
 * - **第一个一级标题之前的内容自成一节**（封面、前言）。把它并进第一章，页码
 *   就从封面开始数，第一章的第 1 页会是第 3 页。
 * - **没有一级标题时返回一整节**，不是零节。返回空数组的话整份文稿会消失，
 *   而且是安静地消失。
 */
export function splitChapters(blocks: readonly DocBlock[]): DocBlock[][] {
  const out: DocBlock[][] = [];
  let current: DocBlock[] = [];
  for (const block of blocks) {
    if (block.kind === "heading" && block.level === 1 && current.length > 0) {
      out.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) out.push(current);
  return out.length > 0 ? out : [[]];
}
