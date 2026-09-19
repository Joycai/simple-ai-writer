/**
 * 音频转写（Beta）——对外只露 UI 与工具需要的名字。
 *
 * 设计与实测：docs/feature/asr/00-research.md；分片与不变量：01-execution-plan.md。
 * 客户端 / 缓存 / 解析的内部函数各自从模块导入，别从这里穿透。
 */

export { isAsrEnabled, setAsrEnabled, isAsrTimestampsEnabled, setAsrTimestampsEnabled, isAsrDiarizationDefault, setAsrDiarizationDefault } from "./flag";
export {
  ASR_AUDIO_EXTENSIONS,
  ASR_VIDEO_EXTENSIONS,
  ASR_EXT_LIST,
  ASR_DEFAULT_MODEL_ID,
  SYNC_ASR_EXTENSIONS,
  SYNC_MAX_BYTES,
  SYNC_MAX_SECONDS,
  asrIdMismatch,
  looksLikeSyncAsrModel,
  syncRefusal,
  transcribeExtOf,
  isVideoExt,
  type SyncRefusal,
} from "./formats";
export { estimateCost, formatBytes, wavDurationSeconds } from "./cost";
export { formatClock, formatDuration, transcriptToMarkdown } from "./render";
export type { Transcript, TranscriptSentence } from "./result";
export type { AsrRequestOptions } from "./cache";
export { AsrHttpError } from "./client";
export { resolveAsrConn, isAsrUnavailable, type ResolvedAsr, type AsrUnavailable } from "./conn";
export {
  transcribeFile,
  transcriptTargetFor,
  writeTranscript,
  recordTranscriptionUsage,
  pollDeadlineMs,
  speakersMissing,
  MAX_TRANSCRIBE_BYTES,
  type TranscribePhase,
  type TranscribeProgress,
  type TranscribeRequest,
  type TranscribeOutcome,
} from "./run";
