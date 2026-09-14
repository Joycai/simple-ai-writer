/**
 * 哪些文件能送去转写——按扩展名，和 `lib/fs/images` 判图片 / 文本是同一种判法。
 *
 * 住在这里而不是 `lib/fs/images`：那边的 `ProjectFileKind` 的含义是"能发给助手
 * 当附件"，而音频发不了（没有模型 API 收它，见 docs/feature/asr/00-research.md
 * §1.2）；把音频塞进那根轴会让 `@` 选择器和 `classifyProjectFile` 各开一个例外。
 * 这份清单只回答一个问题：这个文件**能不能转写**。
 *
 * 十七个格式来自平台的「非实时」音频规格表（研究稿 §1.1）：视频容器直接吃，
 * 服务端自己抽音轨。`pcm` 不在里面——它要求 16 kHz 且文件头里没有采样率，
 * 作者没法知道自己那份对不对，猜错的结果是一份全是噪音的文字稿。
 *
 * 同步接口（`dashscope-sync`）另有一份更窄的清单和两条上限，也住这里：批准之前
 * 的两个入口（`tool.ts` / 文件树确认条）和设置面板都要用，而它们都是纯判断。
 */

import type { AsrFormat } from "../ai/configDb";

export const ASR_AUDIO_EXTENSIONS: readonly string[] =
  ["aac", "amr", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"];

export const ASR_VIDEO_EXTENSIONS: readonly string[] =
  ["avi", "flv", "mkv", "mov", "mp4", "mpeg", "webm", "wmv"];

const ALL = new Set([...ASR_AUDIO_EXTENSIONS, ...ASR_VIDEO_EXTENSIONS]);

/** 转写工具拒绝时报给模型看的清单。 */
export const ASR_EXT_LIST = [...ALL].join(", ");

/** 小写扩展名（不带点），不能转写就 null。`path` 可以是完整路径也可以只是文件名。 */
export function transcribeExtOf(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return ALL.has(ext) ? ext : null;
}

/**
 * 录音文件识别接口只认 `*-filetrans` 模型。实测（docs/api/qianwen-compat-plan.md
 * §1.4）：对话模型、甚至同步版的 `qwen3-asr-flash` / `qwen-audio-3.0-asr-flash`，
 * 取凭证和上传都成功，提交时一律 400「url error」——在上传之前拦下来，省一次上传，
 * 也省作者去检查一个没错的文件路径。命名规则是 DashScope 的，不是我们的；哪天它
 * 改了，改这里。住在这个纯模块里，设置面板和测试都能直接用。
 */
export function looksLikeFiletransModel(modelId: string): boolean {
  return /filetrans/i.test(modelId);
}

/**
 * Does this id answer on the synchronous endpoint (compatible-mode
 * `/chat/completions` with an `input_audio` part)? Measured 2026-09-14: only the
 * qwen3-asr-flash family — the alias and its dated snapshots. `qwen-audio-3.0-asr-flash`
 * and `fun-asr-flash-*` on the same body answer 400 "format is empty"; `*-filetrans`
 * ids belong to the async endpoint and `*-realtime` ids to the WebSocket one.
 */
export function looksLikeSyncAsrModel(modelId: string): boolean {
  return /qwen3-asr-flash/i.test(modelId) && !/filetrans|realtime/i.test(modelId);
}

/** Why a row's id cannot be served by the endpoint its format names; null = it can. */
type AsrIdMismatch = "not-filetrans" | "not-sync";

export function asrIdMismatch(format: AsrFormat, modelId: string): AsrIdMismatch | null {
  if (format === "dashscope-sync") return looksLikeSyncAsrModel(modelId) ? null : "not-sync";
  return looksLikeFiletransModel(modelId) ? null : "not-filetrans";
}

/** The id the drawer pre-fills for each endpoint. */
export const ASR_DEFAULT_MODEL_ID: Readonly<Record<AsrFormat, string>> = {
  "dashscope-filetrans": "qwen-audio-3.0-asr-flash-filetrans",
  "dashscope-sync": "qwen3-asr-flash",
};

/**
 * Extensions the synchronous endpoint was measured to transcribe correctly
 * (2026-09-14: wav, mp3, m4a, ogg, flac — and mp4, whose audio track it reads).
 * Narrower than the filetrans list on purpose: a format we never sent there
 * would be a paid guess.
 */
export const SYNC_ASR_EXTENSIONS: readonly string[] = ["wav", "mp3", "m4a", "ogg", "flac", "mp4"];

/**
 * The synchronous endpoint's size ceiling. Documented as ≤10MB; measured
 * 2026-09-14 a 13MB wav answers 400 "Multimodal file size is too large".
 * Checked against the file's real size, before approval.
 */
export const SYNC_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The synchronous endpoint's duration ceiling. Documented as ≤5 min; measured
 * 2026-09-14 a 286s mp3 transcribes and a 330s one answers 400 "The audio is too
 * long". The duration is read from the container before approval
 * (`duration.ts`: WAV / MP3 / FLAC / Ogg / MP4 family); an unknown one is let
 * through and the endpoint's 400 is reworded (`sync.ts`).
 */
export const SYNC_MAX_SECONDS = 300;

export type SyncRefusal =
  | { reason: "ext"; ext: string }
  | { reason: "bytes"; bytes: number }
  | { reason: "seconds"; seconds: number };

/**
 * The pre-approval check for a synchronous row: what is knowable without reading
 * the file (extension, real size, the container's duration when it can be read). A file the endpoint
 * would refuse must be refused here, where nothing has been sent yet.
 */
export function syncRefusal(ext: string, bytes: number, seconds: number | null): SyncRefusal | null {
  const e = ext.toLowerCase();
  if (!SYNC_ASR_EXTENSIONS.includes(e)) return { reason: "ext", ext: e };
  if (bytes > SYNC_MAX_BYTES) return { reason: "bytes", bytes };
  if (seconds !== null && seconds > SYNC_MAX_SECONDS) return { reason: "seconds", seconds };
  return null;
}

/**
 * The refusal as the tail of an English sentence about the file — for the
 * model (`tool.ts`) and for the error `transcribeFile` throws. The UI words it
 * in the locale files instead.
 */
export function syncRefusalText(r: SyncRefusal): string {
  switch (r.reason) {
    case "ext":
      return `is a .${r.ext} file, which the synchronous transcription endpoint does not take (it takes ${SYNC_ASR_EXTENSIONS.join(", ")})`;
    case "bytes":
      return `is ${(r.bytes / 1024 / 1024).toFixed(1)}MB, over the synchronous transcription endpoint's ${SYNC_MAX_BYTES / 1024 / 1024}MB limit`;
    case "seconds":
      return `is ${Math.round(r.seconds)} seconds long, over the synchronous transcription endpoint's ${SYNC_MAX_SECONDS / 60}-minute limit`;
  }
}

/** 视频容器？（只影响确认卡上的措辞：「会抽取音轨」。） */
export function isVideoExt(ext: string): boolean {
  return ASR_VIDEO_EXTENSIONS.includes(ext.toLowerCase());
}
