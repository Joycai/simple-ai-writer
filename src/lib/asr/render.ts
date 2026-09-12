/**
 * `Transcript` → 文字稿 markdown。纯函数。
 *
 * 形状（docs/feature/asr/00-research.md §4.5）：frontmatter 记来源 / 时间 / 模型 /
 * 时长，正文一句一段，段前 `[mm:ss]`（超一小时 `[h:mm:ss]`），开了分离再加
 * `说话人 N：`（`speaker_id` 从 0 起，展示 +1——作者数人不从零数）。
 *
 * 不写 language / emotion：只有 qwen3 一代给，而且对写作没用；词级时间戳留在
 * 缓存的原始 JSON 里，正文里不放——一段采访几千个词各带一个时间会让稿子没法读。
 */

import type { Transcript } from "./result";

interface RenderOptions {
  /** frontmatter `source:`——源文件名（不是路径，路径会随作者搬家）。 */
  source: string;
  /** frontmatter `model:`。 */
  model: string;
  /** 每段前写 `[mm:ss]`。 */
  timestamps: boolean;
  /** 每段前写「说话人 N：」；稿里本来就没有 speaker 时无效。 */
  speakers: boolean;
  /** frontmatter `transcribed:`，ISO 字符串；测试注入。 */
  transcribedAt?: string;
  /** 「说话人」的措辞，i18n 的调用方传。 */
  speakerWord?: string;
}

/** `ms` → `mm:ss`，够一小时就 `h:mm:ss`。`over` 是整份稿的时长，决定要不要显示小时位。 */
export function formatClock(ms: number, over: number = ms): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return over >= 3_600_000 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** frontmatter 里的 `duration:`——和 `formatClock` 同一种写法。 */
export function formatDuration(ms: number): string {
  return formatClock(ms, ms);
}

function yamlString(v: string): string {
  // 文件名里的冒号 / 引号 / 前导井号都会让 YAML 解析器误读；一律加双引号。
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function transcriptToMarkdown(t: Transcript, opts: RenderOptions): string {
  const head = [
    "---",
    `source: ${yamlString(opts.source)}`,
    `transcribed: ${opts.transcribedAt ?? new Date().toISOString()}`,
    `model: ${yamlString(opts.model)}`,
    `duration: ${formatDuration(t.durationMs)}`,
    "---",
    "",
  ];
  const speakerWord = opts.speakerWord ?? "说话人";
  const showSpeakers = opts.speakers && t.speakers;
  const body: string[] = [];
  for (const s of t.sentences) {
    if (!s.text) continue;
    const parts: string[] = [];
    if (opts.timestamps) parts.push(`[${formatClock(s.beginMs, t.durationMs)}]`);
    if (showSpeakers && s.speaker !== undefined) parts.push(`${speakerWord} ${s.speaker + 1}：`);
    parts.push(s.text);
    body.push(parts.join(" ").replace("： ", "："));
  }
  // frontmatter 和正文之间空一行，和导入 / 转换写出的文档一致。
  return `${head.join("\n")}\n${body.join("\n\n")}\n`;
}
