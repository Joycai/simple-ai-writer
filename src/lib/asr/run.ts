/**
 * 一次转写的编排——`lib/asr/` 里唯一既碰盘又碰网的模块。
 *
 *   读文件 → 算键 → 缓存命中？→ 拿凭证 → 上传 → 提交 → 轮询 → 取结果 JSON
 *   → 落缓存（先写 `.tmp-` 再改名，照 `lib/import/cachedConvert`）→ 解析 → 渲染
 *
 * 同步接口（`conn.format === "dashscope-sync"`）是另一条腿：先按文件头查上限 →
 * 读文件 → 算键 → 缓存命中？→ 一次 `/chat/completions` → 落缓存（存的是响应本体）
 * → 解析。没有上传、没有轮询；缓存、sidecar、落盘规矩和上面完全一样。
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
  readFileHead,
  readFileRange,
  removeDir,
  removeFile,
  renamePath,
  toBase64,
  writeFile,
} from "../fs/fileio";
import type { AsrFormat, Model } from "../ai/configDb";
import { baseName, dirName } from "../paths";
import { uniqueImportPath } from "../import";
import { probeDurationSeconds } from "./duration";
import { transcribeSync } from "./sync";
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
  AsrHttpError,
  fetchResultJson,
  getUploadPolicy,
  pollTask,
  submitTranscription,
  uploadTemp,
  type AsrConn,
} from "./client";
import { syncRefusal, syncRefusalText, transcribeExtOf } from "./formats";
import { parseSyncTranscript, parseTranscript, type Transcript } from "./result";
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
      if (!entry.isDirectory) {
        // A checkpoint whose task the platform has let go (or that no longer
        // reads): nothing can resume it, and nothing else would remove it.
        if (entry.name.endsWith(PENDING_SUFFIX) && entry.name !== `${keep}${PENDING_SUFFIX}` && !(await pendingIsLive(entry.path))) {
          await removeFile(entry.path).catch(() => {});
        }
        continue;
      }
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

/**
 * The filetrans checkpoint: a submitted task's id, written the moment the
 * submit returns and removed once its result is in the cache.
 *
 * Submitting is the billed step. Without this, anything that stopped the run
 * after it — 停止, the poll deadline, a crash, a 401 after the key rotated —
 * left a paid task running on the platform with nobody to collect it, and the
 * rerun uploaded and paid again (坑 121). A rerun of the same file, model and
 * options now polls the task it already paid for.
 *
 * A sibling file of the cache directory, not a file in it: the directory only
 * exists once a result has landed (it is renamed into place whole), and the
 * sweep's cache pass only looks at directories. Older than the platform keeps
 * a task, it is ignored by a rerun and removed by the sweep.
 */
interface PendingTask {
  taskId: string;
  model: string;
  submittedAt: number;
}

/** DashScope keeps a task (and its result link) for 24 hours. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const PENDING_SUFFIX = ".pending.json";
const pendingPathFor = (dir: string) => `${dir}${PENDING_SUFFIX}`;

async function readPendingFile(path: string): Promise<PendingTask | null> {
  try {
    const raw = JSON.parse(await readFile(path)) as Partial<PendingTask>;
    if (typeof raw.taskId !== "string" || typeof raw.model !== "string" || typeof raw.submittedAt !== "number") return null;
    return Date.now() - raw.submittedAt < PENDING_TTL_MS ? (raw as PendingTask) : null;
  } catch {
    return null;
  }
}

async function readPending(dir: string, modelId: string): Promise<PendingTask | null> {
  const pending = await readPendingFile(pendingPathFor(dir));
  return pending?.model === modelId ? pending : null;
}

/** Still inside the platform's keep window — the sweep leaves it for a rerun to resume. */
async function pendingIsLive(path: string): Promise<boolean> {
  return (await readPendingFile(path)) !== null;
}

async function dropPending(dir: string): Promise<void> {
  try {
    await removeFile(pendingPathFor(dir));
  } catch {
    // Absent, or already gone — either way nothing to resume.
  }
}

/** A task the platform has no more: gone (404) or settled as failed. Its checkpoint is worthless. */
function taskIsGone(e: unknown): boolean {
  return e instanceof AsrHttpError && (e.status === 404 || (e.status === 200 && e.message.startsWith("Transcription failed")));
}

