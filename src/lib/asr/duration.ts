/**
 * 批准之前能知道的时长：从容器头算，必要时加几段**有界**的区间读——不解码，不读
 * 整个文件（执行方案 §1 不变量 7）。
 *
 * 为什么要它：同步识别有 5 分钟上限，而一段 330 秒的 mp3 只有 1.3MB，只看大小拦
 * 不住，要等作者点了头、平台回 400 才知道；确认卡上的估价也只有 WAV 算得出。各格式
 * 的时长都写在不解码就读得到的地方：
 *
 *   - WAV：`fmt ` 的字节率 + `data` 块长度（`cost.ts`）。
 *   - MP3：第一帧里的 Xing / Info / VBRI 头给总帧数（VBR 必须靠它）；没有这个头
 *     就是 CBR，按「音频字节 × 8 ÷ 码率」算。ID3v2 标签可能带一张大封面，把第一帧
 *     推到文件头读数之外，所以帧要从标签末尾另读一段。
 *   - FLAC：STREAMINFO 的总采样数 ÷ 采样率，就在 `fLaC` 后面。
 *   - Ogg（Vorbis / Opus）：采样率在第一页的标识包里，总时长是**最后一页**的
 *     granule position——读文件尾 64KB。Opus 的 granule 以 48kHz 计，要减 pre-skip。
 *   - MP4 / M4A / MOV：`moov/mvhd` 的 duration ÷ timescale。没做 fast start 的
 *     文件 `moov` 在末尾，所以逐个读顶层盒子的 16 字节头跳过去，找到 `moov` 再读它
 *     的开头。
 *
 * 读不出就是 null——宁可卡上不显示、交给平台说话，也不显示一个错的数。这个数会
 * 印在付费确认卡上，也决定同步识别拦不拦。
 */

import { wavDurationSeconds } from "./cost";

/** `offset` 起最多 `length` 字节；文件更短时返回更少。 */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

/** 调用方读文件头时用的长度——和 `readFileHead` 的 64KB 一致。 */
const DURATION_HEAD_BYTES = 64 * 1024;

/** 区间读的单次上限（Rust 侧 `fs_read_range` 同样封顶在 1MiB）。 */
const MAX_RANGE = 1024 * 1024;

const u32be = (b: Uint8Array, o: number): number =>
  ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u32le = (b: Uint8Array, o: number): number =>
  ((b[o + 3] << 24) >>> 0) + (b[o + 2] << 16) + (b[o + 1] << 8) + b[o];
const u16le = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const fourcc = (b: Uint8Array, o: number): string =>
  o + 4 <= b.length ? String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) : "";

