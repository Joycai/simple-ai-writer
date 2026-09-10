/**
 * 上传之前能知道多少：时长（只有 WAV 从文件头算得出）和据此估的费用。纯函数。
 *
 * mp3 / m4a / mp4 的时长要解码整个流才知道（VBR 的 mp3 连比特率都不定），
 * 上传前只能给大小；平台在结果里报的 `usage.duration` 才是真正计费的秒数，
 * 入账用那一个（`run.ts`），这里的估价只是确认卡上的那一格。
 */

/**
 * 从 RIFF/WAVE 文件头算时长（秒）。不是 WAV、头不完整、或者 `fmt ` 块在
 * `data` 块之后（非标准，但存在）就 null——宁可卡上不显示，也不显示一个错的。
 *
 * 只看前面几个块：`data` 块的长度字段就是样本字节数，除以字节率即秒数；
 * 遇到 `LIST`（元数据）之类的块按长度跳过。`bytes` 只需要文件头。
 *
 * `totalBytes` 是**整个文件**的长度，缺席才等于 `bytes.byteLength`。它只在一种
 * 情形下有分别，而那一种是必须的：流式写出的 WAV（录音软件、`ffmpeg` 管道）把
 * data 的长度字段写成 0 或 0xFFFFFFFF，真正的长度只能由「data 块一直到文件末尾」
 * 反推——拿手里这段前缀去反推，一小时的录音会算成半秒，而这个数字随后就印在一张
 * 付费确认卡上。调用方拿得到真实大小（`readFileHead` 的 `size`），传进来。
 */
export function wavDurationSeconds(bytes: Uint8Array, totalBytes?: number): number | null {
  if (bytes.byteLength < 44) return null;
  // 前缀不可能比整个文件长；真这样就是调用方搞错了，以手里这段为准。
  const total = totalBytes !== undefined && totalBytes >= bytes.byteLength ? totalBytes : bytes.byteLength;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let byteRate: number | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      // byteRate 是块内第 8 字节起的 4 个字节，所以要读到 offset+20 才算读得到；
      // 写成 +16 会在缓冲区正好断在这 4 个字节里时让 getUint32 抛 RangeError。
      if (offset + 20 > bytes.byteLength) return null;
      byteRate = view.getUint32(offset + 16, true);
      if (!byteRate) return null;
    } else if (id === "data") {
      if (byteRate === null) return null;
      // 流式写出的 WAV 会把 data 长度写成 0 或 0xFFFFFFFF；那就用文件大小减头。
      const dataBytes = size === 0 || size === 0xffffffff ? Math.max(0, total - offset - 8) : size;
      return dataBytes / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** 秒 × 每秒单价，保留到 4 位——一分钟音频是 ¥0.0132 这种量级，两位小数会显示成 0.01 或 0。 */
export function estimateCost(seconds: number, pricePerSecond: number | undefined): number | null {
  if (pricePerSecond === undefined || !Number.isFinite(pricePerSecond) || pricePerSecond < 0) return null;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * pricePerSecond * 10_000) / 10_000;
}

/** 确认卡 / 痕迹上的大小：`2.4MB` / `320KB`。 */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}
