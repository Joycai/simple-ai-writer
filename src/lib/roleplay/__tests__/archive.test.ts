/**
 * 封存的文件名与场号推进。
 *
 * 这里钉的是一条会静默毁掉一场戏的性质：**编号推进和归档列表必须认同一套文件名**。
 * 「另起一场」封存出来的是 `transcript-NN.discarded.md`，只让列表认这个后缀而
 * 编号不认，下一场就会拿到一个已经被占用的号，`archiveSession` 随即把那一场的
 * `summary-NN.md` 直接覆盖掉——没有报错，只是少了一场。
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const files = new Map<string, string>();
const dirs = new Set<string>();

vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }),
  writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
  appendFile: vi.fn(),
  makeDir: vi.fn(async (p: string) => { dirs.add(p); }),
  fileExists: vi.fn(async (p: string) => files.has(p) || dirs.has(p)),
  readDir: vi.fn(async (p: string) => {
    const kids = new Set<string>();
    for (const d of [...dirs, ...files.keys()]) {
      if (d.startsWith(`${p}/`)) kids.add(d.slice(p.length + 1).split("/")[0]);
    }
    return [...kids].map((name) => ({
      name, path: `${p}/${name}`, isDirectory: !files.has(`${p}/${name}`),
    }));
  }),
  // 真的搬，不是 no-op——这组测试问的正是「搬到哪个名字下」。
  renamePath: vi.fn(async (from: string, to: string) => {
    const v = files.get(from);
    if (v === undefined) throw new Error(`ENOENT ${from}`);
    files.delete(from);
    files.set(to, v);
  }),
  removeFile: vi.fn(async (p: string) => { files.delete(p); }),
}));

import {
  archiveSession, listArchives, peekNextArchiveNo, summaryPath, transcriptPath,
} from "../store";

const ROOT = "D:/proj";
const AGENT = "rp-a-0001";
const ARCHIVE = `${ROOT}/.ai-writer/roleplay/${AGENT}/archive`;

function startScene(text: string): void {
  files.set(transcriptPath(ROOT, AGENT), text);
  files.set(summaryPath(ROOT, AGENT), `摘要：${text}`);
}

beforeEach(() => {
  files.clear();
  dirs.clear();
});

describe("archiveSession", () => {
  it("names a kept scene transcript-NN.md", async () => {
    startScene("第一场");
    expect(await archiveSession(ROOT, AGENT, { clearMemory: false })).toBe(1);
    expect(files.has(`${ARCHIVE}/transcript-01.md`)).toBe(true);
    expect(files.has(`${ARCHIVE}/summary-01.md`)).toBe(true);
  });

  it("marks a discarded scene in the file name", async () => {
    startScene("试的一场");
    expect(await archiveSession(ROOT, AGENT, { clearMemory: false, discard: true })).toBe(1);
    expect(files.has(`${ARCHIVE}/transcript-01.discarded.md`)).toBe(true);
    // 后缀只落在 transcript 上：它是 `listArchives` 唯一认的文件，附属品按场号跟着走。
    expect(files.has(`${ARCHIVE}/summary-01.md`)).toBe(true);
  });

  it("moves the transcript rather than rewriting it", async () => {
    startScene("一个字都不能少");
    await archiveSession(ROOT, AGENT, { clearMemory: false, discard: true });
    expect(files.get(`${ARCHIVE}/transcript-01.discarded.md`)).toBe("一个字都不能少");
    expect(files.has(transcriptPath(ROOT, AGENT))).toBe(false);
  });
});

describe("场号推进", () => {
  /**
   * 这一条是本文件存在的理由。作废的一场**照样占号**——不然第 2 场会写到
   * `transcript-01.md` / `summary-01.md`，把第 1 场的摘要覆盖掉。
   */
  it("counts a discarded archive when picking the next number", async () => {
    startScene("第一场（作废）");
    await archiveSession(ROOT, AGENT, { clearMemory: false, discard: true });
    expect(await peekNextArchiveNo(ROOT, AGENT)).toBe(2);

    startScene("第二场");
    expect(await archiveSession(ROOT, AGENT, { clearMemory: false })).toBe(2);
    expect(files.has(`${ARCHIVE}/transcript-01.discarded.md`)).toBe(true);
    expect(files.has(`${ARCHIVE}/transcript-02.md`)).toBe(true);
    expect(files.get(`${ARCHIVE}/summary-01.md`)).toBe("摘要：第一场（作废）");
  });

  // 按最大值 + 1，不按文件个数：作者手删掉中间一场之后按个数会撞名。
  it("is max + 1 after the author hand-deletes a middle archive", async () => {
    startScene("a");
    await archiveSession(ROOT, AGENT, { clearMemory: false });
    startScene("b");
    await archiveSession(ROOT, AGENT, { clearMemory: false });
    files.delete(`${ARCHIVE}/transcript-01.md`);
    expect(await peekNextArchiveNo(ROOT, AGENT)).toBe(3);
  });
});

describe("listArchives", () => {
  it("reports which scenes were discarded, newest first", async () => {
    startScene("a");
    await archiveSession(ROOT, AGENT, { clearMemory: false });
    startScene("b");
    await archiveSession(ROOT, AGENT, { clearMemory: false, discard: true });

    const list = await listArchives(ROOT, AGENT);
    expect(list.map((s) => [s.no, s.discarded])).toEqual([[2, true], [1, false]]);
  });

  it("is empty when nothing has been archived", async () => {
    expect(await listArchives(ROOT, AGENT)).toEqual([]);
  });
});
