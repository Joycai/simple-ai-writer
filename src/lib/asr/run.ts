/**
 * 一次转写的编排——`lib/asr/` 里唯一既碰盘又碰网的模块。
 *
 *   读文件 → 算键 → 缓存命中？→ 拿凭证 → 上传 → 提交 → 轮询 → 取结果 JSON
 *   → 落缓存（先写 `.tmp-` 再改名，照 `lib/import/cachedConvert`）→ 解析 → 渲染
 *
 * 缓存的是**结果 JSON 本体**，不是链接：链接 24 小时失效（不变量 5）。写产物
 * 是另一个函数（`writeTranscript`），因为两个入口对"写到哪、写不写"的答案不同：
 * 右键直接写在源文件旁边，助手那条路要先过审批卡。
 *
 * 付费动作的确认不在这里：`transcribeFile` 假定调用方已经让作者点过头（不变量 4）。
 */

import {
  fileExists,
  makeDir,
  readBinaryFile,
  readDir,
  readFile,
  removeDir,
  renamePath,
  writeFile,
} from "../fs/fileio";
import { baseName, dirName } from "../paths";
import { uniqueImportPath } from "../import";
import {
  ASR_CACHE_VERSION,
  ASR_META_NAME,
  ASR_RESULT_NAME,
  cacheDirFor,
  cacheKeyOf,
  cacheRootFor,
  isUsableMeta,
  parseCacheMeta,
  planSweep,
  sha256Hex,
  type AsrCacheMeta,
  type AsrRequestOptions,
  type SweepEntry,
} from "./cache";
import {
  fetchResultJson,
  getUploadPolicy,
  pollTask,
  submitTranscription,
  uploadTemp,
  type AsrConn,
} from "./client";
import { transcribeExtOf } from "./formats";
import { parseTranscript, type Transcript } from "./result";
import { transcriptToMarkdown } from "./render";

/** 平台凭证说的上限是 1024MB；这里再收紧一点，因为整个文件要进内存做哈希和上传。 */
export const MAX_TRANSCRIBE_BYTES = 512 * 1024 * 1024;

export type TranscribePhase = "reading" | "uploading" | "queued" | "running" | "downloading";

export interface TranscribeProgress {
  phase: TranscribePhase;
  /** 轮询阶段的第几次查询。 */
  polls?: number;
  elapsedMs?: number;
}

export interface TranscribeRequest {
  projectPath: string;
  /** 工作区内的绝对路径，调用方已做包含检查。 */
  sourcePath: string;
  conn: AsrConn;
  options: AsrRequestOptions;
  onProgress?: (p: TranscribeProgress) => void;
  signal?: AbortSignal;
}

export interface TranscribeOutcome {
  transcript: Transcript;
  /** 缓存目录（结果 JSON 在里面），给需要词级时间戳的调用方。 */
  cacheDir: string;
  /** 命中缓存，没有上传也没有付费。 */
  cached: boolean;
  /** 平台报的计费秒数；命中缓存时是当初那次的。 */
  billedSeconds: number | null;
  bytes: number;
}

const swept = new Set<string>();

async function readMeta(dir: string): Promise<AsrCacheMeta | null> {
  try {
    return parseCacheMeta(await readFile(`${dir}/${ASR_META_NAME}`));
  } catch {
    return null;
  }
}

async function sweepOnce(projectPath: string, keep: string): Promise<void> {
  if (swept.has(projectPath)) return;
  swept.add(projectPath);
  try {
    const root = cacheRootFor(projectPath);
    if (!(await fileExists(root))) return;
    const entries: SweepEntry[] = [];
    for (const entry of await readDir(root)) {
      if (!entry.isDirectory) continue;
      entries.push({ name: entry.name, meta: await readMeta(entry.path) });
    }
    for (const name of planSweep(entries, Date.now(), keep)) {
      await removeDir(`${root}/${name}`).catch(() => {});
    }
  } catch {
    // 清扫失败不是拒绝转写的理由。
  }
}

async function writeMeta(dir: string, meta: AsrCacheMeta): Promise<void> {
  await writeFile(`${dir}/${ASR_META_NAME}`, JSON.stringify(meta, null, 2));
}

const MIME: Record<string, string> = {
  aac: "audio/aac", amr: "audio/amr", flac: "audio/flac", m4a: "audio/mp4", mp3: "audio/mpeg",
  ogg: "audio/ogg", opus: "audio/opus", wav: "audio/wav", wma: "audio/x-ms-wma",
  avi: "video/x-msvideo", flv: "video/x-flv", mkv: "video/x-matroska", mov: "video/quicktime",
  mp4: "video/mp4", mpeg: "video/mpeg", webm: "video/webm", wmv: "video/x-ms-wmv",
};

/**
 * 轮询的总时限：至少 10 分钟，已知时长时按时长的两倍——一小时的音频给两小时。
 * 时长未知（非 WAV）时按大小估：1MB 当一分钟（mp3 128kbps 的量级）。
 */
export function pollDeadlineMs(bytes: number, knownSeconds: number | null): number {
  const seconds = knownSeconds ?? bytes / (1024 * 1024) * 60;
  return Math.max(10 * 60_000, Math.ceil(seconds * 2) * 1000);
}

