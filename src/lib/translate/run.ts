/**
 * 一块的翻译：请求、判定、按阶梯重试。
 *
 * 这是 `lib/translate/` 里**唯一**碰网络的地方，纯逻辑全在旁边四个模块里。
 *
 * 三条：
 *
 * 1. **绕开 `runAgent`。** Sakura 没有 tool calling，也不读指令——把它塞进工具
 *    循环，唯一的结果是把工具 schema 当日文原文翻掉。所以这里直接调
 *    `streamCompletion`（不变量 1）。
 * 2. **阶梯是 `FREQ_LADDER` 走完再对半切，不是无限重试。** 切到单行仍不合格
 *    就把这一块判死，交给调用方处理——它**必须**保留原文（不变量 3）。
 * 3. **回带上一块的尾巴，但不参与本块的计量。** tok/行 只除以本块的输出行数。
 *
 * 整文件的编排见本文件下半部的 {@link runDocument}；审批卡片与记账在
 * `lib/translate/tool.ts`——那里才有 `ToolContext`。
 */

import { streamCompletion } from "../ai";
import type { ConnOptions } from "../ai/conn";
import {
  chunkSource, halveChunk, pairTranslation, splitDocument,
  type TranslateChunk, type TranslatedLine,
} from "./chunk";
import { buildCarry, type CarrySource } from "./context";
import { collectGlossary, enforceGlossary, formatGlossary, type GlossaryEntry } from "./glossary";
import {
  buildUserMessage,
  FREQ_LADDER,
  judgeChunk,
  maxTokensFor,
  SAKURA_SAMPLING,
  SAKURA_SYSTEM,
  type ChunkFailure,
} from "./sakura";
import type { LoreIndex } from "../lore/model";

export interface TranslateUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChunkAttempt {
  /** 这一次用的 frequency_penalty，进日志/事件用。 */
  freq: number;
  ok: boolean;
  reason?: ChunkFailure;
  detail?: string;
}

export interface ChunkOutcome {
  ok: boolean;
  /** 通过时的逐行译文（已落实术语表）。失败时为空 —— 调用方据此保留原文。 */
  lines: TranslatedLine[];
  /** 这一块每一次尝试的记录，含被判死的那些。 */
  attempts: ChunkAttempt[];
  usage: TranslateUsage;
}

export interface RunChunkOptions {
  conn: ConnOptions;
  /** 术语表来源。不给就走无术语表模板。 */
  loreIndex?: LoreIndex;
  /**
   * 「翻译词典」条目正文里的词条，整份文档一次解析（正文不在 LoreIndex 里，
   * 读它要碰盘——见 `tool.loadTranslateDict`）。逐块命中筛选仍在
   * `collectGlossary` 里做，所以这里传的是全量。
   */
  dict?: readonly GlossaryEntry[];
  /** 上一块的尾巴。 */
  carry?: CarrySource | null;
  signal?: AbortSignal;
  /** 每一次尝试结束时的回调，给执行日志用。 */
  onAttempt?: (a: ChunkAttempt) => void;
}

/** 一次请求。判定所需的三个信号全在返回值里。 */
async function requestOnce(
  chunk: TranslateChunk,
  glossary: string,
  freq: number,
  o: RunChunkOptions,
): Promise<{ text: string; truncated: boolean; usage: TranslateUsage }> {
  let text = "";
  let truncated = false;
  const usage: TranslateUsage = { inputTokens: 0, outputTokens: 0 };

  await streamCompletion({
    ...o.conn,
    // 覆盖模型行上的配置：这三个值属于这个**格式**，不属于作者对某个端点的偏好。
    ...SAKURA_SAMPLING,
    frequencyPenalty: freq,
    maxOutput: maxTokensFor(chunk.lines.length),
    // 工具永远不传：见文件头第 1 条。
    tools: undefined,
    messages: [
      { role: "system", content: SAKURA_SYSTEM },
      ...buildCarry(o.carry),
      { role: "user", content: buildUserMessage(chunkSource(chunk), glossary) },
    ],
    signal: o.signal,
    onChunk: (c) => {
      if ("text" in c && c.text) text += c.text;
      if ("done" in c && c.done) {
        truncated = c.truncated === true;
        usage.inputTokens = c.inputTokens;
        usage.outputTokens = c.outputTokens;
      }
    },
  });

  return { text, truncated, usage };
}

