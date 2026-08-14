/**
 * Optional API-call logging for debugging provider issues (e.g. local ollama).
 * When enabled in Settings → General, every streamCompletion call appends
 * request/response/error entries as JSON lines to a daily file under
 * <appLogDir>/api/. API keys are never written.
 */

import { appLogDir, join } from "@tauri-apps/api/path";
import { appendFile, fileExists, makeDir } from "../fs/fileio";
import { readPref, writePref } from "../prefs";
import type { StreamChunk, StreamMessage, StreamOptions } from "./types";

const ENABLED_KEY = "app:apiLogEnabled";

export function isApiLogEnabled(): boolean {
  return readPref(ENABLED_KEY) === "1";
}

export function setApiLogEnabled(enabled: boolean): void {
  writePref(ENABLED_KEY, enabled ? "1" : "0");
}

export async function getApiLogDir(): Promise<string> {
  return join(await appLogDir(), "api");
}

function todayStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function getCurrentApiLogFile(): Promise<string> {
  return join(await getApiLogDir(), `api-${todayStamp()}.jsonl`);
}

/**
 * Path to reveal from the Settings "open logs" button: today's file when it
 * exists (so the file manager selects it), otherwise the api log directory.
 */
export async function getApiLogRevealTarget(): Promise<string> {
  const file = await getCurrentApiLogFile();
  if (await fileExists(file)) return file;
  const dir = await getApiLogDir();
  // Ensure the directory exists so reveal has something to select.
  await makeDir(dir);
  return dir;
}

// Serialize writes so concurrent calls (e.g. the agent loop) can't interleave lines.
let writeChain: Promise<void> = Promise.resolve();

function writeEntry(entry: Record<string, unknown>): void {
  writeChain = writeChain
    .then(async () => {
      const file = await getCurrentApiLogFile();
      await appendFile(file, JSON.stringify(entry) + "\n");
    })
    .catch((e) => console.warn("[apiLog] failed to write entry:", e));
}

/** Replace base64 image payloads with a short placeholder — they can be megabytes. */
function redactMessage(m: StreamMessage): unknown {
  if ("content" in m && Array.isArray(m.content)) {
    return {
      ...m,
      content: m.content.map((p) =>
        p.type === "image_url"
          ? { type: "image_url", image_url: { url: `<image data url, ${p.image_url.url.length} chars omitted>` } }
          : p,
      ),
    };
  }
  return m;
}

/**
 * A request body with its base64 image payloads replaced by a placeholder.
 *
 * The same reason `redactMessage` exists — a picture is megabytes of data URL,
 * and a log line that carries one is a log line nobody can open. Structural
 * rather than protocol-aware: it walks whatever shape it is handed and cuts any
 * long base64-looking string, so it keeps working when an adapter's body shape
 * changes or another protocol starts using this.
 */
function redactRequestBody(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > 2048 ? `<${value.length} chars omitted>` : value;
  }
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactRequestBody(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      redactRequestBody(v, depth + 1),
    ]),
  );
}

/** Logging for one image call — the same file, so a debug session sees both. */
export interface ImageCallLogger {
  success(result: { images: number; usage?: { inputTokens: number; outputTokens: number }; text?: string }): void;
  error(e: unknown): void;
}

const noopImageLogger: ImageCallLogger = { success() {}, error() {} };

/**
 * Start logging one `generateImage` call.
 *
 * Image requests used to be the one kind of provider traffic the debug log
 * couldn't see, which is exactly backwards: they cost real money per attempt
 * and their failures are the hardest to reproduce. Prompts are written in
 * full (they are the author's own text); input images are counted, not
 * embedded.
 */
