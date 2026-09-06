/**
 * 把 DashScope 录音文件识别的两代结果归一成一个 `Transcript`。纯函数，不碰盘不碰网。
 *
 * 同一个端点、两代模型、两种形状（docs/api/qianwen-compat-plan.md §1.4，实测）：
 *
 * - `qwen3-asr-flash-filetrans`：轮询成功时链接在 `output.result.transcription_url`；
 *   结果 JSON 顶层 `audio_info{format, sample_rate}`，句 `sentence_id` 从 0 起，带
 *   `language` / `emotion`，词级只在 `enable_words` 时给。
 * - `qwen-audio-3.0-asr-flash-filetrans`（默认模型）：链接在 `output.output.transcription_url`
 *   （`output.output.results[0]` 也有一份）；结果 JSON 是 Fun-ASR 格式——
 *   `properties{audio_format, original_sampling_rate, original_duration_in_milliseconds}`，
 *   句 `sentence_id` 从 1 起，开了分离带 `speaker_id`，没有 language / emotion。
 *
 * 两处都找、两种都认，而不是按模型 id 分支：分支的判据（模型 id）是作者在抽屉里
 * 手打的自由文本，而形状本身就是自描述的。哪天平台把 qwen3 也改成 `output.output`
 * 这里不用动。
 */

export interface TranscriptSentence {
  beginMs: number;
  endMs: number;
  text: string;
  /** 从 0 起的说话人索引；只在开了说话人分离时有。 */
  speaker?: number;
  language?: string;
  emotion?: string;
}

export interface Transcript {
  /** "mp3" / "wav"…，平台报的。 */
  format?: string;
  sampleRate?: number;
  /** 平台报了原始时长就用它，否则取最后一句的 `endMs`。 */
  durationMs: number;
  /** 任何一句带 `speaker` 就是 true。 */
  speakers: boolean;
  sentences: TranscriptSentence[];
}

export type TaskStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";

/** `GET /tasks/{id}` 的 `output`——只声明会读的字段。 */
export interface TaskOutput {
  task_id?: string;
  task_status?: string;
  code?: string;
  message?: string;
  result?: { transcription_url?: string };
  output?: {
    transcription_url?: string;
    results?: { transcription_url?: string; subtask_status?: string; code?: string; message?: string }[];
  };
}

export function taskStatusOf(output: TaskOutput | undefined): TaskStatus {
  const s = output?.task_status;
  return s === "PENDING" || s === "RUNNING" || s === "SUCCEEDED" || s === "FAILED" ? s : "UNKNOWN";
}

/** 成功任务的结果链接，两代位置都找；找不到 null。 */
export function transcriptionUrlOf(output: TaskOutput | undefined): string | null {
  if (!output) return null;
  const direct = output.result?.transcription_url;
  if (typeof direct === "string" && direct) return direct;
  const nested = output.output?.transcription_url;
  if (typeof nested === "string" && nested) return nested;
  const sub = output.output?.results?.find((r) => typeof r?.transcription_url === "string" && r.transcription_url);
  return sub?.transcription_url ?? null;
}

/**
 * 失败任务的 code + message，拼成一句能落进错误的话。
 *
 * `SERVER_ERROR` 这种没有 message 的：实测它就是 `oss://` 没解析（漏了
 * `X-DashScope-OssResourceResolve` 头）时的样子，所以把这条线索附上——否则
 * 作者拿到的是一个什么都没说的四个字。
 */
export function taskFailureOf(output: TaskOutput | undefined): string {
  const code = output?.code ?? output?.output?.results?.[0]?.code ?? "UNKNOWN";
  const message = output?.message ?? output?.output?.results?.[0]?.message;
  let text = message && message !== code ? `${code}: ${message}` : code;
  if (code === "FILE_DOWNLOAD_FAILED" || code === "SERVER_ERROR") {
    text += " (the service could not read the uploaded file — an oss:// URL sent without the resolve header looks exactly like this)";
  }
  return text;
}

// ─── 结果 JSON ────────────────────────────────────────────────────────────────

interface RawWord { text?: string; punctuation?: string }
interface RawSentence {
  sentence_id?: number;
  begin_time?: number;
  end_time?: number;
  text?: string;
  speaker_id?: number;
  language?: string;
  emotion?: string;
  words?: RawWord[];
}
interface RawTranscriptFile {
  audio_info?: { format?: string; sample_rate?: number };
  properties?: {
    audio_format?: string;
    original_sampling_rate?: number;
    original_duration_in_milliseconds?: number;
  };
  transcripts?: { channel_id?: number; text?: string; sentences?: RawSentence[] }[];
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 解析结果 JSON（字符串或已解析对象）。多音轨时只取第一条——请求里
 * `channel_id: [0]` 也只要了第一条，每条音轨单独计费。
 *
 * 解析不出来抛错，而不是回一份空稿：一份空的文字稿会被当成"这段录音没说话"
 * 写进项目。
 */
export function parseTranscript(raw: string | unknown): Transcript {
  let json: unknown = raw;
  if (typeof raw === "string") {
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error("transcription result is not JSON");
    }
  }
  if (!json || typeof json !== "object") throw new Error("transcription result is not an object");
  const file = json as RawTranscriptFile;
  const track = file.transcripts?.[0];
  if (!track) throw new Error("transcription result carries no transcripts[]");

  const sentences: TranscriptSentence[] = [];
  let speakers = false;
  for (const s of track.sentences ?? []) {
    const text = (s.text ?? "").trim();
    if (!text) continue;
    const beginMs = num(s.begin_time) ?? 0;
    const endMs = Math.max(beginMs, num(s.end_time) ?? beginMs);
    const speaker = num(s.speaker_id);
    if (speaker !== undefined) speakers = true;
    sentences.push({
      beginMs,
      endMs,
      text,
      ...(speaker !== undefined ? { speaker } : {}),
      ...(s.language ? { language: s.language } : {}),
      ...(s.emotion ? { emotion: s.emotion } : {}),
    });
  }
  sentences.sort((a, b) => a.beginMs - b.beginMs);

  const reported = num(file.properties?.original_duration_in_milliseconds);
  const last = sentences.length ? sentences[sentences.length - 1].endMs : 0;
  const format = file.properties?.audio_format ?? file.audio_info?.format;
  const sampleRate = num(file.properties?.original_sampling_rate) ?? num(file.audio_info?.sample_rate);
  return {
    ...(format ? { format } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    durationMs: reported ?? last,
    speakers,
    sentences,
  };
}
