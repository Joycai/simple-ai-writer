/**
 * Sakura 的提示词格式、采样参数，和「这一块翻坏了没有」的判定。
 *
 * 全部实测记录见 `docs/feature/translate/00-sakura-feasibility.html` §01，
 * 执行方案见同目录 `01-execution-plan.md` §4。四条不能改的：
 *
 * 1. **system 那句话是训练时固定的，逐字发送。** 不是可以润色的提示词。实测
 *    换成通用 system 加自由指令它照样翻得很好——原因不是"模板保证质量"，而是
 *    它**根本不读指令**：问它「你是什么模型」，它把问题改写一遍还回来。模板
 *    唯一的实质价值是**术语表这条通道只存在于模板版的 user 消息里**。
 * 2. **两个模板，不是一个带空槽的模板。** 术语表为空时走无术语表版，省掉一段
 *    模型会当成"有个空清单要参考"的文本。
 * 3. **退化判定的顺序是 degenerate → truncated → line-mismatch，不能换。**
 *    退化几乎总会连带撞满 `max_tokens`，先问"是不是退化"才能说出**原因**；
 *    反过来只会把每次退化都报成"截断了"，作者据此只会去调大 max_tokens ——
 *    而那恰好是错的处方（实测 138 行给到 8192 反而退化得更久）。
 * 4. **不信"重复整行"。** 实测两次退化的重复行计数都是 **0** —— 复读发生在
 *    一行之内（「斯凯尔顿伦伦伦伦伦…」）。可靠的信号只有本文件里这三个。
 */

/** 训练时固定的 system 提示词。逐字，不要改动、不要翻译、不要"优化"。 */
export const SAKURA_SYSTEM =
  "你是一个轻小说翻译模型，可以流畅通顺地以日本轻小说的风格将日文翻译成简体中文，" +
  "并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。";

/**
 * 官方推荐的采样值，也是实测用的那一组。
 *
 * 不含 `frequencyPenalty`：那一项按块变（见 {@link FREQ_LADDER}），把它放进
 * 一个叫"默认参数"的常量里，只会让人以为它是固定的。
 */
export const SAKURA_SAMPLING = { temperature: 0.1, topP: 0.3 } as const;

/**
 * 重试阶梯：首发 0.1，退化后 0.2，再不行就把这块对半切（切在 run 层）。
 *
 * 首项是 0.1 而不是官方文档里的 0（那是它的默认值）：实测 100 行在 0 上退化到
 * 撞满 4096 token 只译出 63 行，同一块 0.2 不但 100 行全部完整，耗时还从 70 秒
 * 降到 34 秒。首发就给 0.1 是拿一点点保守换掉大部分重试。
 */
export const FREQ_LADDER = [0.1, 0.2] as const;

/**
 * 每行给多少输出 token 的预算。
 *
 * 实测正常翻译稳定在 19–22 tok/行，取 32 留足裕度——留裕度的目的不是"别截断"，
 * 而是让「被截断」保持是一个**有意义的报警**：卡得太紧的话
 * 每一块都会撞上限，真正的退化就淹没在噪音里。
 */
export const MAX_TOKENS_PER_LINE = 32;

/** 一次请求的输出下限。极短的块按行数算会得到一个荒谬的小数字。 */
const MIN_MAX_TOKENS = 256;

/** 这一块该给多少 `max_tokens`。 */
export function maxTokensFor(lineCount: number): number {
  return Math.max(MIN_MAX_TOKENS, lineCount * MAX_TOKENS_PER_LINE);
}

/**
 * tok/行 的退化阈值。正常 19–22，退化 65–120 —— 中间的裕度大到几乎不可能误判。
 */
export const TOK_PER_LINE_LIMIT = 35;

/**
 * 低于这个行数就不做 tok/行 判定。
 *
 * 比值在样本很小时没有意义：一行长句子六十个 token 完全正常，而阈值会把它报成
 * 退化。行数校验和截断校验对短块照常生效，所以放过它不会漏掉真正的失败。
 */
const MIN_LINES_FOR_RATIO = 3;

export type ChunkFailure = "degenerate" | "truncated" | "line-mismatch";

export type ChunkVerdict =
  | { ok: true; lines: string[] }
  | { ok: false; reason: ChunkFailure; detail: string };

export interface ChunkResult {
  /** 送进模型的行数。 */
  srcLineCount: number;
  /** 模型返回的原始文本。 */
  outText: string;
  /**
   * 适配器归一后的「被输出上限截断了」。
   *
   * 用这个而不是 `finish_reason === "length"`：那是 OpenAI 一家的拼法，而
   * `StreamChunk.done.truncated` 是三个协议族都已经归一过的同一件事
   * （Gemini 说 `MAX_TOKENS`）。缺失时只是少一个信号，不影响另外两个。
   */
  truncated?: boolean;
  /** 端点报的输出 token 数。0 或缺失时跳过 tok/行 判定。 */
  completionTokens?: number;
}

/**
 * 这一块能不能用。
 *
 * 通过时连**已经拆好的行**一起交回去，调用方不必再拆一次——"什么算一行"必须
 * 只有一个定义，否则判定用的行数和写进文件的行数可以不一样。
 */
export function judgeChunk(r: ChunkResult): ChunkVerdict {
  const lines = r.outText.split("\n").map((l) => l.trim()).filter(Boolean);

  if (lines.length === 0) {
    return { ok: false, reason: "line-mismatch", detail: "模型没有返回任何内容" };
  }

  // 1. 退化。放在最前面：它几乎总会连带撞满 max_tokens，先问这一条才说得出原因。
  const outTokens = r.completionTokens ?? 0;
  if (outTokens > 0 && lines.length >= MIN_LINES_FOR_RATIO) {
    const perLine = outTokens / lines.length;
    if (perLine > TOK_PER_LINE_LIMIT) {
      return {
        ok: false,
        reason: "degenerate",
        detail: `${perLine.toFixed(1)} tok/行（正常 19–22，上限 ${TOK_PER_LINE_LIMIT}）`,
      };
    }
  }

  // 2. 截断。没有退化却撞满上限，说明这一块本来就太大。
  if (r.truncated) {
    return {
      ok: false,
      reason: "truncated",
      detail: `撞满输出上限，只译出 ${lines.length}/${r.srcLineCount} 行`,
    };
  }

  // 3. 行数不符。实测三次失败它全都抓到了——这是主力判据，前两条是给出原因的。
  if (lines.length !== r.srcLineCount) {
    return {
      ok: false,
      reason: "line-mismatch",
      detail: `原文 ${r.srcLineCount} 行，译文 ${lines.length} 行`,
    };
  }

  return { ok: true, lines };
}

/**
 * user 消息。术语表为空时走无术语表版——见文件头第 2 条。
 *
 * `glossary` 是 {@link import("./glossary").formatGlossary} 的产物：一行一条
 * `src->dst #备注`。
 */
export function buildUserMessage(source: string, glossary = ""): string {
  const g = glossary.trim();
  if (!g) return `将下面的日文文本翻译成中文：${source}`;
  return `根据以下术语表（可以为空）：\n${g}\n将下面的日文文本根据对应关系和备注翻译成中文：${source}`;
}