function withDeadline(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException(`The transcription timed out after ${Math.round(ms / 60_000)} min.`, "TimeoutError")),
    ms,
  );
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) ctrl.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function transcribeFile(req: TranscribeRequest): Promise<TranscribeOutcome> {
  const { projectPath, sourcePath, conn, options, onProgress } = req;
  const ext = transcribeExtOf(sourcePath);
  if (!ext) throw new Error(`"${baseName(sourcePath)}" is not an audio or video file this tool can transcribe`);

  onProgress?.({ phase: "reading" });
  const bytes = await readBinaryFile(sourcePath);
  if (bytes.byteLength === 0) throw new Error(`"${baseName(sourcePath)}" is empty`);
  if (bytes.byteLength > MAX_TRANSCRIBE_BYTES) {
    throw new Error(
      `file is ${(bytes.byteLength / 1024 / 1024).toFixed(0)}MB — over the ${MAX_TRANSCRIBE_BYTES / 1024 / 1024}MB transcription limit`,
    );
  }
  const key = cacheKeyOf(await sha256Hex(bytes), conn.modelId, options);
  const dir = cacheDirFor(projectPath, key);
  await sweepOnce(projectPath, key);

  const existing = await readMeta(dir);
  if (isUsableMeta(existing, conn.modelId)) {
    try {
      const transcript = parseTranscript(await readFile(`${dir}/${ASR_RESULT_NAME}`));
      void writeMeta(dir, { ...existing, lastUsedAt: Date.now() }).catch(() => {});
      return { transcript, cacheDir: dir, cached: true, billedSeconds: existing.billedSeconds, bytes: bytes.byteLength };
    } catch {
      // sidecar 在、结果不在或坏了：当没命中，重跑。
    }
  }

  const deadline = withDeadline(req.signal, pollDeadlineMs(bytes.byteLength, null));
  let resultJson: string;
  let billedSeconds: number | null;
  try {
    onProgress?.({ phase: "uploading" });
    const policy = await getUploadPolicy(conn, deadline.signal);
    const ossUrl = await uploadTemp(policy, bytes, baseName(sourcePath), MIME[ext] ?? "application/octet-stream", deadline.signal);
    const taskId = await submitTranscription(conn, ossUrl, options, deadline.signal);
    onProgress?.({ phase: "queued", polls: 0, elapsedMs: 0 });
    const polled = await pollTask(
      conn,
      taskId,
      (p) => onProgress?.({ phase: p.phase, polls: p.polls, elapsedMs: p.elapsedMs }),
      deadline.signal,
    );
    onProgress?.({ phase: "downloading" });
    resultJson = await fetchResultJson(polled.transcriptionUrl, deadline.signal);
    billedSeconds = polled.billedSeconds;
  } finally {
    deadline.done();
  }

  // 先解析再落盘：解析不出来的结果不值得缓存——下次命中它只会再失败一次。
  const transcript = parseTranscript(resultJson);
  const now = Date.now();
  const meta: AsrCacheMeta = {
    source: sourcePath,
    bytes: bytes.byteLength,
    model: conn.modelId,
    options,
    billedSeconds,
    transcribedAt: now,
    lastUsedAt: now,
    version: ASR_CACHE_VERSION,
  };
  const tmp = `${dir}.tmp-${Math.random().toString(36).slice(2, 8)}`;
  await makeDir(tmp);
  await writeFile(`${tmp}/${ASR_RESULT_NAME}`, resultJson);
  await writeMeta(tmp, meta);
  if (await fileExists(dir)) {
    await removeDir(tmp).catch(() => {});
  } else {
    try {
      await renamePath(tmp, dir);
    } catch (e) {
      await removeDir(tmp).catch(() => {});
      if (!(await fileExists(dir))) throw e;
    }
  }
  return { transcript, cacheDir: dir, cached: false, billedSeconds, bytes: bytes.byteLength };
}

/** 产物落点：源文件旁边的 `<stem>.md`；已存在就编号，绝不覆盖。 */
export async function transcriptTargetFor(sourcePath: string): Promise<string> {
  const name = baseName(sourcePath);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return uniqueImportPath(dirName(sourcePath), `${stem}.md`);
}

export interface WriteTranscriptOptions {
  modelId: string;
  timestamps: boolean;
  speakers: boolean;
  speakerWord?: string;
}

/** 渲染并写盘，返回实际写到的路径。 */
export async function writeTranscript(
  sourcePath: string,
  transcript: Transcript,
  opts: WriteTranscriptOptions,
): Promise<string> {
  const target = await transcriptTargetFor(sourcePath);
  const markdown = transcriptToMarkdown(transcript, {
    source: baseName(sourcePath),
    model: opts.modelId,
    timestamps: opts.timestamps,
    speakers: opts.speakers,
    ...(opts.speakerWord ? { speakerWord: opts.speakerWord } : {}),
  });
  await writeFile(target, markdown);
  return target;
}

/**
 * 把一次转写记进 `token_usage`：按秒 × 模型行的每秒单价，token 两列为 0，任务名
 * `asr`。命中缓存的那次没付钱，不记；没填单价记不了，返回 null——用量页那一列
 * 就少这一笔，确认卡上的估价格已经提前说过这件事。
 *
 * 两个入口（右键 / `transcribe_audio` 的 apply）都走这里，账才只有一种算法。
 * 已知的账目不一致：这一列叫 `cost_usd`，而 DashScope 按人民币计——记进去的
 * 是 ¥ 数（02-ui-brief.md「设计稿改了方案的三处」第 2 条）。
 */
export async function recordTranscriptionUsage(
  projectPath: string,
  model: { id: string; pricePerSecond?: number },
  outcome: TranscribeOutcome,
): Promise<number | null> {
  if (outcome.cached || outcome.billedSeconds === null || model.pricePerSecond === undefined) return null;
  const cost = outcome.billedSeconds * model.pricePerSecond;
  const { persistUsage } = await import("../ai/usage");
  await persistUsage(projectPath, model.id, 0, 0, cost, "asr");
  return cost;
}
