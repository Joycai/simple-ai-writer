import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `transcribeFile` 的 filetrans 那条腿，只看检查点（坑 121）：提交是付费的一步，
// 提交之后任何原因中断，重跑都要接着轮询**同一个**任务，而不是再上传、再付一次钱。

const fsState = vi.hoisted(() => ({ files: new Map<string, string | Uint8Array>() }));

vi.mock("../../fs/fileio", () => {
  const { files } = fsState;
  const under = (p: string) => [...files.keys()].filter((k) => k === p || k.startsWith(`${p}/`));
  return {
    fileExists: async (p: string) => under(p).length > 0,
    makeDir: async () => {},
    readDir: async () => [],
    readFile: async (p: string) => {
      const v = files.get(p);
      if (typeof v !== "string") throw new Error(`no text file ${p}`);
      return v;
    },
    readBinaryFile: async (p: string) => files.get(p) as Uint8Array,
    readFileRange: async () => new Uint8Array(),
    readFileHead: async (p: string) => ({ size: (files.get(p) as Uint8Array).byteLength, head: files.get(p) }),
    removeDir: async (p: string) => { for (const k of under(p)) files.delete(k); },
    removeFile: async (p: string) => { files.delete(p); },
    renamePath: async (from: string, to: string) => {
      for (const k of under(from)) {
        const v = files.get(k)!;
        files.delete(k);
        files.set(to + k.slice(from.length), v);
      }
    },
    toBase64: (b: Uint8Array) => Buffer.from(b).toString("base64"),
    writeFile: async (p: string, c: string) => { files.set(p, c); },
  };
});
vi.mock("../../import", () => ({ uniqueImportPath: async (dir: string, name: string) => `${dir}/${name}` }));

const RESULT = readFileSync(fileURLToPath(new URL("./fixtures/qwen3-asr-flash-filetrans.json", import.meta.url)), "utf8");
const net = vi.hoisted(() => ({ submits: 0, polls: [] as string[], pollPlan: [] as ("ok" | "401" | "404")[] }));

vi.mock("../client", async (orig) => {
  const actual = await orig<typeof import("../client")>();
  return {
    ...actual,
    getUploadPolicy: async () => ({}),
    uploadTemp: async () => "oss://tmp/a.wav",
    submitTranscription: async () => `task-${++net.submits}`,
    pollTask: async (_c: unknown, taskId: string) => {
      net.polls.push(taskId);
      const step = net.pollPlan.shift() ?? "ok";
      if (step === "401") throw new actual.AsrHttpError("Transcription task error", 401, "{}");
      if (step === "404") throw new actual.AsrHttpError("Transcription task error", 404, "{}");
      return { transcriptionUrl: "https://res", billedSeconds: 5 };
    },
    fetchResultJson: async () => RESULT,
  };
});

import { transcribeFile } from "../run";
import type { AsrConn } from "../client";

const conn: AsrConn = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "k",
  modelId: "qwen3-asr-flash-filetrans",
};
const req = { projectPath: "/p", sourcePath: "/p/a.wav", conn, options: { diarization: false } };
const pendingFiles = () => [...fsState.files.keys()].filter((k) => k.endsWith(".pending.json"));

afterEach(() => {
  fsState.files.clear();
  net.submits = 0;
  net.polls.length = 0;
  net.pollPlan.length = 0;
});

describe("transcribeFile × filetrans checkpoint", () => {
  it("a rerun after a failed poll resumes the paid task instead of submitting again", async () => {
    fsState.files.set("/p/a.wav", new Uint8Array([1, 2, 3, 4]));
    net.pollPlan.push("401");
    await expect(transcribeFile(req)).rejects.toMatchObject({ status: 401 });
    expect(net.submits).toBe(1);
    expect(pendingFiles()).toHaveLength(1);

    const out = await transcribeFile(req);
    expect(net.submits).toBe(1);
    expect(net.polls).toEqual(["task-1", "task-1"]);
    expect(out.cached).toBe(false);
    // Settled: the checkpoint is gone, the cache holds the result.
    expect(pendingFiles()).toHaveLength(0);
  });

  it("a checkpoint whose task the platform no longer has is dropped, and one fresh task runs", async () => {
    fsState.files.set("/p/a.wav", new Uint8Array([1, 2, 3, 4]));
    net.pollPlan.push("401");
    await transcribeFile(req).catch(() => {});
    net.pollPlan.push("404");
    await transcribeFile(req);
    expect(net.submits).toBe(2);
    expect(net.polls).toEqual(["task-1", "task-1", "task-2"]);
    expect(pendingFiles()).toHaveLength(0);
  });
});
