import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  flacDurationSeconds, id3v2End, mp3DurationSeconds, oggLastGranule, probeDurationSeconds, type RangeReader,
} from "../duration";

// Fixtures are 3.7s of sine made with ffmpeg; the expected values are ffprobe's
// `format=duration` for each file (2026-09-14).
const FIX = join(__dirname, "fixtures", "duration");
const load = (name: string) => new Uint8Array(readFileSync(join(FIX, name)));

/**
 * Probe a whole file the way the app does: a head of `headBytes`, the real size,
 * and a range reader over the rest — counting the reads, so a test can pin that
 * the probe never reads the whole file.
 */
async function probe(name: string, ext: string, headBytes = 64 * 1024) {
  const file = load(name);
  const reads: [number, number][] = [];
  const read: RangeReader = async (offset, length) => {
    reads.push([offset, length]);
    return file.subarray(offset, Math.min(file.length, offset + Math.min(length, 1024 * 1024)));
  };
  const seconds = await probeDurationSeconds(ext, { size: file.length, head: file.subarray(0, headBytes) }, read);
  return { seconds, reads, size: file.length };
}

describe("probeDurationSeconds", () => {
  it.each([
    ["cbr.mp3", "mp3", 3.7],
    ["vbr.mp3", "mp3", 3.7],
    ["cover.mp3", "mp3", 3.7],
    ["cbr_noxing.mp3", "mp3", 3.76],
    ["fast.m4a", "m4a", 3.7],
    ["tailmoov.m4a", "m4a", 3.7],
    ["f.flac", "flac", 3.7],
    ["opus.ogg", "ogg", 3.7065],
    ["hello-world.wav", "wav", null],
  ])("%s reads %s from the container", async (name, ext, expected) => {
    const file = name === "hello-world.wav" ? new Uint8Array(readFileSync(join(__dirname, "fixtures", name))) : null;
    if (file) {
      // The WAV path is the existing header parser; only pin that it answers.
      const s = await probeDurationSeconds("wav", { size: file.length, head: file.subarray(0, 64 * 1024) }, async () => new Uint8Array());
      expect(s).toBeGreaterThan(0);
      return;
    }
    const { seconds } = await probe(name, ext);
    // CBR without a Xing header is estimated from bytes and bitrate: ffprobe's own
    // number for that file is an estimate too, so the tolerance is a few percent.
    expect(seconds).not.toBeNull();
    expect(Math.abs(seconds! - (expected as number)) / (expected as number)).toBeLessThan(0.03);
  });

  it("reaches past a tiny head with bounded range reads, never the whole file", async () => {
    // Heads too short for what each format needs: m4a's moov is at the end, the
    // mp3's first frame is behind a cover image, Ogg's length is the last page,
    // and 16 bytes stops inside FLAC's STREAMINFO.
    for (const [name, ext, headBytes] of [["tailmoov.m4a", "m4a", 64], ["cover.mp3", "mp3", 64], ["opus.ogg", "ogg", 64], ["f.flac", "flac", 16]] as const) {
      const { seconds, reads, size } = await probe(name, ext, headBytes);
      expect(seconds, name).not.toBeNull();
      expect(reads.length, name).toBeGreaterThan(0);
      const covered = reads.reduce((n, [, len]) => n + len, 0);
      // m4a walks box headers (16 bytes each) and reads moov's start; the others
      // take one small slice. None of them may amount to reading the file.
      expect(reads.every(([, len]) => len <= 1024 * 1024), name).toBe(true);
      if (name !== "opus.ogg" && name !== "tailmoov.m4a") expect(covered, name).toBeLessThan(size);
    }
  });

  it("finds moov at the end of a file written without fast start", async () => {
    const file = load("tailmoov.m4a");
    // The fixture really is the case under test: mdat comes before moov.
    expect(String.fromCharCode(...file.subarray(40, 44))).toBe("mdat");
    const { seconds } = await probe("tailmoov.m4a", "m4a", 64);
    expect(seconds).toBeCloseTo(3.7, 1);
  });

  it("answers null instead of guessing", async () => {
    // Ogg FLAC has no Vorbis / Opus identification header we read.
    expect((await probe("flac_in.ogg", "ogg")).seconds).toBeNull();
    // A format with no parser, and a reader that fails.
    expect(await probeDurationSeconds("aac", { size: 10, head: new Uint8Array(10) }, async () => new Uint8Array())).toBeNull();
    const failing: RangeReader = async () => { throw new Error("gone"); };
    const cover = load("cover.mp3");
    expect(await probeDurationSeconds("mp3", { size: cover.length, head: cover.subarray(0, 32) }, failing)).toBeNull();
    // Garbage with the right extension.
    expect(await probeDurationSeconds("m4a", { size: 64, head: new Uint8Array(64) }, async () => new Uint8Array(16))).toBeNull();
  });
});

describe("the pure parsers", () => {
  it("id3v2End reads the synchsafe tag size (and the footer flag)", () => {
    const tag = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x02, 0x01]);
    expect(id3v2End(tag)).toBe(10 + 257);
    tag[5] = 0x10;
    expect(id3v2End(tag)).toBe(10 + 257 + 10);
    expect(id3v2End(new Uint8Array([0xff, 0xfb, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(0);
  });

  it("mp3 CBR without a Xing header: audio bytes × 8 ÷ bitrate", () => {
    // MPEG-1 Layer III, 128 kbps, 44.1 kHz frame header, then silence.
    const b = new Uint8Array(4096);
    b.set([0xff, 0xfb, 0x90, 0x00]);
    expect(mp3DurationSeconds(b, 0, 16000)).toBeCloseTo((16000 * 8) / 128000, 5);
  });

  it("flac STREAMINFO: total samples ÷ sample rate", () => {
    const b = new Uint8Array(42);
    b.set([0x66, 0x4c, 0x61, 0x43, 0x00, 0, 0, 34]);
    // 8000 Hz = 0x01F40 in 20 bits; total samples 16000.
    const d = 8;
    b[d + 10] = 0x01; b[d + 11] = 0xf4; b[d + 12] = 0x00;
    b[d + 13] = 0x00; b[d + 14] = 0; b[d + 15] = 0; b[d + 16] = 0x3e; b[d + 17] = 0x80;
    expect(flacDurationSeconds(b)).toBe(2);
  });

  it("ogg: the last page with a real granule wins; -1 pages are skipped", () => {
    const page = (granule: number | "none") => {
      const p = new Uint8Array(27);
      p.set([0x4f, 0x67, 0x67, 0x53]);
      const v = new DataView(p.buffer);
      if (granule === "none") { v.setUint32(6, 0xffffffff, true); v.setUint32(10, 0xffffffff, true); }
      else v.setUint32(6, granule, true);
      return p;
    };
    const tail = new Uint8Array(81);
    tail.set(page(1000), 0);
    tail.set(page(2000), 27);
    tail.set(page("none"), 54);
    expect(oggLastGranule(tail)).toBe(2000);
  });
});