/**
 * 翻一块，带重试阶梯。
 *
 * 对半切的那一级是**递归**：切出来的两半各自再走一遍完整的阶梯。`halveChunk`
 * 对单行块返回它自己，所以递归到单行就停 —— 这是唯一的终止条件，不要另外加
 * 深度计数器去重复它。
 */
export async function runChunk(chunk: TranslateChunk, o: RunChunkOptions): Promise<ChunkOutcome> {
  const source = chunkSource(chunk);
  const entries: GlossaryEntry[] =
    o.loreIndex || o.dict?.length
      ? collectGlossary(o.loreIndex ?? {}, source, o.dict)
      : [];
  const glossary = formatGlossary(entries);

  const attempts: ChunkAttempt[] = [];
  const usage: TranslateUsage = { inputTokens: 0, outputTokens: 0 };

  for (const freq of FREQ_LADDER) {
    const r = await requestOnce(chunk, glossary, freq, o);
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;

    const verdict = judgeChunk({
      srcLineCount: chunk.lines.length,
      outText: r.text,
      truncated: r.truncated,
      completionTokens: r.usage.outputTokens,
    });

    const attempt: ChunkAttempt = verdict.ok
      ? { freq, ok: true }
      : { freq, ok: false, reason: verdict.reason, detail: verdict.detail };
    attempts.push(attempt);
    o.onAttempt?.(attempt);

    if (verdict.ok) {
      // 术语表在这里落实，不在判定之前：判定算的是模型交回来的东西，强制替换
      // 只改字面、不改行数，放在后面才不会让判定看到一份被我们动过的输出。
      const lines = entries.length
        ? verdict.lines.map((l) => enforceGlossary(l, entries))
        : verdict.lines;
      return { ok: true, lines: pairTranslation(chunk, lines), attempts, usage };
    }
  }

  // 阶梯走完还不行：对半切，两半各自重走一遍。
  const halves = halveChunk(chunk);
  if (halves.length < 2) return { ok: false, lines: [], attempts, usage };

  const lines: TranslatedLine[] = [];
  for (const half of halves) {
    // carry 不往下传：切开之后前半段自己就是后半段的上文，而前半段的上文仍是
    // 原来那一个——传下去会让后半段带上一段与它不相邻的文本。
    const sub = await runChunk(half, { ...o, carry: half === halves[0] ? o.carry : null });
    attempts.push(...sub.attempts);
    usage.inputTokens += sub.usage.inputTokens;
    usage.outputTokens += sub.usage.outputTokens;
    // 一半失败就整块失败：半份译文配半份原文，读起来比整块原文更难收拾。
    if (!sub.ok) return { ok: false, lines: [], attempts, usage };
    lines.push(...sub.lines);
  }
  return { ok: true, lines, attempts, usage };
}

// ─── 整文件 ───────────────────────────────────────────────────────────────────

export interface DocProgress {
  /** 已经处理完的块数（含失败的）。 */
  done: number;
  total: number;
  /** 到目前为止失败的块数。 */
  failed: number;
}

export interface FailedChunk {
  /** 这一块在文档里的首行行号，用来给失败标记定位。 */
  firstLine: number;
  lineCount: number;
  reason?: ChunkFailure;
  detail?: string;
}

export interface DocOutcome {
  /** 成品全文。失败的块在这里是**原文**加一行标记。 */
  text: string;
  chunkCount: number;
  failed: FailedChunk[];
  usage: TranslateUsage;
  /**
   * 作者中断了。产物仍然完整——没轮到的块保持原文——但它不是一份译完的稿子，
   * 调用方要把这件事说出来，而不是当成成功。
   */
  aborted: boolean;
}

