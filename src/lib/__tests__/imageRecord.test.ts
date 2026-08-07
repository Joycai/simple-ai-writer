/**
 * `lib/image/session.ts` itself — the module every other image test mocks away.
 *
 * The generation record is the only thing that survives a restart: without it
 * an edit chain can't be resumed and "how did this picture come about" has no
 * answer. It is also a whole-file read-modify-write with genuinely concurrent
 * callers (an agent approving two illustrations in a row), which is exactly the
 * shape that silently loses entries.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** An in-memory filesystem, with a controllable delay on reads. */
const files = new Map<string, string>();
let readDelayMs = 0;

const readFile = vi.fn(async (path: string) => {
  if (readDelayMs) await new Promise((r) => setTimeout(r, readDelayMs));
  const v = files.get(path);
  if (v === undefined) throw new Error(`ENOENT ${path}`);
  return v;
});
const writeFile = vi.fn(async (path: string, content: string) => { files.set(path, content); });
const renamePath = vi.fn(async (from: string, to: string) => {
  const v = files.get(from);
  files.delete(from);
  if (v !== undefined) files.set(to, v);
});

vi.mock("../fs/fileio", () => ({
  fileExists: vi.fn(async (path: string) => files.has(path)),
  readFile: (p: string) => readFile(p),
  writeFile: (p: string, c: string) => writeFile(p, c),
  renamePath: (a: string, b: string) => renamePath(a, b),
  makeDir: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
  removeDir: vi.fn(async () => {}),
  writeBinaryFile: vi.fn(async () => {}),
}));
vi.mock("../fs/images", () => ({
  dataUrlToBytes: (u: string) => ({ bytes: new Uint8Array([1, 2, 3]), ext: u.includes("webp") ? "webp" : "png" }),
}));

const { recordGeneration, readGenerationRecords, writeCandidates } = await import("../image/session");

const RECORD = "/proj/.ai-writer/imagegen.json";

function record(path: string) {
  return { path, prompt: "a knight", edits: [], model: "img-1", createdAt: 1, costUsd: 0.04 };
}

beforeEach(() => {
  files.clear();
  readDelayMs = 0;
  [readFile, writeFile, renamePath].forEach((m) => m.mockClear());
});

describe("recordGeneration", () => {
  it("appends rather than replacing", async () => {
    await recordGeneration("/proj", record("/proj/a.png"));
    await recordGeneration("/proj", record("/proj/b.png"));
    expect((await readGenerationRecords("/proj")).map((r) => r.path))
      .toEqual(["/proj/a.png", "/proj/b.png"]);
  });

  it("keeps both entries when two saves overlap", async () => {
    // The regression: both callers read the pre-first contents, and the second
    // write erased the first record. Two illustrations approved back to back
    // in one agent turn is the everyday version of this.
    readDelayMs = 5;
    await Promise.all([
      recordGeneration("/proj", record("/proj/a.png")),
      recordGeneration("/proj", record("/proj/b.png")),
    ]);
    const paths = (await readGenerationRecords("/proj")).map((r) => r.path);
    expect(paths).toHaveLength(2);
    expect(paths).toEqual(expect.arrayContaining(["/proj/a.png", "/proj/b.png"]));
  });

  it("never leaves the record truncated", async () => {
    // writeFile truncates first, so writing straight over the file means a
    // crash mid-write empties the whole history rather than costing one entry.
    await recordGeneration("/proj", record("/proj/a.png"));
    expect(writeFile).toHaveBeenCalledWith(`${RECORD}.tmp`, expect.any(String));
    expect(renamePath).toHaveBeenCalledWith(`${RECORD}.tmp`, RECORD);
  });

  it("starts over on a corrupt log instead of losing the image", async () => {
    files.set(RECORD, "{ not json");
    await recordGeneration("/proj", record("/proj/a.png"));
    expect((await readGenerationRecords("/proj")).map((r) => r.path)).toEqual(["/proj/a.png"]);
  });

  it("survives a failed write without wedging later appends", async () => {
    writeFile.mockRejectedValueOnce(new Error("disk full"));
    await recordGeneration("/proj", record("/proj/a.png"));
    await recordGeneration("/proj", record("/proj/b.png"));
    expect((await readGenerationRecords("/proj")).map((r) => r.path)).toEqual(["/proj/b.png"]);
  });

  it("does nothing without a project", async () => {
    await recordGeneration("", record("/proj/a.png"));
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe("readGenerationRecords", () => {
  it("returns an empty list when the file is absent or not an array", async () => {
    expect(await readGenerationRecords("/proj")).toEqual([]);
    files.set(RECORD, JSON.stringify({ nope: true }));
    expect(await readGenerationRecords("/proj")).toEqual([]);
  });
});

describe("writeCandidates", () => {
  it("names each candidate by turn and index, keeping the returned order", async () => {
    const paths = await writeCandidates("/proj", "sess", "t1", [
      { dataUrl: "data:image/png;base64,AA" },
      { dataUrl: "data:image/webp;base64,BB" },
    ]);
    expect(paths).toEqual([
      "/proj/.ai-writer/tmp/imagegen/sess/t1-0.png",
      "/proj/.ai-writer/tmp/imagegen/sess/t1-1.webp",
    ]);
  });
});
