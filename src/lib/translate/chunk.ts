/**
 * 把一份文档切成 Sakura 能吃下的块，再把译文装回去。
 *
 * 三条：
 *
 * 1. **按行切，不按字符切。** 保行是这个模型的强项（为 galgame 脚本训练过），
 *    也因此是我们唯一免费又硬的正确性检查：送进去 N 行，回来必须是 N 行。
 *    按字符切会把一句话劈开，那个检查立刻失效。
 * 2. **没有日文字符的行根本不送。** 空行、纯 URL、`---`、纯 ASCII —— 它们
 *    只会占 token，而且模型对它们做的任何事都是错的。行号留着，重组时按号插回，
 *    所以"送进去 N 行回来 N 行"说的是**送出去的那些行**，与文档的空行无关。
 * 3. **块大小落在实测的安全区。** 30 行和 60 行稳，100 行在 freq=0 下退化，
 *    138 行严重退化。默认 50 行，并且**这是行数上限而不是目标**——超长的单行
 *    不会被拆，它自己就是这一块。
 */

/**
 * 送进模型的一行，连同它在原文档里的行号。
 *
 * 行号是重组的全部依据，所以它必须一路带到译文回来为止——中途丢掉就只能靠
 * 顺序重建，而顺序在任何一次重试后都可能变。
 */
export interface SourceLine {
  index: number;
  text: string;
}

export interface TranslateChunk {
  lines: SourceLine[];
}

export interface SplitResult {
  /** 原文档逐行（已归一为 \n），重组时作底。 */
  allLines: string[];
  chunks: TranslateChunk[];
}

/** 默认块大小。实测安全区见文件头第 3 条。 */
export const DEFAULT_LINES_PER_CHUNK = 50;

/**
 * 平假名 / 片假名 / 汉字 / 半角片假名。
 *
 * 命中即"这一行有东西要翻"。汉字区间同时覆盖中文——这是故意的：一行已经是
 * 中文的文本送进去也不会坏（模型会原样或近似地还给我们），而漏掉一行真正的
 * 日文汉字标题，代价是那一行永远不会被翻译，且没有任何信号。
 */
const TRANSLATABLE = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾝ]/;

/** 这一行需要送进模型吗。 */
export function isTranslatable(line: string): boolean {
  return TRANSLATABLE.test(line);
}

export interface SplitOptions {
  linesPerChunk?: number;
}

/**
 * 切块。`\r\n` 归一为 `\n`，产物也用 `\n`。
 */
export function splitDocument(text: string, opts: SplitOptions = {}): SplitResult {
  const perChunk = Math.max(1, opts.linesPerChunk ?? DEFAULT_LINES_PER_CHUNK);
  const allLines = text.replace(/\r\n/g, "\n").split("\n");

  const chunks: TranslateChunk[] = [];
  let current: SourceLine[] = [];
  allLines.forEach((text, index) => {
    if (!isTranslatable(text)) return;
    current.push({ index, text: text.trim() });
    if (current.length >= perChunk) {
      chunks.push({ lines: current });
      current = [];
    }
  });
  if (current.length) chunks.push({ lines: current });

  return { allLines, chunks };
}

/** 这一块发给模型的文本。 */
export function chunkSource(chunk: TranslateChunk): string {
  return chunk.lines.map((l) => l.text).join("\n");
}

/**
 * 把一块对半切，用于重试阶梯的最后一级。
 *
 * 单行的块切不动，原样返回一个——调用方据此停止，而不是无限递归。
 */
export function halveChunk(chunk: TranslateChunk): TranslateChunk[] {
  if (chunk.lines.length < 2) return [chunk];
  const mid = Math.ceil(chunk.lines.length / 2);
  return [{ lines: chunk.lines.slice(0, mid) }, { lines: chunk.lines.slice(mid) }];
}

export interface TranslatedLine {
  index: number;
  text: string;
}

/**
 * 把译文按行号装回文档。
 *
 * 没有译文的行号保留原样——这就是空行和 URL 穿透的实现，也是**失败块保留原文**
 * 这条不变量的落点：run 层对一个翻不出来的块，只要不提交它的行，原文就留在那里。
 */
export function applyTranslations(allLines: string[], translated: TranslatedLine[]): string {
  const out = [...allLines];
  for (const t of translated) {
    if (t.index >= 0 && t.index < out.length) out[t.index] = t.text;
  }
  return out.join("\n");
}

/**
 * 把模型交回的行和送出去的行按位置配对。
 *
 * 只在 {@link import("./sakura").judgeChunk} 判定通过后调用——它保证了两边等长。
 * 不等长时返回空数组而不是截断配对：错位的译文比没有译文坏得多，它看起来是对的。
 */
export function pairTranslation(chunk: TranslateChunk, outLines: string[]): TranslatedLine[] {
  if (outLines.length !== chunk.lines.length) return [];
  return chunk.lines.map((l, i) => ({ index: l.index, text: outLines[i] }));
}
