/**
 * Reading a video file for a model: which files qualify, how big they may be,
 * and what their header says about duration and frame size.
 *
 * The bytes-to-wire half of `lib/ai/videoInput.ts`. Measured limits
 * (DashScope compatible-mode, 2026-09-14 — docs/feature/video-input.md):
 *
 * - one data-URI item ≤ 20,971,520 bytes: a 17.5 MB mp4 (~23 MB of base64)
 *   was a 400, an 11.3 MB one went through. Base64 is 4/3 of the file, so the
 *   raw file must stay under ~15 MB;
 * - a clip under 2 s is a 400 "The video file is too short" (1 s refused,
 *   2 s accepted);
 * - mp4, mov and webm were all read.
 */

import { readBinaryFile, readFileHead } from "./fileio";
import { bytesToBase64 } from "./images";

/** The containers the endpoint was seen to read, by extension. */
const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/**
 * Largest file sent. 15,000,000 rather than the exact 15,728,640 that base64s
 * to 20 MiB: the measured refusal is per data-URI item, and whether the
 * `data:video/mp4;base64,` prefix counts against it was not measured.
 */
export const MAX_VIDEO_BYTES = 15_000_000;

/** Shortest clip the endpoint accepts (1 s refused, 2 s accepted). */
export const MIN_VIDEO_SECONDS = 2;

/** `video/mp4` etc. for a file a model can be sent, or null. Name or full path. */
export function videoMimeOf(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return VIDEO_MIME[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** What a container header says. Any field may be missing. */
interface VideoInfo {
  durationSec?: number;
  width?: number;
  height?: number;
}

const u32 = (b: Uint8Array, o: number): number =>
  ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u64 = (b: Uint8Array, o: number): number => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const fourcc = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

interface Box { type: string; start: number; body: number; end: number }

/** The boxes directly inside `[from, to)`. Stops at the first malformed size. */
function childBoxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = u32(b, p);
    const type = fourcc(b, p + 4);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > to) break;
      size = u64(b, p + 8);
      body = p + 16;
    } else if (size === 0) {
      size = to - p; // "extends to the end of the enclosing space"
    }
    if (size < body - p || p + size > to) break;
    out.push({ type, start: p, body, end: p + size });
    p += size;
  }
  return out;
}

const child = (b: Uint8Array, box: Box, type: string): Box | undefined =>
  childBoxes(b, box.body, box.end).find((c) => c.type === type);

/**
 * Duration and video frame size from an MP4 / MOV (ISO-BMFF / QuickTime) file.
 *
 * Needs the whole file, not a head: `moov` is at the end of any file written
 * without "fast start", and the clips this reads are capped at 15 MB and read
 * in full anyway. Duration is `moov/mvhd`; size is the `tkhd` of the track
 * whose `mdia/hdlr` says `vide` (falling back to the first track with a
 * non-zero size). Both box versions (32- and 64-bit times) are handled.
 * Returns null when there is no `moov` — a WebM, or not a video at all.
 */
export function parseMp4Info(b: Uint8Array): VideoInfo | null {
  const moov = childBoxes(b, 0, b.length).find((x) => x.type === "moov");
  if (!moov) return null;
  const info: VideoInfo = {};

  const mvhd = child(b, moov, "mvhd");
  if (mvhd) {
    const v = b[mvhd.body];
    const [tsAt, durAt, need] = v === 1 ? [20, 24, 32] : [12, 16, 20];
    if (mvhd.body + need <= mvhd.end) {
      const timescale = u32(b, mvhd.body + tsAt);
      const duration = v === 1 ? u64(b, mvhd.body + durAt) : u32(b, mvhd.body + durAt);
      if (timescale > 0 && duration > 0) info.durationSec = duration / timescale;
    }
  }

  let fallback: { width: number; height: number } | undefined;
  for (const trak of childBoxes(b, moov.body, moov.end).filter((x) => x.type === "trak")) {
    const tkhd = child(b, trak, "tkhd");
    if (!tkhd) continue;
    // Width/height are 16.16 fixed-point, the last 8 bytes of the header.
    const at = tkhd.body + (b[tkhd.body] === 1 ? 88 : 76);
    if (at + 8 > tkhd.end) continue;
    const width = Math.round(u32(b, at) / 65536);
    const height = Math.round(u32(b, at + 4) / 65536);
    if (!width || !height) continue;
    const mdia = child(b, trak, "mdia");
    const hdlr = mdia && child(b, mdia, "hdlr");
    // hdlr: version/flags(4) pre_defined(4) handler_type(4)
    if (hdlr && hdlr.body + 12 <= hdlr.end && fourcc(b, hdlr.body + 8) === "vide") {
      info.width = width;
      info.height = height;
      fallback = undefined;
      break;
    }
    fallback ??= { width, height };
  }
  if (fallback) Object.assign(info, fallback);
  return info;
}

/** A clip ready for the wire, with what the composer shows about it. */
export interface ModelVideo extends VideoInfo {
  dataUrl: string;
  sizeBytes: number;
}

type VideoReadResult =
  | { ok: true; video: ModelVideo }
  | { ok: false; reason: "too-large"; sizeBytes: number }
  | { ok: false; reason: "too-short"; durationSec: number }
  | { ok: false; reason: "unsupported" };

/**
 * Read a video file into a data URL a model can take — or say why not.
 *
 * The size check comes first and costs one `readFileHead` round trip: a
 * 2 GB recording must be refused without crossing the IPC boundary. Only then
 * is the file read whole. A known duration under {@link MIN_VIDEO_SECONDS} is
 * refused here rather than as a 400 after the author waited for the request;
 * an unknown one (WebM) is let through, and the endpoint has the last word.
 *
 * Throws only when the file cannot be read at all.
 */
export async function readVideoForModel(path: string): Promise<VideoReadResult> {
  const mime = videoMimeOf(path);
  if (!mime) return { ok: false, reason: "unsupported" };
  const { size } = await readFileHead(path, 0);
  if (size > MAX_VIDEO_BYTES) return { ok: false, reason: "too-large", sizeBytes: size };
  const bytes = await readBinaryFile(path);
  const info = mime === "video/webm" ? {} : parseMp4Info(bytes) ?? {};
  if (info.durationSec !== undefined && info.durationSec < MIN_VIDEO_SECONDS) {
    return { ok: false, reason: "too-short", durationSec: info.durationSec };
  }
  return {
    ok: true,
    video: { ...info, sizeBytes: bytes.length, dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}` },
  };
}
