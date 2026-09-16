/**
 * lib/fs/video: the MP4/MOV header parser (hand-built boxes + one real clip),
 * and the reader's order of operations — size before bytes, duration before
 * base64.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../fileio", () => ({
  readFileHead: vi.fn(),
  readBinaryFile: vi.fn(),
}));

import { readBinaryFile, readFileHead } from "../fileio";
import { MAX_VIDEO_BYTES, parseMp4Info, readVideoForModel, videoMimeOf } from "../video";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

// ── Box builders ────────────────────────────────────────────────────────────
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be64 = (n: number) => [...be32(Math.floor(n / 2 ** 32)), ...be32(n >>> 0)];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, ...body: number[][]): number[] => {
  const payload = body.flat();
  return [...be32(8 + payload.length), ...ascii(type), ...payload];
};
/** Same box, spelled with a 64-bit `largesize`. */
const bigBox = (type: string, ...body: number[][]): number[] => {
  const payload = body.flat();
  return [...be32(1), ...ascii(type), ...be64(16 + payload.length), ...payload];
};
const zeros = (n: number) => new Array<number>(n).fill(0);

const mvhd0 = (timescale: number, duration: number) =>
  box("mvhd", [0, 0, 0, 0], be32(0), be32(0), be32(timescale), be32(duration), zeros(80));
const mvhd1 = (timescale: number, duration: number) =>
  box("mvhd", [1, 0, 0, 0], be64(0), be64(0), be32(timescale), be64(duration), zeros(80));
const tkhd0 = (w: number, h: number) =>
  box("tkhd", [0, 0, 0, 7], be32(0), be32(0), be32(1), be32(0), be32(0), zeros(8), zeros(8), zeros(36), be32(w * 65536), be32(h * 65536));
const tkhd1 = (w: number, h: number) =>
  box("tkhd", [1, 0, 0, 7], be64(0), be64(0), be32(1), be32(0), be64(0), zeros(8), zeros(8), zeros(36), be32(w * 65536), be32(h * 65536));
const hdlr = (kind: string) => box("hdlr", [0, 0, 0, 0], be32(0), ascii(kind), zeros(12), [0]);
const trak = (tk: number[], kind: string) => box("trak", tk, box("mdia", hdlr(kind)));

describe("parseMp4Info", () => {
  it("reads duration and the video track's size from version-0 boxes", () => {
    const file = [
      ...box("ftyp", ascii("isom"), be32(0)),
      ...box("moov", mvhd0(1000, 2500), trak(tkhd0(640, 480), "vide")),
    ];
    expect(parseMp4Info(new Uint8Array(file))).toEqual({ durationSec: 2.5, width: 640, height: 480 });
  });

  it("handles version-1 boxes, 64-bit sizes, and moov after mdat", () => {
    const file = [
      ...box("ftyp", ascii("isom"), be32(0)),
      ...bigBox("mdat", zeros(64)),
      ...box("moov", mvhd1(600, 36_000), trak(tkhd1(1280, 720), "vide")),
    ];
    expect(parseMp4Info(new Uint8Array(file))).toEqual({ durationSec: 60, width: 1280, height: 720 });
  });

  it("takes the video track's size, not the audio track's that came first", () => {
    const file = box("moov", mvhd0(1, 4), trak(tkhd0(1, 1), "soun"), trak(tkhd0(320, 240), "vide"));
    expect(parseMp4Info(new Uint8Array(file))).toMatchObject({ width: 320, height: 240 });
  });

  it("is null without moov, and survives a truncated box", () => {
    expect(parseMp4Info(new Uint8Array(box("ftyp", ascii("isom"))))).toBeNull();
    const cut = [...box("moov", mvhd0(1000, 3000), trak(tkhd0(640, 480), "vide"))].slice(0, 40);
    expect(() => parseMp4Info(new Uint8Array(cut))).not.toThrow();
  });

  it("reads the real 2 s 640×480 fixture (ffprobe agrees)", () => {
    const info = parseMp4Info(fixture("v2s_640.mp4"))!;
    expect(info.width).toBe(640);
    expect(info.height).toBe(480);
    expect(info.durationSec).toBeCloseTo(2, 1);
  });
});

describe("videoMimeOf", () => {
  it("knows the three containers the endpoint read, by extension", () => {
    expect(videoMimeOf("/p/a.MP4")).toBe("video/mp4");
    expect(videoMimeOf("clip.m4v")).toBe("video/mp4");
    expect(videoMimeOf("clip.mov")).toBe("video/quicktime");
    expect(videoMimeOf("clip.webm")).toBe("video/webm");
    expect(videoMimeOf("clip.mkv")).toBeNull();
    expect(videoMimeOf("song.mp3")).toBeNull();
  });
});

describe("readVideoForModel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses an oversized file without reading its bytes", async () => {
    vi.mocked(readFileHead).mockResolvedValue({ size: MAX_VIDEO_BYTES + 1, head: new Uint8Array() });
    const r = await readVideoForModel("/p/big.mp4");
    expect(r).toMatchObject({ ok: false, reason: "too-large" });
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("refuses a clip whose header says it is under 2 s (the endpoint 400s at 1 s)", async () => {
    const bytes = fixture("v1s_640.mp4");
    vi.mocked(readFileHead).mockResolvedValue({ size: bytes.length, head: new Uint8Array() });
    vi.mocked(readBinaryFile).mockResolvedValue(bytes);
    const r = await readVideoForModel("/p/v1s.mp4");
    expect(r).toMatchObject({ ok: false, reason: "too-short" });
  });

  it("returns a data URL plus what the chip needs", async () => {
    const bytes = fixture("v2s_640.mp4");
    vi.mocked(readFileHead).mockResolvedValue({ size: bytes.length, head: new Uint8Array() });
    vi.mocked(readBinaryFile).mockResolvedValue(bytes);
    const r = await readVideoForModel("/p/v2s.mp4");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.video.dataUrl.startsWith("data:video/mp4;base64,")).toBe(true);
    expect(r.video).toMatchObject({ width: 640, height: 480, sizeBytes: bytes.length });
  });

  it("lets a WebM through with no duration — the endpoint has the last word", async () => {
    vi.mocked(readFileHead).mockResolvedValue({ size: 4, head: new Uint8Array() });
    vi.mocked(readBinaryFile).mockResolvedValue(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
    const r = await readVideoForModel("/p/a.webm");
    expect(r.ok && r.video.durationSec).toBeFalsy();
    expect(r.ok && r.video.dataUrl.startsWith("data:video/webm;base64,")).toBe(true);
  });

  it("does not touch a file it cannot send", async () => {
    expect(await readVideoForModel("/p/a.mkv")).toEqual({ ok: false, reason: "unsupported" });
    expect(readFileHead).not.toHaveBeenCalled();
  });
});
