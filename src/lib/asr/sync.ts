/**
 * DashScope 同步识别：compatible-mode `POST /chat/completions`，音频以 data URL
 * 放在请求体里，一次往返拿回整段文字。没有上传、没有任务、没有轮询。
 *
 * 协议事实（2026-09-14 实测，docs/feature/asr/00-research.md §1.3 补记、
 * docs/api/landscape.md「音频走 ① 面」）：
 *
 * - user 消息里**只能有**一个 `input_audio` part；再加一个 text part 就 400
 *   「The dedicated task asr … does not support this input」（不变量 8）。
 * - 前置一条带 text part 的 `system` 消息是被接受的（上下文 / 热词），多几个
 *   text token；顶层 `asr_options: {language, enable_itn}` 也被接受。
 * - 响应 `choices[0].message.content` 是一个纯字符串：**没有时间戳，没有说话人**。
 * - ≤ 5 分钟 / ≤ 10MB，超了各有一句固定的 400 原话——在批准之前就按
 *   `formats.ts` 的上限拦，这里的改口是兜底。
 *
 * 只有 qwen3-asr-flash 一代在这条线上；别的 id 答「format is empty」。
 */

import { fetch } from "../http";
import { openaiUrl } from "../ai/urls";
import { logAsrEvent } from "../ai/apiLog";
import type { AsrRequestOptions } from "./cache";
import { AsrHttpError, type AsrConn } from "./client";
import { syncBilledSeconds } from "./result";

/** Data-URL MIME per whitelisted extension — the ones the probe sent and got right. */
const SYNC_AUDIO_MIME: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
};

/**
 * The compatible-mode base, whichever spelling the provider row holds. The
 * mirror of `dashscopeNativeBase`: this path only ever leads to DashScope
 * (`conn.ts`), and the author may have configured the native `/api/v1` base.
 */
export function dashscopeCompatBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const host = trimmed.replace(/\/compatible-mode\/v1$/, "").replace(/\/api\/v1$/, "");
  return `${host}/compatible-mode/v1`;
}

interface SyncBodyInput {
  modelId: string;
  /** The file's bytes, base64 — no `data:` prefix. */
  audioBase64: string;
  /** Lower-case extension; must be one of `SYNC_AUDIO_MIME`'s keys. */
  ext: string;
  options: AsrRequestOptions;
  /**
   * Optional context / hot words, sent as a preceding system message. Nothing
   * passes one today (hot words are PR 4, 01-execution-plan.md §6); it lives
   * here so the one place that knows the user message must stay audio-only is
   * also the one place that knows where text may go instead.
   */
  context?: string;
}

/**
 * The request body. The user message carries the audio part and **nothing
 * else** — a text part there is a 400, so any words for the model go into a
 * system message. `asr_options.language` is the first language hint.
 * Diarization / speaker count have no field on this endpoint and are dropped.
 */
export function syncBody(input: SyncBodyInput): Record<string, unknown> {
  const format = input.ext.toLowerCase();
  const mime = SYNC_AUDIO_MIME[format];
  if (!mime) throw new Error(`the synchronous transcription endpoint does not take .${format} files`);
  const messages: Record<string, unknown>[] = [];
  const context = input.context?.trim();
  if (context) messages.push({ role: "system", content: [{ type: "text", text: context }] });
  messages.push({
    role: "user",
    content: [{ type: "input_audio", input_audio: { data: `data:${mime};base64,${input.audioBase64}`, format } }],
  });
  const body: Record<string, unknown> = { model: input.modelId, messages };
  const language = input.options.languageHints?.find((h) => typeof h === "string" && h.trim());
  if (language) body.asr_options = { language: language.trim() };
  return body;
}

/**
 * The endpoint's refusals, restated as what the author can do about them. The
 * raw strings (measured) describe the symptom; the fix is on the model row.
 */
export function syncErrorOf(status: number, body: string, modelId: string): AsrHttpError {
  const rewrite = (code: string, message: string) =>
    new AsrHttpError("Transcription error", status, JSON.stringify({ code, message }));
  if (/audio is too long/i.test(body)) {
    return rewrite(
      "AudioTooLong",
      "the recording is over 5 minutes, the synchronous endpoint's limit. Bind a file-transcription (*-filetrans) " +
        "model to the 音频转写 subagent for longer recordings (Settings → 子代理).",
    );
  }
  if (/file size is too large/i.test(body)) {
    return rewrite(
      "FileTooLarge",
      "the file is over 10MB, the synchronous endpoint's limit. Bind a file-transcription (*-filetrans) model " +
        "to the 音频转写 subagent, or re-encode the file smaller.",
    );
  }
  if (/format is empty/i.test(body)) {
    return rewrite(
      "ModelNotSync",
      `the model id "${modelId}" is not a synchronous ASR model — only the qwen3-asr-flash family answers on this ` +
        `endpoint. Fix the model row under 渠道与模型: set the id to qwen3-asr-flash, or switch its 转写接口 to file transcription.`,
    );
  }
  return new AsrHttpError("Transcription error", status, body);
}

interface SyncResult {
  /** The response body as received — what the cache stores and `parseSyncTranscript` reads. */
  responseJson: string;
  billedSeconds: number | null;
}

export async function transcribeSync(
  conn: AsrConn,
  input: Omit<SyncBodyInput, "modelId">,
  signal?: AbortSignal,
): Promise<SyncResult> {
  const url = openaiUrl(dashscopeCompatBase(conn.baseUrl), "/chat/completions");
  const startedAt = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...(conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(syncBody({ ...input, modelId: conn.modelId })),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    logAsrEvent("sync", { status: res.status, model: conn.modelId, ext: input.ext, elapsedMs: Date.now() - startedAt, body: text.slice(0, 300) });
    throw syncErrorOf(res.status, text, conn.modelId);
  }
  let json: { error?: unknown; code?: string; usage?: Parameters<typeof syncBilledSeconds>[0] };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new AsrHttpError("Transcription error", res.status, text.slice(0, 400));
  }
  // 200 with an error object is an error (the `image.ts` rule).
  if (json.error || (typeof json.code === "string" && json.code)) throw syncErrorOf(200, text, conn.modelId);
  const billedSeconds = syncBilledSeconds(json.usage);
  logAsrEvent("sync", { status: res.status, model: conn.modelId, ext: input.ext, elapsedMs: Date.now() - startedAt, billedSeconds });
  return { responseJson: text, billedSeconds };
}
