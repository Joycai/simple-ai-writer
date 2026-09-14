import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `transcribeFile` 的同步那条腿：上限在读文件之前（不变量 7 的兜底）、一次请求、
// 缓存键带接口、分离开关不产生第二份付费缓存。盘是内存里的一张表。

const fsState = vi.hoisted(() => ({
  files: new Map<string, string | Uint8Array>(),
  /** Real sizes that differ from the stored bytes (a 12MB file without storing 12MB). */
  sizes: new Map<string, number>(),
  binaryReads: 0,
}));

vi.mock("../../fs/fileio", () => {
  const { files, sizes } = fsState;
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
    readBinaryFile: async (p: string) => {
      fsState.binaryReads++;
      const v = files.get(p);
      if (!(v instanceof Uint8Array)) throw new Error(`no binary file ${p}`);
      return v;
    },
    readFileHead: async (p: string, max: number) => {
      const v = files.get(p) as Uint8Array;
      return { size: sizes.get(p) ?? v.byteLength, head: v.subarray(0, max) };
    },
    removeDir: async (p: string) => { for (const k of under(p)) files.delete(k); },
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

const calls: { url: string; body: string }[] = [];
const responses: (() => Response)[] = [];
globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), body: String(init?.body ?? "") });
  const next = responses.shift();
  if (!next) throw new Error("no queued response");
  return next();
}) as typeof fetch;

import { transcribeFile } from "../run";
import type { AsrConn } from "../client";

const ALIAS = readFileSync(fileURLToPath(new URL("./fixtures/qwen3-asr-flash-sync.json", import.meta.url)), "utf8");
const conn: AsrConn = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "k",
  modelId: "qwen3-asr-flash",
  format: "dashscope-sync",
};

afterEach(() => {
  fsState.files.clear();
  fsState.sizes.clear();
  fsState.binaryReads = 0;
  calls.length = 0;
  responses.length = 0;
});

describe("transcribeFile × dashscope-sync", () => {
  it("超过 10MB：从文件头的真实大小就拒，不读整个文件、不发请求", async () => {
    fsState.files.set("/p/big.mp3", new Uint8Array(16));
    fsState.sizes.set("/p/big.mp3", 12 * 1024 * 1024);
    await expect(transcribeFile({ projectPath: "/p", sourcePath: "/p/big.mp3", conn, options: { diarization: false } }))
      .rejects.toThrow(/10MB/);
    expect(fsState.binaryReads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("一次请求 → 不带时间的稿；键带 sync；再转一次（哪怕开了分离）命中缓存、不再付费", async () => {
    fsState.files.set("/p/a.wav", new Uint8Array([1, 2, 3, 4]));
    responses.push(() => new Response(ALIAS, { status: 200 }));
    const phases: string[] = [];
    const first = await transcribeFile({
      projectPath: "/p", sourcePath: "/p/a.wav", conn,
      options: { diarization: false, languageHints: ["zh"] },
      onProgress: (p) => phases.push(p.phase),
    });
    expect(phases).toEqual(["reading", "running"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(JSON.parse(calls[0].body).asr_options).toEqual({ language: "zh" });
    expect(first).toMatchObject({ cached: false, billedSeconds: 6 });
    expect(first.transcript.timed).toBe(false);
    expect(first.cacheDir).toMatch(/-qwen3-asr-flash-sync-p-zh$/);
    const meta = JSON.parse(fsState.files.get(`${first.cacheDir}/meta.json`) as string);
    expect(meta).toMatchObject({ format: "dashscope-sync", model: "qwen3-asr-flash", billedSeconds: 6 });

    const again = await transcribeFile({
      projectPath: "/p", sourcePath: "/p/a.wav", conn,
      options: { diarization: true, speakerCount: 2, languageHints: ["zh"] },
    });
    expect(calls).toHaveLength(1);
    expect(again).toMatchObject({ cached: true, billedSeconds: 6, cacheDir: first.cacheDir });
    expect(again.transcript.sentences[0].text).toMatch(/西湖/);
  });
});