export function beginImageApiLog(req: {
  standard: string;
  route: string;
  baseUrl: string;
  modelId: string;
  prompt: string;
  n?: number;
  size?: string;
  aspect?: string;
  inputImages: number;
  extraBody?: Record<string, unknown>;
}): ImageCallLogger {
  if (!isApiLogEnabled()) return noopImageLogger;

  const id = `img-${Date.now()}-${++seq}`;
  const start = performance.now();
  const { prompt, ...rest } = req;

  writeEntry({ type: "image-request", id, time: new Date().toISOString(), ...rest, prompt });

  return {
    success(result) {
      writeEntry({
        type: "image-response",
        id,
        time: new Date().toISOString(),
        durationMs: Math.round(performance.now() - start),
        model: req.modelId,
        images: result.images,
        usage: result.usage,
        text: result.text,
      });
    },
    error(e) {
      writeEntry({
        type: "image-error",
        id,
        time: new Date().toISOString(),
        durationMs: Math.round(performance.now() - start),
        model: req.modelId,
        error: e instanceof Error ? e.message : String(e),
      });
    },
  };
}

export interface ApiCallLogger {
  /** One HTTP request body as the adapter sent it. May fire more than once. */
  requestBody(body: unknown): void;
  chunk(chunk: StreamChunk): void;
  success(): void;
  error(e: unknown): void;
}

const noopLogger: ApiCallLogger = { requestBody() {}, chunk() {}, success() {}, error() {} };

let seq = 0;

/**
 * Start logging one streamCompletion call. Returns a no-op logger when the
 * setting is off, so the call site stays unconditional. Never logs `apiKey`.
 */
export function beginApiLog(opts: StreamOptions): ApiCallLogger {
  if (!isApiLogEnabled()) return noopLogger;

  const id = `${Date.now()}-${++seq}`;
  const start = performance.now();

  writeEntry({
    type: "request",
    id,
    time: new Date().toISOString(),
    standard: opts.standard,
    baseUrl: opts.baseUrl,
    model: opts.modelId,
    tools: opts.tools?.map((t) => t.function.name),
    extraBody: opts.extraBody,
    safetySettings: opts.safetySettings,
    authMode: opts.authMode,
    messages: opts.messages.map(redactMessage),
  });

  let output = "";
  let toolCalls: { name: string; arguments: string }[] | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  /**
   * Why the response ended, and whether it was cut off. Recorded because
   * "the answer just stops" is the failure this log exists to explain, and the
   * text alone cannot tell `max_tokens` (cut off) from `tool_use` (the turn is
   * meant to continue) from `end_turn` (the model thought it was done).
   */
  let stopReason: string | undefined;
  let truncated = false;
  /** Searches the endpoint ran for itself — see lib/ai/serverTools. */
  const serverTools: { name: string; input?: unknown; results?: number; error?: string }[] = [];

  /** Which request of this call — a turn that resumes itself sends several. */
  let leg = 0;

  return {
    requestBody(body) {
      leg++;
      // The first leg is already described by the `request` entry above, in the
      // caller's own message shape. This is the wire body, and the legs after
      // the first exist nowhere else — an endpoint that stops mid-turn is
      // handed something this app assembled, and that is precisely the thing
      // worth being able to read back.
      writeEntry({
        type: "request-body",
        id,
        leg,
        time: new Date().toISOString(),
        body: redactRequestBody(body),
      });
    },
    chunk(chunk) {
      if ("text" in chunk) {
        output += chunk.text;
      } else if ("toolCalls" in chunk) {
        toolCalls = chunk.toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments }));
      } else if ("serverTool" in chunk) {
        const e = chunk.serverTool;
        serverTools.push(
          e.phase === "call"
            ? { name: e.name, input: e.input }
            : { name: e.name, results: e.results.length, error: e.error },
        );
      } else if ("done" in chunk) {
        usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
        stopReason = chunk.stopReason;
        truncated = chunk.truncated ?? false;
      }
    },
    success() {
      writeEntry({
        type: "response",
        id,
        time: new Date().toISOString(),
        durationMs: Math.round(performance.now() - start),
        model: opts.modelId,
        usage,
        stopReason,
        truncated,
        toolCalls,
        ...(serverTools.length ? { serverTools } : {}),
        output,
      });
    },
    error(e) {
      writeEntry({
        type: "error",
        id,
        time: new Date().toISOString(),
        durationMs: Math.round(performance.now() - start),
        model: opts.modelId,
        error: e instanceof Error ? e.message : String(e),
        partialOutput: output || undefined,
      });
    },
  };
}