/** A synchronous request carries the whole file; 43s was the slowest measured. Five minutes is "the endpoint is gone". */
const SYNC_DEADLINE_MS = 5 * 60_000;

/** The two result files have different shapes; the endpoint that wrote one says which parser reads it. */
function parseResult(format: AsrFormat, json: string): Transcript {
  return format === "dashscope-sync" ? parseSyncTranscript(json) : parseTranscript(json);
}

/**
 * What the synchronous endpoint can use of the request options: language hints
 * only. Normalised *before* the cache key, so flipping the diarization switch
 * on a sync row neither changes the result nor pays for a second copy of it.
 */
function effectiveOptions(format: AsrFormat, options: AsrRequestOptions): AsrRequestOptions {
  if (format !== "dashscope-sync") return options;
  return { diarization: false, ...(options.languageHints?.length ? { languageHints: options.languageHints } : {}) };
}

export async function transcribeFile(req: TranscribeRequest): Promise<TranscribeOutcome> {
  const { projectPath, sourcePath, conn, onProgress } = req;
  const format: AsrFormat = conn.format ?? "dashscope-filetrans";
  const sync = format === "dashscope-sync";
  const options = effectiveOptions(format, req.options);
  const ext = transcribeExtOf(sourcePath);
  if (!ext) throw new Error(`"${baseName(sourcePath)}" is not an audio or video file this tool can transcribe`);

  onProgress?.({ phase: "reading" });
  if (sync) {
    // Both entry points refused an over-limit file before approval (不变量 7);
    // this is the backstop, and it still runs before the bytes cross IPC and
    // before a request the endpoint would 400 — the file may have changed
    // between the card and the click.
    const head = await readFileHead(sourcePath, 64 * 1024);
    const seconds = await probeDurationSeconds(ext, head, (offset, length) => readFileRange(sourcePath, offset, length));
    const refusal = syncRefusal(ext, head.size, seconds);
    if (refusal) throw new Error(`"${baseName(sourcePath)}" ${syncRefusalText(refusal)}`);
  }
  const bytes = await readBinaryFile(sourcePath);
  if (bytes.byteLength === 0) throw new Error(`"${baseName(sourcePath)}" is empty`);
  if (bytes.byteLength > MAX_TRANSCRIBE_BYTES) {
    throw new Error(
      `file is ${(bytes.byteLength / 1024 / 1024).toFixed(0)}MB — over the ${MAX_TRANSCRIBE_BYTES / 1024 / 1024}MB transcription limit`,
    );
  }
  const key = cacheKeyOf(await sha256Hex(bytes), conn.modelId, options, format);
  const dir = cacheDirFor(projectPath, key);
  await sweepOnce(projectPath, key);

  const existing = await readMeta(dir);
  if (isUsableMeta(existing, conn.modelId, format)) {
    try {
      const transcript = parseResult(format, await readFile(`${dir}/${ASR_RESULT_NAME}`));
      void writeMeta(dir, { ...existing, lastUsedAt: Date.now() }).catch(() => {});
      return { transcript, cacheDir: dir, cached: true, billedSeconds: existing.billedSeconds, bytes: bytes.byteLength };
    } catch {
      // sidecar 在、结果不在或坏了：当没命中，重跑。
    }
  }

  let resultJson: string;
  let billedSeconds: number | null;
  if (sync) {
    const deadline = withDeadline(req.signal, SYNC_DEADLINE_MS);
    try {
      // No upload and no queue: the one request *is* the recognition.
      onProgress?.({ phase: "running" });
      const result = await transcribeSync(conn, { audioBase64: toBase64(bytes), ext, options }, deadline.signal);
      resultJson = result.responseJson;
      billedSeconds = result.billedSeconds;
    } finally {
      deadline.done();
    }
  } else {
    const deadline = withDeadline(req.signal, pollDeadlineMs(bytes.byteLength, null));
    try {
      const submit = async (): Promise<string> => {
        onProgress?.({ phase: "uploading" });
        const policy = await getUploadPolicy(conn, deadline.signal);
        const ossUrl = await uploadTemp(policy, bytes, baseName(sourcePath), MIME[ext] ?? "application/octet-stream", deadline.signal);
        const id = await submitTranscription(conn, ossUrl, options, deadline.signal);
        // Written before the first poll: from here on the task is paid for.
        const pending: PendingTask = { taskId: id, model: conn.modelId, submittedAt: Date.now() };
        await writeFile(pendingPathFor(dir), JSON.stringify(pending)).catch(() => {});
        return id;
      };
      const poll = (id: string) => {
        onProgress?.({ phase: "queued", polls: 0, elapsedMs: 0 });
        return pollTask(
          conn,
          id,
          (p) => onProgress?.({ phase: p.phase, polls: p.polls, elapsedMs: p.elapsedMs }),
          deadline.signal,
        );
      };
      const resumed = await readPending(dir, conn.modelId);
      let polled;
      try {
        polled = await poll(resumed?.taskId ?? (await submit()));
      } catch (e) {
        if (!taskIsGone(e)) throw e; // keep the checkpoint: a rerun resumes this task
        await dropPending(dir);
        // The checkpoint pointed at a task the platform no longer has — the
        // author approved one transcription, and this is the first real one.
        if (!resumed) throw e;
        polled = await poll(await submit());
      }
      onProgress?.({ phase: "downloading" });
      resultJson = await fetchResultJson(polled.transcriptionUrl, deadline.signal);
      billedSeconds = polled.billedSeconds;
    } finally {
      deadline.done();
    }
  }

  // 先解析再落盘：解析不出来的结果不值得缓存——下次命中它只会再失败一次。
  const transcript = parseResult(format, resultJson);
  const now = Date.now();
  const meta: AsrCacheMeta = {
    source: sourcePath,
    bytes: bytes.byteLength,
    model: conn.modelId,
    format,
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
  if (!sync) await dropPending(dir);
  return { transcript, cacheDir: dir, cached: false, billedSeconds, bytes: bytes.byteLength };
}

/**
 * 要了说话人分离，结果里却一个编号都没有（坑 115）。
 *
 * 分离真的生效时，哪怕只有一个人说话也带 `speaker_id`（0 号），所以「一句都没有」
 * 只能是端点把开关静默丢了——百炼的同步接口就这样，文档还写着支持。请求照常 200，
 * 不报错；但作者要的那一列没有，得告诉他，而不是交出一份看起来正常的稿子。
 */
export function speakersMissing(requested: boolean, transcript: Transcript): boolean {
  return requested && !transcript.speakers && transcript.sentences.length > 0;
}

/** 产物落点：源文件旁边的 `<stem>.md`；已存在就编号，绝不覆盖。 */
export async function transcriptTargetFor(sourcePath: string): Promise<string> {
  const name = baseName(sourcePath);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return uniqueImportPath(dirName(sourcePath), `${stem}.md`);
}

interface WriteTranscriptOptions {
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
 * 把一次转写记进用量。
 *
 * 单价不再在模型行上：转写模型绑一个**按秒**的计费组，秒数交上去由档位表
 * 定单价（`lib/ai/feeGroup`）。命中缓存的那次没付钱，不记；没绑组或表里
 * 没有能匹配的档位时照样记一行（量在、钱是 0），用量页会把它标成「未覆盖」
 * ——比悄悄不记强：不记的那一笔，作者永远不知道自己漏了什么。
 *
 * 两个入口（右键 / `transcribe_audio` 的 apply）都走这里，账才只有一种算法。
 * 已知的账目不一致：金额那一列叫 `cost_usd`，而 DashScope 按人民币计——
 * 记进去的是 ¥ 数（02-ui-brief.md「设计稿改了方案的三处」第 2 条）。
 */
export async function recordTranscriptionUsage(
  projectPath: string,
  model: Pick<Model, "id" | "fee">,
  outcome: TranscribeOutcome,
): Promise<number | null> {
  if (outcome.cached || outcome.billedSeconds === null) return null;
  const { recordUsage } = await import("../ai/usageRow");
  const { buildUsageRow } = await import("../ai/usageRow");
  const input = {
    model,
    task: "asr",
    outputUnits: outcome.billedSeconds,
    spec: { seconds: outcome.billedSeconds },
  } as const;
  await recordUsage(projectPath, input);
  // 确认卡上要显示「这次花了多少」，而那个数必须和记进库里的是同一个——
  // 重算一遍就是第二套口径。
  const cost = buildUsageRow(input).costUsd;
  return cost > 0 ? cost : null;
}
