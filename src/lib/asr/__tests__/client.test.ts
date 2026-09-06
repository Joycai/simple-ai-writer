import { afterEach, describe, expect, it, vi } from "vitest";

// `lib/http` 在 vitest 里退到 globalThis.fetch；这里直接替换它。
const calls: { url: string; init?: RequestInit }[] = [];
const responses: (() => Response)[] = [];
globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
  const next = responses.shift();
  if (!next) throw new Error("no queued response");
  return next();
}) as typeof fetch;

import {
  AsrHttpError,
  getUploadPolicy,
  pollTask,
  submitBody,
  submitHeaders,
  submitTranscription,
  uploadFormFields,
  uploadKeyFor,
  uploadTemp,
  type AsrConn,
  type UploadPolicy,
} from "../client";

const conn: AsrConn = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "sk-test",
  modelId: "qwen-audio-3.0-asr-flash-filetrans",
};

const policy: UploadPolicy = {
  upload_host: "https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com",
  upload_dir: "dashscope-instant/acct/2026-09-06/req",
  policy: "eyJ...",
  signature: "sig=",
  oss_access_key_id: "LTAI",
  x_oss_object_acl: "private",
  x_oss_forbid_overwrite: "true",
};

const json = (body: unknown, status = 200) =>
  () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  calls.length = 0;
  responses.length = 0;
});

describe("getUploadPolicy", () => {
  it("原生 base + action=getPolicy + **同一个** model id；返回 data", async () => {
    responses.push(json({ data: policy, request_id: "r" }));
    const got = await getUploadPolicy(conn);
    expect(got.upload_dir).toBe(policy.upload_dir);
    expect(calls[0].url).toBe(
      "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen-audio-3.0-asr-flash-filetrans",
    );
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer sk-test");
  });
  it("200 但 data 缺字段 → AsrHttpError", async () => {
    responses.push(json({ data: { upload_host: "x" } }));
    await expect(getUploadPolicy(conn)).rejects.toBeInstanceOf(AsrHttpError);
  });
});

describe("upload form", () => {
  it("字段顺序固定且 file 最后；key = upload_dir/文件名（去掉路径）", () => {
    const key = uploadKeyFor(policy, "C:\\录音\\采访.mp3");
    expect(key).toBe("dashscope-instant/acct/2026-09-06/req/采访.mp3");
    expect(uploadFormFields(policy, key).map(([k]) => k)).toEqual([
      "OSSAccessKeyId", "Signature", "policy", "x-oss-object-acl", "x-oss-forbid-overwrite", "key", "success_action_status",
    ]);
  });
  it("uploadTemp：POST 到 upload_host，FormData 里 file 是最后一个字段，不手设 Content-Type，返回 oss://", async () => {
    responses.push(() => new Response("", { status: 200 }));
    const url = await uploadTemp(policy, new Uint8Array([1, 2, 3]), "a.wav", "audio/wav");
    expect(url).toBe("oss://dashscope-instant/acct/2026-09-06/req/a.wav");
    expect(calls[0].url).toBe(policy.upload_host);
    const form = calls[0].init?.body as FormData;
    const keys = [...form.keys()];
    expect(keys[keys.length - 1]).toBe("file");
    expect(new Headers(calls[0].init?.headers).has("Content-Type")).toBe(false);
  });
});

