/**
 * Optional API-call logging for debugging provider issues (e.g. local ollama).
 * When enabled in Settings → General, every streamCompletion call appends
 * request/response/error entries as JSON lines to a daily file under
 * <appLogDir>/api/. API keys are never written.
 */

import { appLogDir, join } from "@tauri-apps/api/path";
import { appendFile, fileExists, makeDir } from "./fileio";
import type { StreamChunk, StreamMessage, StreamOptions } from "./aiClient";

const ENABLED_KEY = "app:apiLogEnabled";

export function isApiLogEnabled(): boolean {
  // localStorage is absent under vitest's node environment — treat as disabled
  return typeof localStorage !== "undefined" && localStorage.getItem(ENABLED_KEY) === "1";
}

export function setApiLogEnabled(enabled: boolean): void {
  localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
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

export interface ApiCallLogger {
  chunk(chunk: StreamChunk): void;
  success(): void;
  error(e: unknown): void;
}

const noopLogger: ApiCallLogger = { chunk() {}, success() {}, error() {} };

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
    messages: opts.messages.map(redactMessage),
  });

  let output = "";
  let toolCalls: { name: string; arguments: string }[] | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;

  return {
    chunk(chunk) {
      if ("text" in chunk) {
        output += chunk.text;
      } else if ("toolCalls" in chunk) {
        toolCalls = chunk.toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments }));
      } else if ("done" in chunk) {
        usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
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
        toolCalls,
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
