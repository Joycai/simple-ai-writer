/**
 * DashScope 录音文件识别的 HTTP 客户端：拿上传凭证、传到临时存储、提交异步任务、
 * 轮询、取结果。每一步一个函数，`run.ts` 负责串。
 *
 * 协议事实（全部实测过，docs/api/qianwen-compat-plan.md §1.4）：
 *
 * - filetrans 接口**只收公网 URL**，本地文件必须先上传。平台的免费临时存储：
 *   `GET /uploads?action=getPolicy&model=<id>` 给一张 5 分钟有效的 OSS 表单凭证，
 *   表单 `POST {upload_host}` 后文件以 `oss://<upload_dir>/<name>` 存在 48 小时。
 * - 提交时 `file_urls` 填那个 `oss://`，**并且**要带头 `X-DashScope-OssResourceResolve: enable`。
 *   漏了这个头提交照样 200，任务在轮询里以 `FILE_DOWNLOAD_FAILED` 或跑 45 秒后
 *   `SERVER_ERROR` 收场——错误只在轮询阶段出现（不变量 3）。
 * - 凭证和模型名绑定：getPolicy 的 `model` 和提交的 `model` **是同一个变量**，
 *   写成两处字面量，错的症状和漏头一模一样（不变量 2）。
 * - 提交 200 但 body 顶层带 `code` 是错误（`image.ts` 的规矩）；轮询 `FAILED` 时
 *   code / message 在 `output` 里。
 *
 * 轮询循环和 `lib/ai/image.ts` 的 `dashscopeAsyncImage` 是同一个节奏（3s × 10 然后
 * 5s，连续 3 次网络失败才抛，一个 wall-clock deadline 盖住全程）——没有抽成共用
 * 模块，理由在 docs/feature/asr/01-execution-plan.md §0 修正。
 */

import { fetch } from "../http";
import { dashscopeNativeBase } from "../ai/image";
import { logAsrEvent } from "../ai/apiLog";
import type { AsrRequestOptions } from "./cache";
import { taskFailureOf, taskStatusOf, transcriptionUrlOf, type TaskOutput } from "./result";

export interface AsrConn {
  /** 供应商的 base（compatible-mode 或原生都行，`dashscopeNativeBase` 会归一）。 */
  baseUrl: string;
  apiKey: string;
  /** 模型 id——凭证和提交共用这一个。 */
  modelId: string;
}

/** 端点报的错，结构化的部分留给代码分支，散文留给作者看。 */
export class AsrHttpError extends Error {
  /** HTTP 状态，或 200（错误在成功的 body 里）。 */
  readonly status: number;
  readonly body: string;
  /** DashScope 的 `code`，有的话。 */
  readonly code?: string;

  constructor(label: string, status: number, body: string) {
    const parsed = parseErrorBody(body);
    super(`${label} ${status}: ${parsed.message ?? body.slice(0, 400)}`);
    this.name = "AsrHttpError";
    this.status = status;
    this.body = body;
    this.code = parsed.code;
  }
}

function parseErrorBody(body: string): { message?: string; code?: string } {
  try {
    const json = JSON.parse(body) as { code?: string; message?: string; error?: { message?: string; code?: string } | string };
    if (typeof json.error === "string") return { message: json.error };
    if (json.error) return { message: json.error.message, code: json.error.code };
    if (typeof json.code === "string" && json.code) return { message: json.message, code: json.code };
    if (typeof json.message === "string" && json.message) return { message: json.message };
  } catch {
    // 中继答 HTML 错误页的情况。
  }
  return {};
}

async function readJson(res: Response, label: string): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new AsrHttpError(label, res.status, text.slice(0, 400));
  }
}

function authHeaders(conn: AsrConn): Record<string, string> {
  return conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {};
}

// ─── 上传 ────────────────────────────────────────────────────────────────────

export interface UploadPolicy {
  upload_host: string;
  upload_dir: string;
  policy: string;
  signature: string;
  oss_access_key_id: string;
  x_oss_object_acl: string;
  x_oss_forbid_overwrite: string;
  expire_in_seconds?: number;
  max_file_size_mb?: number;
}

export async function getUploadPolicy(conn: AsrConn, signal?: AbortSignal): Promise<UploadPolicy> {
  const url = `${dashscopeNativeBase(conn.baseUrl)}/uploads?action=getPolicy&model=${encodeURIComponent(conn.modelId)}`;
  const res = await fetch(url, { headers: { ...authHeaders(conn), "Content-Type": "application/json" }, signal });
  if (!res.ok) throw new AsrHttpError("Upload policy error", res.status, await res.text());
  const json = (await readJson(res, "Upload policy error")) as { code?: string; data?: Partial<UploadPolicy> };
  if (json.code) throw new AsrHttpError("Upload policy error", 200, JSON.stringify(json));
  const d = json.data;
  const required = ["upload_host", "upload_dir", "policy", "signature", "oss_access_key_id", "x_oss_object_acl", "x_oss_forbid_overwrite"] as const;
  if (!d || required.some((k) => typeof d[k] !== "string" || !d[k])) {
    throw new AsrHttpError("Upload policy error", 200, JSON.stringify(json).slice(0, 400));
  }
  logAsrEvent("policy", { model: conn.modelId, uploadHost: d.upload_host, uploadDir: d.upload_dir, maxFileSizeMb: d.max_file_size_mb });
  return d as UploadPolicy;
}

