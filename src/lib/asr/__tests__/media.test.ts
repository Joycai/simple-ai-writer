import { describe, expect, it } from "vitest";
import { looksLikeFiletransModel, transcribeExtOf } from "../formats";
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