export interface RunDocumentOptions extends Omit<RunChunkOptions, "carry"> {
  /** 每块结束时调用，给执行日志和进度条。 */
  onProgress?: (p: DocProgress) => void;
  /** 块大小。默认见 `chunk.DEFAULT_LINES_PER_CHUNK`——实测的安全区。 */
  linesPerChunk?: number;
}

/**
 * 失败块的标记。
 *
 * HTML 注释而不是纯文本：markdown 预览里不显示，编辑器里能搜到，作者一眼就
 * 看得出哪几段要手工处理。而它下面躺着的是**原文**——不变量 3。
 */
function failureMarker(index: number, total: number, f: FailedChunk): string {
  const why = f.reason ? `${f.reason}${f.detail ? `：${f.detail}` : ""}` : "未知原因";
  return `<!-- 翻译失败（第 ${index}/${total} 块，${why}）：以下为原文 -->`;
}

/**
 * 翻一份文档。
 *
 * 三条：
 *
 * 1. **失败的块保留原文**（不变量 3）。只在它前面插一行注释说明。半份译文
 *    配半份原文比整块原文更难收拾，所以这里的失败粒度是「块」。
 * 2. **carry 只从成功的块往下传。** 一块失败之后，下一块的上文是**再上一块**
 *    的尾巴，而不是一段没译出来的东西。
 * 3. **中断保留已完成的块。** `aborted` 让调用方知道这不是一份译完的稿子，
 *    但已经花掉的时间和 token 不该跟着一起丢。
 */
export async function runDocument(text: string, o: RunDocumentOptions): Promise<DocOutcome> {
  const { allLines, chunks } = splitDocument(text, { linesPerChunk: o.linesPerChunk });
  const out = [...allLines];
  const usage: TranslateUsage = { inputTokens: 0, outputTokens: 0 };
  const failed: FailedChunk[] = [];
  // 行号 → 要插在它前面的标记。分开收集，因为直接往 `out` 里插会让后面每一块
  // 的行号全部失效。
  const markers = new Map<number, string>();

  let carry: CarrySource | null = null;
  let aborted = false;

  for (const [i, chunk] of chunks.entries()) {
    if (o.signal?.aborted) {
      aborted = true;
      break;
    }

    let outcome;
    try {
      outcome = await runChunk(chunk, { ...o, carry });
    } catch (e) {
      // 中断走的是 AbortError，不是失败：没轮到的块保持原文，已完成的留下。
      if ((e as Error).name === "AbortError") {
        aborted = true;
        break;
      }
      throw e;
    }

    usage.inputTokens += outcome.usage.inputTokens;
    usage.outputTokens += outcome.usage.outputTokens;

    if (outcome.ok) {
      for (const l of outcome.lines) out[l.index] = l.text;
      carry = {
        source: chunk.lines.map((l) => l.text),
        translated: outcome.lines.map((l) => l.text),
      };
    } else {
      const last = outcome.attempts[outcome.attempts.length - 1];
      const f: FailedChunk = {
        firstLine: chunk.lines[0].index,
        lineCount: chunk.lines.length,
        reason: last?.reason,
        detail: last?.detail,
      };
      failed.push(f);
      markers.set(f.firstLine, failureMarker(i + 1, chunks.length, f));
      // carry 不动：见文件头第 2 条。
    }

    o.onProgress?.({ done: i + 1, total: chunks.length, failed: failed.length });
  }

  // 标记从后往前插，这样前面的行号还没被动过。
  const withMarkers = [...out];
  for (const line of [...markers.keys()].sort((a, b) => b - a)) {
    withMarkers.splice(line, 0, markers.get(line)!);
  }

  return { text: withMarkers.join("\n"), chunkCount: chunks.length, failed, usage, aborted };
}
