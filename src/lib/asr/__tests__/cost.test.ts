import { describe, expect, it } from "vitest";
import { estimateCost, formatBytes, wavDurationSeconds } from "../cost";

/** 拼一个 RIFF/WAVE 头：可选的 LIST 块、指定 byteRate 与 data 长度。 */
function wav(opts: { byteRate: number; dataBytes: number; list?: boolean; dataSizeField?: number }): Uint8Array {
  const chunks: number[] = [];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  chunks.push(...ascii("RIFF"), ...u32(0), ...ascii("WAVE"));
  chunks.push(...ascii("fmt "), ...u32(16), ...u16(1), ...u16(1), ...u32(opts.byteRate / 2), ...u32(opts.byteRate), ...u16(2), ...u16(16));
  if (opts.list) chunks.push(...ascii("LIST"), ...u32(5), ...ascii("INFOx"), 0 /* pad */);
  chunks.push(...ascii("data"), ...u32(opts.dataSizeField ?? opts.dataBytes));
  const head = Uint8Array.from(chunks);
  const out = new Uint8Array(head.byteLength + opts.dataBytes);
  out.set(head);
  return out;
}

describe("wavDurationSeconds", () => {
  it("标准 44 字节头：data 长度 / byteRate", () => {
    expect(wavDurationSeconds(wav({ byteRate: 44_100, dataBytes: 88_200 }))).toBe(2);
  });
  it("fmt 和 data 之间夹 LIST 块（奇数长度补齐）也能跳过", () => {
    expect(wavDurationSeconds(wav({ byteRate: 32_000, dataBytes: 96_000, list: true }))).toBe(3);
  });
  it("流式写出的 data 长度 0 / 0xFFFFFFFF：用文件大小减头", () => {
    expect(wavDurationSeconds(wav({ byteRate: 32_000, dataBytes: 64_000, dataSizeField: 0 }))).toBe(2);
    expect(wavDurationSeconds(wav({ byteRate: 32_000, dataBytes: 64_000, dataSizeField: 0xffffffff }))).toBe(2);
  });
  // 回归：调用方只拿得到前 64KB，而流式写出的 WAV 的时长只能由「data 块一直到
  // 文件末尾」反推。拿前缀去反推，一小时的录音会算成半秒，而那个数字随后印在一张
  // 付费确认卡上。
  it("只给文件头时，流式 data 长度要按真实文件大小算，不是按手里这段前缀", () => {
    const whole = wav({ byteRate: 176_400, dataBytes: 176_400 * 3600, dataSizeField: 0 });
    const head = whole.subarray(0, 64 * 1024);
    expect(wavDurationSeconds(head, whole.byteLength)).toBeCloseTo(3600, 0);
    // 没告诉它真实大小时只能量到前缀——所以调用方必须传。
    expect(wavDurationSeconds(head)).toBeLessThan(1);
  });
  it("data 长度字段可信时，前缀与整份文件给出同一个答案", () => {
    const whole = wav({ byteRate: 32_000, dataBytes: 96_000 });
    expect(wavDurationSeconds(whole.subarray(0, 64), whole.byteLength)).toBe(3);
  });
  // 回归：byteRate 在块内第 8 字节起的 4 个字节，读得到它要到 offset+20；
  // 判据写成 +16 时缓冲区正好断在这 4 个字节里会让 getUint32 抛 RangeError。
  it("缓冲区断在 fmt 的 byteRate 中间 → null，不抛", () => {
    const whole = wav({ byteRate: 44_100, dataBytes: 88_200 });
    for (let cut = 44; cut >= 20; cut--) {
      expect(() => wavDurationSeconds(whole.subarray(0, cut))).not.toThrow();
    }
    expect(wavDurationSeconds(whole.subarray(0, 30))).toBeNull();
  });
  it("不是 WAV / 太短 / byteRate 为 0 → null", () => {
    expect(wavDurationSeconds(new Uint8Array([0xff, 0xfb, 0x90]))).toBeNull();
    expect(wavDurationSeconds(new Uint8Array(10))).toBeNull();
    expect(wavDurationSeconds(wav({ byteRate: 0, dataBytes: 100 }))).toBeNull();
  });
});

describe("estimateCost", () => {
  it("秒 × 单价，保留 4 位；没单价 / 负数 → null", () => {
    expect(estimateCost(48, 0.00022)).toBe(0.0106);
    expect(estimateCost(3600, 0.00022)).toBe(0.792);
    expect(estimateCost(48, undefined)).toBeNull();
    expect(estimateCost(-1, 0.1)).toBeNull();
    expect(estimateCost(1, -0.1)).toBeNull();
  });
});

describe("formatBytes", () => {
  it("MB 一位小数、KB 取整、字节原样", () => {
    expect(formatBytes(2_436_376)).toBe("2.3MB");
    expect(formatBytes(27_212)).toBe("27KB");
    expect(formatBytes(512)).toBe("512B");
  });
});
