import { beforeEach, describe, expect, it, vi } from "vitest";

// 不变量 7 + 同步上限：绑的是同步模型时，超限的文件在**审批卡之前**被拒——
// 那时什么都还没发出去；平台自己的 400 要等作者点了头才来。

const state = vi.hoisted(() => ({
  head: { size: 0, head: new Uint8Array() } as { size: number; head: Uint8Array },
  conn: null as unknown,
}));

vi.mock("../../fs/fileio", () => ({
  fileExists: async () => true,
  readFileHead: async () => state.head,
}));
vi.mock("../conn", () => ({
  resolveAsrConn: async () => state.conn,
  isAsrUnavailable: (r: object) => "reason" in r,
}));
vi.mock("../run", () => ({
  MAX_TRANSCRIBE_BYTES: 512 * 1024 * 1024,
  transcriptTargetFor: async (p: string) => p.replace(/\.[^.]+$/, ".md"),
}));
vi.mock("../flag", () => ({ isAsrDiarizationDefault: () => true }));

import { transcribeAudioTool } from "../tool";
import type { ToolContext, TranscribeProposal } from "../../agent/registry";

const MB = 1024 * 1024;

function connOf(format: "dashscope-sync" | "dashscope-filetrans") {
  return {
    format,
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "k",
    modelId: format === "dashscope-sync" ? "qwen3-asr-flash" : "qwen-audio-3.0-asr-flash-filetrans",
    provider: { id: "p" },
    model: { id: "m", name: "千问 · 同步识别", pricePerSecond: undefined },
  };
}

/**
 * A canonical 44-byte WAV header claiming `seconds` of 8kHz mono 8-bit audio —
 * 8KB a second, so 400 seconds is 3.2MB and the duration check, not the size
 * check, is the one that fires.
 */
function wavHeader(seconds: number): { size: number; head: Uint8Array } {
  const byteRate = 8_000;
  const data = byteRate * seconds;
  const b = new Uint8Array(44);
  const v = new DataView(b.buffer);
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i); };
  tag(0, "RIFF"); v.setUint32(4, 36 + data, true); tag(8, "WAVE");
  tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16_000, true); v.setUint32(28, byteRate, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, "data"); v.setUint32(40, data, true);
  return { size: 44 + data, head: b };
}

let proposals: TranscribeProposal[] = [];
const ctx = {
  projectPath: "/p",
  requestApproval: vi.fn(async (p: TranscribeProposal) => {
    proposals.push(p);
    return { approved: true, backupPath: null };
  }),
} as unknown as ToolContext;

beforeEach(() => {
  proposals = [];
  vi.mocked(ctx.requestApproval!).mockClear();
});

describe("transcribe_audio × 同步模型", () => {
  it("超过 10MB：批准之前拒绝，指路录音文件识别模型，不出卡", async () => {
    state.conn = connOf("dashscope-sync");
    state.head = { size: 12 * MB, head: new Uint8Array(64) };
    const r = await transcribeAudioTool("c1", { path: "采访.mp3" }, ctx);
    expect(r.content).toMatch(/^Error: .*12\.0MB.*10MB/);
    expect(r.content).toMatch(/\*-filetrans/);
    expect(ctx.requestApproval).not.toHaveBeenCalled();
  });
  it("白名单外的格式、WAV 头算出超 5 分钟：一样拒", async () => {
    state.conn = connOf("dashscope-sync");
    state.head = { size: MB, head: new Uint8Array(64) };
    expect((await transcribeAudioTool("c2", { path: "a.wma" }, ctx)).content).toMatch(/\.wma/);
    state.head = wavHeader(400);
    expect((await transcribeAudioTool("c3", { path: "a.wav" }, ctx)).content).toMatch(/400 seconds.*5-minute/);
    expect(ctx.requestApproval).not.toHaveBeenCalled();
  });
  it("在限内：出卡，分离恒关、人数不带、sync 标记；结果文本说没有时间戳与说话人，并说明分离参数被忽略", async () => {
    state.conn = connOf("dashscope-sync");
    state.head = wavHeader(6);
    const r = await transcribeAudioTool("c4", { path: "a.wav", diarization: true, speaker_count: 3, language_hints: ["zh"] }, ctx);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ sync: true, diarization: false, languageHints: ["zh"], seconds: 6 });
    expect(proposals[0].speakerCount).toBeUndefined();
    expect(r.content).toMatch(/no timestamps and no speaker labels/);
    expect(r.content).toMatch(/diarization \/ speaker_count arguments were ignored/);
  });
  it("录音文件识别模型不受同步上限影响，分离照传", async () => {
    state.conn = connOf("dashscope-filetrans");
    state.head = { size: 12 * MB, head: new Uint8Array(64) };
    const r = await transcribeAudioTool("c5", { path: "a.mp3", diarization: true }, ctx);
    expect(proposals[0]).toMatchObject({ diarization: true });
    expect(proposals[0].sync).toBeUndefined();
    expect(r.content).not.toMatch(/timestamps/);
  });
});
