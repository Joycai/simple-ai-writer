/**
 * 四种标记的解析：`*动作*` / `「台词」` / 裸文本＝场景 / `[元指令]`。
 *
 * 设计稿 1c 的口径：**解析在客户端完成，发给模型的仍是原文**——排版只影响
 * 作者看到的稿面。所以这个模块只产出显示用的分段，从不改写要上线的文本。
 *
 * 为什么是行级而不是通篇扫描：一条消息里四种标记可以任意混排、任意顺序，
 * 而它们各自是**块级**排版（不同字号、不同行高、元指令还要整块下沉）。
 * 行是作者敲回车时自己划出的边界，比任何猜测都准。
 */

/** 一行的排版归属。 */
export type ScriptSegmentKind = "action" | "speech" | "scene" | "meta";

/**
 * 一行内的显示片段。引号被切出来单独成 run，因为设计稿要求
 * 「引号保留但降到弱化色」——保留信息，收走视觉重量。
 */
export interface ScriptRun {
  kind: "text" | "mark";
  text: string;
}

export interface ScriptSegment {
  kind: ScriptSegmentKind;
  runs: ScriptRun[];
  /** 去掉标记后的纯文本，供摘要行、通知、复制使用。 */
  plain: string;
}

export interface ParseScriptOptions {
  /**
   * 只有**闭合**的标记才着色。输入框用 true，稿面用 false。
   *
   * 两个方向都不能反：输入框里 `「` 一打出来就整行变大变亮，会让打字过程
   * 满屏跳色（设计稿 1c 明说「未闭合的标记不着色」）；而流式回复恰恰总是
   * 处在未闭合状态——`「不办。等天亮▌` 必须当场就是台词，等到闭合再变
   * 就是每句话都跳一次。
   */
  requireClosed?: boolean;
}

const OPEN_QUOTES = ["「", "『", "“", "\""] as const;
const CLOSE_OF: Record<string, string> = {
  "「": "」",
  "『": "』",
  "“": "”",
  "\"": "\"",
};

function seg(kind: ScriptSegmentKind, runs: ScriptRun[], plain: string): ScriptSegment {
  return { kind, runs, plain };
}

/** 整行被一对标记包住时返回内部文本，否则 null。 */
function wrapped(line: string, open: string, close: string): string | null {
  if (line.length < open.length + close.length) return null;
  if (!line.startsWith(open) || !line.endsWith(close)) return null;
  const inner = line.slice(open.length, line.length - close.length);
  return inner.length > 0 ? inner : null;
}

/**
 * 单行的排版归属。
 *
 * 独立导出是因为输入框的镜像层需要**逐行**着色而不能丢空行——丢一行光标就
 * 往上跳一行。它和 {@link parseScript} 共用同一套判定，所以稿面和输入框不会
 * 对同一行给出两种答案。
 */
export function classifySegment(raw: string, opts: ParseScriptOptions = {}): ScriptSegment | null {
  const strict = opts.requireClosed ?? false;
  const line = raw.trim();
  if (!line) return null;
  return classify(line, strict);
}

/**
 * 把一条消息切成按行的排版分段。空行被丢弃——它们在稿面上由段间距表达，
 * 保留会变成一个高度不定的空块。
 */
export function parseScript(text: string, opts: ParseScriptOptions = {}): ScriptSegment[] {
  const strict = opts.requireClosed ?? false;
  const out: ScriptSegment[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    out.push(classify(line, strict));
  }

  return out;
}

function classify(line: string, strict: boolean): ScriptSegment {
  // 元指令：整块出戏，底色下沉 + 虚线左规 + META 角标（设计稿 1c）。
  const metaInner = wrapped(line, "[", "]");
  if (metaInner !== null) return seg("meta", [{ kind: "text", text: metaInner }], metaInner);
  if (!strict && line.startsWith("[") && !line.includes("]")) {
    const inner = line.slice(1);
    return seg("meta", [{ kind: "text", text: inner }], inner);
  }

  // 动作：星号本身不显示。
  const actionInner = wrapped(line, "*", "*");
  if (actionInner !== null && !actionInner.includes("*")) {
    return seg("action", [{ kind: "text", text: actionInner }], actionInner);
  }
  if (!strict && line.startsWith("*") && line.length > 1 && !line.slice(1).includes("*")) {
    const inner = line.slice(1);
    return seg("action", [{ kind: "text", text: inner }], inner);
  }

  // 台词：引号保留，降到弱化色。
  for (const open of OPEN_QUOTES) {
    const close = CLOSE_OF[open];
    const inner = wrapped(line, open, close);
    if (inner !== null) {
      return seg("speech", [
        { kind: "mark", text: open },
        { kind: "text", text: inner },
        { kind: "mark", text: close },
      ], inner);
    }
    // 流式中的半句话：开引号已经落下，闭引号还没到。
    if (!strict && line.startsWith(open) && !line.slice(open.length).includes(close)) {
      const rest = line.slice(open.length);
      return seg("speech", [
        { kind: "mark", text: open },
        { kind: "text", text: rest },
      ], rest);
    }
  }

  return seg("scene", [{ kind: "text", text: line }], line);
}

/**
 * 花名册摘要行用的一句话：取**最后**一个分段的纯文本并截断。
 *
 * 最后一段而不是第一段——一条回复常常以动作开场、以台词收尾，而作者在
 * 列表里想认出的是那句话。
 */
export function scriptPreview(text: string, cap: number): string {
  const segments = parseScript(text);
  const last = segments[segments.length - 1];
  if (!last) return "";
  const source = last.kind === "speech" || last.kind === "action"
    ? renderPreview(last)
    : last.plain;
  // 按码点截断——String#slice 数的是 UTF-16 单元，会把 emoji 切成半个代理对。
  const chars = [...source];
  return chars.length > cap ? `${chars.slice(0, cap).join("")}…` : source;
}

/** 摘要行保留标记的排版信息（台词带引号、动作带星号），设计稿 1d 的要求。 */
function renderPreview(s: ScriptSegment): string {
  if (s.kind === "speech") return s.runs.map((r) => r.text).join("");
  if (s.kind === "action") return `*${s.plain}*`;
  return s.plain;
}