/**
 * OSS 表单上传的字段——**顺序有意义**：`file` 必须是最后一个字段，OSS 在读到它
 * 之后就不再看其余字段。独立成纯函数是为了把这个顺序钉在测试里。
 */
export function uploadFormFields(policy: UploadPolicy, key: string): [string, string][] {
  return [
    ["OSSAccessKeyId", policy.oss_access_key_id],
    ["Signature", policy.signature],
    ["policy", policy.policy],
    ["x-oss-object-acl", policy.x_oss_object_acl],
    ["x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite],
    ["key", key],
    ["success_action_status", "200"],
  ];
}

/** 对象键 = `upload_dir/文件名`。文件名里的路径分隔符去掉，别的字符 OSS 都收。 */
export function uploadKeyFor(policy: UploadPolicy, fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() || "audio";
  return `${policy.upload_dir}/${name}`;
}

/**
 * 传到临时存储，返回 `oss://` URL。
 *
 * `FormData` + `Blob`，**不要手设 Content-Type**——boundary 由 fetch 自己生成
 * （`image.ts` 的 `uploadComfyImage` 同一条规矩）。走 Rust 侧的 fetch，OSS 的
 * 跨域限制碰不到。
 */
export async function uploadTemp(
  policy: UploadPolicy,
  bytes: Uint8Array,
  fileName: string,
  mime: string,
  signal?: AbortSignal,
): Promise<string> {
  const key = uploadKeyFor(policy, fileName);
  const form = new FormData();
  for (const [k, v] of uploadFormFields(policy, key)) form.append(k, v);
  form.append("file", new Blob([bytes as BlobPart], { type: mime }), key.split("/").pop());
  const res = await fetch(policy.upload_host, { method: "POST", body: form, signal });
  if (!res.ok) {
    const body = await res.text();
    logAsrEvent("upload", { status: res.status, key, bytes: bytes.byteLength, body: body.slice(0, 300) });
    throw new AsrHttpError("Upload error", res.status, body);
  }
  logAsrEvent("upload", { status: res.status, key, bytes: bytes.byteLength });
  return `oss://${key}`;
}

// ─── 提交 ────────────────────────────────────────────────────────────────────

/** 提交请求的 body——两代 filetrans 模型各读一种 URL 字段，所以两种都发（见函数末尾）。 */
export function submitBody(modelId: string, fileUrl: string, options: AsrRequestOptions): Record<string, unknown> {
  const parameters: Record<string, unknown> = { channel_id: [0] };
  if (options.languageHints?.length) parameters.language_hints = options.languageHints.slice(0, 4);
  if (options.diarization) {
    parameters.diarization_enabled = true;
    if (options.speakerCount && options.speakerCount >= 2) parameters.speaker_count = Math.min(100, Math.floor(options.speakerCount));
  }
  // BOTH spellings, every time. The two filetrans generations read different
  // fields — qwen-audio-3.0 documents `file_urls[]`, qwen3 reads `file_url` and
  // ignores the array: sent only the array it accepts the submit (200) and
  // then fails the task with `InvalidParameter.MalformedURL: A valid file URL
  // is required` (真机 2026-09-06). Each ignores the one it does not read, so
  // sending both is the one body that works on either (docs/api/qianwen-compat-plan.md §1.4).
  return { model: modelId, input: { file_url: fileUrl, file_urls: [fileUrl] }, parameters };
}

/** 提交请求的头：异步标记恒有，resolve 头**只跟着 `oss://` 走**。 */
export function submitHeaders(conn: AsrConn, fileUrl: string): Record<string, string> {
  return {
    ...authHeaders(conn),
    "Content-Type": "application/json",
    "X-DashScope-Async": "enable",
    ...(fileUrl.startsWith("oss://") ? { "X-DashScope-OssResourceResolve": "enable" } : {}),
  };
}

export async function submitTranscription(
  conn: AsrConn,
  fileUrl: string,
  options: AsrRequestOptions,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${dashscopeNativeBase(conn.baseUrl)}/services/audio/asr/transcription`, {
    method: "POST",
    headers: submitHeaders(conn, fileUrl),
    body: JSON.stringify(submitBody(conn.modelId, fileUrl, options)),
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    logAsrEvent("submit", { status: res.status, model: conn.modelId, fileUrl, body: body.slice(0, 300) });
    // 实测（docs/api/qianwen-compat-plan.md §1.4）：凡是不带 `-filetrans` 的模型 id——
    // 对话模型、甚至同步版的 qwen-audio-3.0-asr-flash——提交到这个接口都答同一句
    // 「url error, please check url」，而取凭证和上传对任何模型名都成功。平台的错误码
    // 文档把它列为「模型名称与 API 端点不匹配」。原话会把作者引去检查一个没错的
    // 文件路径，所以这里改口说真正的原因。
    if (res.status === 400 && /url error/i.test(body)) {
      throw new AsrHttpError(
        "Transcription submit error",
        400,
        JSON.stringify({
          code: "ModelNotFiletrans",
          message:
            `the model id "${conn.modelId}" is not a file-transcription model — the endpoint answers "url error" ` +
            `to a model/endpoint mismatch. The id must be a *-filetrans model (e.g. qwen-audio-3.0-asr-flash-filetrans); ` +
            `fix the model row under 供应商与模型. The upload itself succeeded.`,
        }),
      );
    }
    throw new AsrHttpError("Transcription submit error", res.status, body);
  }
  const json = (await readJson(res, "Transcription submit error")) as { code?: string; output?: TaskOutput };
  if (json.code) throw new AsrHttpError("Transcription submit error", 200, JSON.stringify(json));
  const taskId = json.output?.task_id;
  if (!taskId) throw new AsrHttpError("Transcription submit error", 200, JSON.stringify(json).slice(0, 400));
  logAsrEvent("submit", { status: 200, model: conn.modelId, fileUrl, taskId, options });
  return taskId;
}

// ─── 轮询 ────────────────────────────────────────────────────────────────────

export interface PollProgress {
  phase: "queued" | "running";
  polls: number;
  elapsedMs: number;
}

export interface PollResult {
  transcriptionUrl: string;
  /** 平台报的计费秒数（`usage.duration` / `usage.seconds`），没报就 null。 */
  billedSeconds: number | null;
}

const POLL_MS = 3_000;
const POLL_SLOW_MS = 5_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) return fail();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      fail();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 轮到任务落定。`signal` 由调用方带 deadline（`run.ts` 按时长算）——平台没有
 * 取消接口，abort 只是不再等，任务照样跑完并计费。
 */
export async function pollTask(
  conn: AsrConn,
  taskId: string,
  onProgress?: (p: PollProgress) => void,
  signal?: AbortSignal,
  now: () => number = Date.now,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
): Promise<PollResult> {
  const base = dashscopeNativeBase(conn.baseUrl);
  const startedAt = now();
  let polls = 0;
  let misses = 0;
  for (;;) {
    await wait(polls < 10 ? POLL_MS : POLL_SLOW_MS, signal);
    polls++;
    let json: { output?: TaskOutput; usage?: { duration?: number; seconds?: number } };
    try {
      const res = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}`, { headers: authHeaders(conn), signal });
      if (!res.ok) throw new AsrHttpError("Transcription task error", res.status, await res.text());
      json = (await readJson(res, "Transcription task error")) as typeof json;
    } catch (e) {
      // 任务已经付了钱，一次 GET 很便宜，网络抖一下值得等——但只等几次。
      if (signal?.aborted || ++misses >= 3) throw e;
      continue;
    }
    misses = 0;
    const status = taskStatusOf(json.output);
    if (status === "PENDING" || status === "RUNNING") {
      onProgress?.({ phase: status === "PENDING" ? "queued" : "running", polls, elapsedMs: now() - startedAt });
      continue;
    }
    if (status === "SUCCEEDED") {
      logAsrEvent("poll", { taskId, status, polls, elapsedMs: now() - startedAt, usage: json.usage });
      const url = transcriptionUrlOf(json.output);
      if (!url) throw new AsrHttpError("Transcription task error", 200, JSON.stringify(json.output ?? json).slice(0, 400));
      const billed = json.usage?.duration ?? json.usage?.seconds;
      return { transcriptionUrl: url, billedSeconds: typeof billed === "number" ? billed : null };
    }
    logAsrEvent("poll", { taskId, status, polls, elapsedMs: now() - startedAt, code: json.output?.code, message: json.output?.message });
    throw new AsrHttpError("Transcription failed", 200, JSON.stringify({ code: json.output?.code ?? status, message: taskFailureOf(json.output) }));
  }
}

/** 结果链接 24 小时有效——拿到就下载，调用方立刻落缓存。 */
export async function fetchResultJson(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new AsrHttpError("Transcription result error", res.status, await res.text());
  return res.text();
}