describe("submit", () => {
  it("body：file_urls 数组 + channel_id [0]；分离与语言提示按需加", () => {
    expect(submitBody("m", "oss://k", { diarization: false })).toEqual({
      model: "m", input: { file_urls: ["oss://k"] }, parameters: { channel_id: [0] },
    });
    const b = submitBody("m", "oss://k", { diarization: true, speakerCount: 3, languageHints: ["zh", "en", "ja", "ko", "fr"] });
    expect(b.parameters).toEqual({ channel_id: [0], language_hints: ["zh", "en", "ja", "ko"], diarization_enabled: true, speaker_count: 3 });
    // speaker_count < 2 没有意义，不发。
    expect((submitBody("m", "oss://k", { diarization: true, speakerCount: 1 }).parameters as Record<string, unknown>).speaker_count).toBeUndefined();
  });
  it("头：异步标记恒有；resolve 头**只**跟着 oss:// 走", () => {
    const oss = submitHeaders(conn, "oss://k");
    expect(oss["X-DashScope-Async"]).toBe("enable");
    expect(oss["X-DashScope-OssResourceResolve"]).toBe("enable");
    const https = submitHeaders(conn, "https://example.com/a.mp3");
    expect(https["X-DashScope-Async"]).toBe("enable");
    expect(https["X-DashScope-OssResourceResolve"]).toBeUndefined();
  });
  it("submitTranscription：同一个 model id 进 body；200 带顶层 code 抛错；返回 task_id", async () => {
    responses.push(json({ request_id: "r", output: { task_id: "t-1", task_status: "PENDING" } }));
    expect(await submitTranscription(conn, "oss://k", { diarization: false })).toBe("t-1");
    expect(calls[0].url).toBe("https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription");
    expect(JSON.parse(calls[0].init?.body as string).model).toBe(conn.modelId);

    responses.push(json({ code: "InvalidParameter", message: "bad", request_id: "r" }));
    await expect(submitTranscription(conn, "oss://k", { diarization: false })).rejects.toMatchObject({ code: "InvalidParameter" });
  });
});

describe("pollTask", () => {
  const wait = async () => {};
  it("PENDING → RUNNING → SUCCEEDED：进度回调两次，结果链接两代位置都认，usage 秒数带回", async () => {
    responses.push(json({ output: { task_id: "t", task_status: "PENDING" } }));
    responses.push(json({ output: { task_id: "t", task_status: "RUNNING" } }));
    responses.push(json({ output: { task_id: "t", task_status: "SUCCEEDED", output: { transcription_url: "https://res" } }, usage: { duration: 48 } }));
    const phases: string[] = [];
    const r = await pollTask(conn, "t", (p) => phases.push(p.phase), undefined, () => 0, wait);
    expect(phases).toEqual(["queued", "running"]);
    expect(r).toEqual({ transcriptionUrl: "https://res", billedSeconds: 48 });
    expect(calls[0].url).toBe("https://dashscope.aliyuncs.com/api/v1/tasks/t");
  });
  it("FAILED：抛 AsrHttpError，code 是 output.code，message 带线索", async () => {
    responses.push(json({ output: { task_id: "t", task_status: "FAILED", code: "FILE_DOWNLOAD_FAILED", message: "FILE_DOWNLOAD_FAILED" } }));
    const err = await pollTask(conn, "t", undefined, undefined, () => 0, wait).catch((e) => e);
    expect(err).toBeInstanceOf(AsrHttpError);
    expect((err as AsrHttpError).code).toBe("FILE_DOWNLOAD_FAILED");
    expect((err as AsrHttpError).message).toMatch(/resolve header/);
  });
  it("网络抖动连续两次可以忍，第三次抛", async () => {
    responses.push(() => new Response("gateway", { status: 502 }));
    responses.push(() => new Response("gateway", { status: 502 }));
    responses.push(json({ output: { task_id: "t", task_status: "SUCCEEDED", result: { transcription_url: "https://ok" } }, usage: { seconds: 2 } }));
    const r = await pollTask(conn, "t", undefined, undefined, () => 0, wait);
    expect(r).toEqual({ transcriptionUrl: "https://ok", billedSeconds: 2 });

    responses.push(() => new Response("x", { status: 502 }));
    responses.push(() => new Response("x", { status: 502 }));
    responses.push(() => new Response("x", { status: 502 }));
    await expect(pollTask(conn, "t", undefined, undefined, () => 0, wait)).rejects.toMatchObject({ status: 502 });
  });
});
