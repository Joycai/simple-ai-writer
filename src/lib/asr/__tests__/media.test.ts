import { describe, expect, it } from "vitest";
import {
  asrIdMismatch,
  looksLikeFiletransModel,
  looksLikeSyncAsrModel,
  syncRefusal,
  syncRefusalText,
  transcribeExtOf,
  ASR_DEFAULT_MODEL_ID,
  SYNC_MAX_BYTES,
  SYNC_MAX_SECONDS,
} from "../formats";
import { classifyProjectFile } from "../../fs/images";
import { importMode } from "../../import";

// 2026-09-06 真机第一次跑撞上的三件事：绑了同步接口的模型、导入不收音频、@ 不到音频。

describe("looksLikeFiletransModel", () => {
  it("只认 *-filetrans；同步接口的 qwen3-asr-flash 系列和对话模型都不是", () => {
    expect(looksLikeFiletransModel("qwen-audio-3.0-asr-flash-filetrans")).toBe(true);
    expect(looksLikeFiletransModel("qwen3-asr-flash-filetrans-2025-11-17")).toBe(true);
    expect(looksLikeFiletransModel("qwen3-asr-flash-2026-02-10")).toBe(false);
    expect(looksLikeFiletransModel("qwen-audio-3.0-asr-flash")).toBe(false);
    expect(looksLikeFiletransModel("qwen3.8-flash")).toBe(false);
  });
});

// 2026-09-14 实测：同步接口只有 qwen3-asr-flash 一代（别名与日期快照都行）；
// qwen-audio-3.0-asr-flash / fun-asr-flash 答「format is empty」。
describe("looksLikeSyncAsrModel / asrIdMismatch", () => {
  it("只认 qwen3-asr-flash 系列，filetrans / realtime / 别的 ASR 家族都不是", () => {
    expect(looksLikeSyncAsrModel("qwen3-asr-flash")).toBe(true);
    expect(looksLikeSyncAsrModel("qwen3-asr-flash-2026-02-10")).toBe(true);
    expect(looksLikeSyncAsrModel("qwen3-asr-flash-filetrans")).toBe(false);
    expect(looksLikeSyncAsrModel("qwen3-asr-flash-realtime")).toBe(false);
    expect(looksLikeSyncAsrModel("qwen-audio-3.0-asr-flash")).toBe(false);
    expect(looksLikeSyncAsrModel("fun-asr-flash-2026-06-15")).toBe(false);
  });
  it("模型行选的接口决定 id 对不对；两个默认 id 各自成立", () => {
    expect(asrIdMismatch("dashscope-filetrans", "qwen3-asr-flash")).toBe("not-filetrans");
    expect(asrIdMismatch("dashscope-sync", "qwen-audio-3.0-asr-flash-filetrans")).toBe("not-sync");
    expect(asrIdMismatch("dashscope-sync", "qwen-audio-3.0-asr-flash")).toBe("not-sync");
    expect(asrIdMismatch("dashscope-filetrans", ASR_DEFAULT_MODEL_ID["dashscope-filetrans"])).toBeNull();
    expect(asrIdMismatch("dashscope-sync", ASR_DEFAULT_MODEL_ID["dashscope-sync"])).toBeNull();
  });
});

describe("syncRefusal（批准之前的同步上限）", () => {
  it("六个实测过的扩展名收，其余拒；大小写无关", () => {
    for (const ext of ["wav", "mp3", "m4a", "ogg", "flac", "mp4", "MP3"]) expect(syncRefusal(ext, 1000, null)).toBeNull();
    expect(syncRefusal("wma", 1000, null)).toEqual({ reason: "ext", ext: "wma" });
    expect(syncRefusal("mkv", 1000, null)?.reason).toBe("ext");
  });
  it("10MB 正好收，多一字节拒（实测 13MB 400「Multimodal file size is too large」）", () => {
    expect(syncRefusal("mp3", SYNC_MAX_BYTES, null)).toBeNull();
    expect(syncRefusal("mp3", SYNC_MAX_BYTES + 1, null)).toEqual({ reason: "bytes", bytes: SYNC_MAX_BYTES + 1 });
  });
  it("时长只在知道时拦：300 秒收，301 拒；不知道（非 WAV）不拦（实测 330 秒 400「The audio is too long」）", () => {
    expect(syncRefusal("wav", 1000, SYNC_MAX_SECONDS)).toBeNull();
    expect(syncRefusal("wav", 1000, 301)).toEqual({ reason: "seconds", seconds: 301 });
    expect(syncRefusal("mp3", 1000, null)).toBeNull();
  });
  it("拒绝的英文句子说出上限", () => {
    expect(syncRefusalText({ reason: "bytes", bytes: 12 * 1024 * 1024 })).toMatch(/12\.0MB.*10MB/);
    expect(syncRefusalText({ reason: "seconds", seconds: 400 })).toMatch(/400 seconds.*5-minute/);
    expect(syncRefusalText({ reason: "ext", ext: "wma" })).toMatch(/\.wma.*wav, mp3, m4a, ogg, flac, mp4/);
  });
});

describe("media as a project file", () => {
  it("音视频归为 media，@ 得到、发送到助手认得；文本与图片不变", () => {
    expect(classifyProjectFile("采访.mp3", "/p/采访.mp3")).toEqual({ name: "采访.mp3", path: "/p/采访.mp3", kind: "media" });
    expect(classifyProjectFile("讲座.mp4", "/p/讲座.mp4")?.kind).toBe("media");
    expect(classifyProjectFile("a.md", "/p/a.md")?.kind).toBe("text");
    expect(classifyProjectFile("a.png", "/p/a.png")?.kind).toBe("image");
    expect(classifyProjectFile("a.docx", "/p/a.docx")).toBeNull();
    expect(transcribeExtOf("A.MP3")).toBe("mp3");
  });
  it("导入对话框原样复制音视频进项目（不转换、不解码）", () => {
    expect(importMode("采访.mp3")).toBe("copy-binary");
    expect(importMode("讲座.mkv")).toBe("copy-binary");
    expect(importMode("a.png")).toBe("copy-binary");
    expect(importMode("a.md")).toBe("copy-text");
    expect(importMode("a.docx")).toBe("convert");
    expect(importMode("a.pcm")).toBeNull();
  });
});
