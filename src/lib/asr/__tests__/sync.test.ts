import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `lib/http` 在 vitest 里退到 globalThis.fetch；这里直接替换它（同 client.test.ts）。
const calls: { url: string; init?: RequestInit }[] = [];
const responses: (() => Response)[] = [];
globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
  const next = responses.shift();
  if (!next) throw new Error("no queued response");
  return next();
}) as typeof fetch;

import { AsrHttpError, type AsrConn } from "../client";
import { dashscopeCompatBase, syncBody, syncErrorOf, transcribeSync } from "../sync";
import { parseSyncTranscript, syncBilledSeconds } from "../result";

// 2026-09-14 真机响应（`id` 等原样保留）：别名带 annotations + usage.seconds，
// 日期快照两样都没有，只有 audio_tokens。
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const ALIAS = fixture("qwen3-asr-flash-sync.json");
const DATED = fixture("qwen3-asr-flash-2026-02-10-sync.json");

// 实测的三句 400 原话（result1.json 的 asr_330s_mp3 / asr_13MB_wav；format is empty 见 landscape.md）。
const TOO_LONG = '{"error":{"message":"<400> InternalError.Algo.InvalidParameter: The audio is too long","type":"invalid_request_error","param":null,"code":"invalid_parameter_error"}}';
const TOO_LARGE = '{"error":{"message":"<400> InternalError.Algo.InvalidParameter: Multimodal file size is too large","type":"invalid_request_error","param":null,"code":"invalid_parameter_error"}}';
const FORMAT_EMPTY = '{"error":{"message":"<400> InternalError.Algo.InvalidParameter: format is empty","type":"invalid_request_error","param":null,"code":"invalid_parameter_error"}}';

const conn: AsrConn = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "sk-test",
  modelId: "qwen3-asr-flash",
  format: "dashscope-sync",
};

afterEach(() => {
  calls.length = 0;
  responses.length = 0;
});

describe("syncBody", () => {
  it("user 消息**只有**一个 input_audio part（加 text part 实测 400）；format 取扩展名，data URL 带 MIME", () => {
    const body = syncBody({ modelId: "qwen3-asr-flash", audioBase64: "AAAA", ext: "mp3", options: { diarization: false } });
    expect(body).toEqual({
      model: "qwen3-asr-flash",
      messages: [
        { role: "user", content: [{ type: "input_audio", input_audio: { data: "data:audio/mpeg;base64,AAAA", format: "mp3" } }] },
      ],
    });
    expect(syncBody({ modelId: "m", audioBase64: "x", ext: "MP4", options: { diarization: false } }).messages)
      .toMatchObject([{ content: [{ input_audio: { data: "data:video/mp4;base64,x", format: "mp4" } }] }]);
  });
  it("上下文走前置 system 消息；第一个语言提示进 asr_options；分离 / 人数没有字段，不发", () => {
    const body = syncBody({
      modelId: "m", audioBase64: "x", ext: "wav", context: " 专有名词：西湖 ",
      options: { diarization: true, speakerCount: 3, languageHints: ["zh", "en"] },
    });
    const messages = body.messages as { role: string; content: unknown[] }[];
    expect(messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "专有名词：西湖" }] });
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toHaveLength(1);
    expect(body.asr_options).toEqual({ language: "zh" });
    expect(JSON.stringify(body)).not.toMatch(/diarization|speaker/);
  });
  it("白名单外的扩展名直接抛，不发一个没测过的格式", () => {
    expect(() => syncBody({ modelId: "m", audioBase64: "x", ext: "wma", options: { diarization: false } })).toThrow(/wma/);
  });
});