/** ID3v2 标签之后的偏移；没有标签就是 0。标签长度是 synchsafe（每字节 7 位）。 */
export function id3v2End(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const footer = b[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
/** 按版本位：3 = MPEG-1，2 = MPEG-2，0 = MPEG-2.5（1 是保留值）。 */
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/**
 * MP3 的时长。`b` 从音频起点（ID3v2 标签之后）开始；`audioStart` 是它在文件里的
 * 偏移，`fileSize` 是整个文件的长度——CBR 按剩余字节算。只认 Layer III。
 */
export function mp3DurationSeconds(b: Uint8Array, audioStart: number, fileSize: number): number | null {
  // 第一帧前可能有几字节垃圾（残缺的标签、填充），在开头一小段里找帧同步。
  const limit = Math.min(b.length - 4, 4096);
  for (let i = 0; i <= limit; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[i + 1] >> 3) & 3;
    const layer = (b[i + 1] >> 1) & 3;
    const brIdx = b[i + 2] >> 4;
    const srIdx = (b[i + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const mpeg1 = version === 3;
    const rate = SAMPLE_RATES[version][srIdx];
    const samplesPerFrame = mpeg1 ? 1152 : 576;
    const mono = ((b[i + 3] >> 6) & 3) === 3;
    // Xing / Info 头紧跟在帧头 + side info 之后，side info 长度随版本与声道变。
    const xing = i + 4 + (mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17);
    const tag = fourcc(b, xing);
    if ((tag === "Xing" || tag === "Info") && xing + 12 <= b.length && u32be(b, xing + 4) & 1) {
      const frames = u32be(b, xing + 8);
      if (frames > 0) return (frames * samplesPerFrame) / rate;
    }
    // Fraunhofer 的 VBRI 头固定在帧头后 32 字节。
    const vbri = i + 4 + 32;
    if (fourcc(b, vbri) === "VBRI" && vbri + 18 <= b.length) {
      const frames = u32be(b, vbri + 14);
      if (frames > 0) return (frames * samplesPerFrame) / rate;
    }
    const bitrate = (mpeg1 ? BITRATE_V1_L3 : BITRATE_V2_L3)[brIdx] * 1000;
    const audioBytes = fileSize - audioStart - i;
    return audioBytes > 0 ? (audioBytes * 8) / bitrate : null;
  }
  return null;
}

/** FLAC 的时长：`at` 处是 `fLaC`，后面第一个元数据块必须是 STREAMINFO。 */
export function flacDurationSeconds(b: Uint8Array, at = 0): number | null {
  if (fourcc(b, at) !== "fLaC") return null;
  if ((b[at + 4] & 0x7f) !== 0) return null;
  const d = at + 8;
  if (d + 18 > b.length) return null;
  const rate = (b[d + 10] << 12) | (b[d + 11] << 4) | (b[d + 12] >> 4);
  const total = (b[d + 13] & 0x0f) * 2 ** 32 + u32be(b, d + 14);
  return rate > 0 && total > 0 ? total / rate : null;
}

/** Ogg 第一页的标识包：采样率，和 Opus 要减掉的 pre-skip。 */
function oggStreamInfo(b: Uint8Array): { rate: number; preSkip: number } | null {
  if (fourcc(b, 0) !== "OggS" || b.length < 28) return null;
  const payload = 27 + b[26];
  if (fourcc(b, payload) === "Opus" && fourcc(b, payload + 4) === "Head" && payload + 12 <= b.length) {
    // Opus 的 granule position 永远以 48kHz 计，与原始采样率无关。
    return { rate: 48000, preSkip: u16le(b, payload + 10) };
  }
  if (b[payload] === 1 && String.fromCharCode(...b.subarray(payload + 1, payload + 7)) === "vorbis" && payload + 16 <= b.length) {
    const rate = u32le(b, payload + 12);
    return rate > 0 ? { rate, preSkip: 0 } : null;
  }
  return null;
}

/** 一段尾部字节里**最后一页**的 granule position；-1（「这一页没有结束的包」）跳过。 */
export function oggLastGranule(tail: Uint8Array): number | null {
  for (let i = tail.length - 27; i >= 0; i--) {
    if (tail[i] !== 0x4f || fourcc(tail, i) !== "OggS") continue;
    const lo = u32le(tail, i + 6);
    const hi = u32le(tail, i + 10);
    if (lo === 0xffffffff && hi === 0xffffffff) continue;
    return hi * 2 ** 32 + lo;
  }
  return null;
}

/** `moov` 盒子开头这一段里的 `mvhd`（通常是第一个子盒子）。`hlen` 是 moov 自己的头长。 */
function mvhdDurationSeconds(moov: Uint8Array, hlen: number): number | null {
  let q = hlen;
  while (q + 8 <= moov.length) {
    const size = u32be(moov, q);
    if (fourcc(moov, q + 4) === "mvhd") {
      const body = q + 8;
      const v = moov[body];
      const [tsAt, durAt, need] = v === 1 ? [20, 24, 32] : [12, 16, 20];
      if (body + need > moov.length) return null;
      const timescale = u32be(moov, body + tsAt);
      const duration = v === 1 ? u32be(moov, body + durAt) * 2 ** 32 + u32be(moov, body + durAt + 4) : u32be(moov, body + durAt);
      return timescale > 0 && duration > 0 ? duration / timescale : null;
    }
    // 64 位长度或「到结尾」的子盒子在 moov 开头极少见；遇到就停，不猜。
    if (size < 8) return null;
    q += size;
  }
  return null;
}

/** 从文件头（够的话）或区间读里取 `[offset, offset+length)`。 */
async function bytesAt(head: Uint8Array, offset: number, length: number, read: RangeReader): Promise<Uint8Array> {
  if (offset + length <= head.length) return head.subarray(offset, offset + length);
  return read(offset, Math.min(length, MAX_RANGE));
}

/** MP4 家族：逐个跳过顶层盒子找 `moov`。最多看 256 个，防一个坏文件让它一直读。 */
async function mp4DurationSeconds(head: Uint8Array, size: number, read: RangeReader): Promise<number | null> {
  let p = 0;
  for (let n = 0; n < 256 && p + 8 <= size; n++) {
    const hdr = await bytesAt(head, p, Math.min(16, size - p), read);
    if (hdr.length < 8) return null;
    let boxSize = u32be(hdr, 0);
    let hlen = 8;
    if (boxSize === 1) {
      if (hdr.length < 16) return null;
      boxSize = u32be(hdr, 8) * 2 ** 32 + u32be(hdr, 12);
      hlen = 16;
    } else if (boxSize === 0) {
      boxSize = size - p;
    }
    if (boxSize < hlen) return null;
    if (fourcc(hdr, 4) === "moov") {
      const moov = await bytesAt(head, p, Math.min(boxSize, MAX_RANGE), read);
      return mvhdDurationSeconds(moov, hlen);
    }
    p += boxSize;
  }
  return null;
}

/**
 * 这个文件的时长（秒），读不出就是 null。从不抛——任何一步读失败都当「不知道」。
 *
 * `head` 是 `readFileHead(path, DURATION_HEAD_BYTES)` 的结果（`size` 必须是整个
 * 文件的真实长度）；`read` 只在头里不够时才被调用，每次最多 1MiB，一个文件最多
 * 几次——批准之前永远不会把整个文件读进来。
 */
export async function probeDurationSeconds(
  ext: string,
  head: { size: number; head: Uint8Array },
  read: RangeReader,
): Promise<number | null> {
  const ok = (s: number | null) => (s !== null && Number.isFinite(s) && s > 0 ? s : null);
  const { size, head: b } = head;
  try {
    switch (ext.toLowerCase()) {
      case "wav":
        return ok(wavDurationSeconds(b, size));
      case "mp3": {
        const start = id3v2End(b);
        const frame = await bytesAt(b, start, Math.min(8192, Math.max(0, size - start)), read);
        return ok(mp3DurationSeconds(frame, start, size));
      }
      case "flac": {
        const start = id3v2End(b);
        const block = await bytesAt(b, start, Math.min(64, Math.max(0, size - start)), read);
        return ok(flacDurationSeconds(block));
      }
      case "ogg":
      case "opus": {
        const info = oggStreamInfo(b);
        if (!info) return null;
        const tailLength = Math.min(size, DURATION_HEAD_BYTES);
        const tail = await bytesAt(b, size - tailLength, tailLength, read);
        const granule = oggLastGranule(tail);
        return granule === null ? null : ok((granule - info.preSkip) / info.rate);
      }
      case "m4a":
      case "mp4":
      case "m4v":
      case "mov":
      case "3gp":
        return ok(await mp4DurationSeconds(b, size, read));
      default:
        return null;
    }
  } catch {
    return null;
  }
}