describe("dashscopeCompatBase", () => {
  it("原生 /api/v1 与 compatible-mode 两种写法归一到 compatible-mode/v1", () => {
    expect(dashscopeCompatBase("https://dashscope.aliyuncs.com/api/v1/")).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(dashscopeCompatBase("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });
});

describe("parseSyncTranscript（真机响应）", () => {
  it("别名：整段一句、不带时间、language / emotion 来自 annotations、时长＝usage.seconds", () => {
    const t = parseSyncTranscript(ALIAS);
    expect(t).toEqual({
      durationMs: 6000,
      speakers: false,
      timed: false,
      sentences: [{ beginMs: 0, endMs: 6000, text: "今天杭州天气晴朗，适合去西湖散步。第二句话用来测试时间戳。", language: "zh", emotion: "neutral" }],
    });
  });
  it("日期快照：没有 annotations、没有 usage.seconds——秒数由 audio_tokens / 25 向上取整", () => {
    const t = parseSyncTranscript(DATED);
    expect(t.sentences).toHaveLength(1);
    expect(t.sentences[0].language).toBeUndefined();
    expect(t.durationMs).toBe(7000); // ceil(169 / 25)
    expect(syncBilledSeconds(JSON.parse(DATED).usage)).toBe(7);
    expect(syncBilledSeconds(JSON.parse(ALIAS).usage)).toBe(6);
    expect(syncBilledSeconds(undefined)).toBeNull();
  });
  it("空字符串是「没说话」→ 零句；没有 message 是坏响应 → 抛", () => {
    expect(parseSyncTranscript({ choices: [{ message: { content: "" } }] }).sentences).toEqual([]);
    expect(() => parseSyncTranscript({ choices: [] })).toThrow(/choices/);
    expect(() => parseSyncTranscript("{")).toThrow(/JSON/);
  });
});

describe("syncErrorOf", () => {
  it("三句实测原话改口成作者能照做的话", () => {
    expect(syncErrorOf(400, TOO_LONG, "qwen3-asr-flash")).toMatchObject({ code: "AudioTooLong", status: 400 });
    expect(syncErrorOf(400, TOO_LONG, "qwen3-asr-flash").message).toMatch(/5 minutes.*filetrans/);
    expect(syncErrorOf(400, TOO_LARGE, "qwen3-asr-flash")).toMatchObject({ code: "FileTooLarge" });
    expect(syncErrorOf(400, TOO_LARGE, "qwen3-asr-flash").message).toMatch(/10MB/);
    const notSync = syncErrorOf(400, FORMAT_EMPTY, "qwen-audio-3.0-asr-flash");
    expect(notSync.code).toBe("ModelNotSync");
    expect(notSync.message).toMatch(/qwen-audio-3\.0-asr-flash.*not a synchronous ASR model/);
  });
  it("别的错误原样透传", () => {
    const e = syncErrorOf(401, '{"error":{"message":"Incorrect API key provided."}}', "m");
    expect(e).toBeInstanceOf(AsrHttpError);
    expect(e.message).toMatch(/Incorrect API key/);
  });
});

describe("transcribeSync", () => {
  it("POST compatible-mode /chat/completions，Bearer 头，返回响应本体与计费秒数", async () => {
    responses.push(() => new Response(ALIAS, { status: 200 }));
    const r = await transcribeSync({ ...conn, baseUrl: "https://dashscope.aliyuncs.com/api/v1" }, { audioBase64: "AAAA", ext: "wav", options: { diarization: false } });
    expect(calls[0].url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer sk-test");
    expect(JSON.parse(calls[0].init?.body as string).model).toBe("qwen3-asr-flash");
    expect(r).toEqual({ responseJson: ALIAS, billedSeconds: 6 });
  });
  it("400 过长 → AudioTooLong；200 带 error 也是错误", async () => {
    responses.push(() => new Response(TOO_LONG, { status: 400 }));
    await expect(transcribeSync(conn, { audioBase64: "A", ext: "mp3", options: { diarization: false } })).rejects.toMatchObject({ code: "AudioTooLong" });
    responses.push(() => new Response(FORMAT_EMPTY, { status: 200 }));
    await expect(transcribeSync(conn, { audioBase64: "A", ext: "mp3", options: { diarization: false } })).rejects.toMatchObject({ code: "ModelNotSync" });
  });
});
