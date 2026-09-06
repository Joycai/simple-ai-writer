import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTranscript, taskFailureOf, taskStatusOf, transcriptionUrlOf } from "../result";

// 两份真实结果（2026-09-06 实测，`file_url` 已抹去）——同一段 48 秒 TTS 音频，
// 两代模型各一份。docs/feature/asr/00-research.md §2。
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf-8");

describe("parseTranscript", () => {
  it("qwen3-asr-flash-filetrans：audio_info + 从 0 起的 sentence_id + language/emotion", () => {
    const t = parseTranscript(fixture("qwen3-asr-flash-filetrans"));
    expect(t.format).toBe("pcm_s16le");
    expect(t.sampleRate).toBe(22050);
    expect(t.speakers).toBe(false);
    expect(t.sentences.length).toBe(11);
    expect(t.sentences[0]).toMatchObject({ beginMs: 160, endMs: 1600, text: "第一章 雨夜。", language: "zh", emotion: "neutral" });
    // 没报原始时长：取最后一句的 end_time。
    expect(t.durationMs).toBe(t.sentences[t.sentences.length - 1].endMs);
  });

  it("qwen-audio-3.0-asr-flash-filetrans：properties + 从 1 起的 sentence_id + speaker_id", () => {
    const t = parseTranscript(fixture("qwen-audio-3.0-asr-flash-filetrans"));
    expect(t.format).toBe("pcm_s16le");
    expect(t.sampleRate).toBe(22050);
    expect(t.speakers).toBe(true);
    expect(t.sentences.length).toBe(10);
    expect(t.sentences[0]).toMatchObject({ beginMs: 200, endMs: 7480, speaker: 0 });
    expect(t.sentences[0].language).toBeUndefined();
    // 报了 original_duration_in_milliseconds 就用它，不用最后一句。
    expect(t.durationMs).toBe(55_245);
    expect(t.durationMs).not.toBe(t.sentences[t.sentences.length - 1].endMs);
  });

  it("两代解析出同一形状——句子按时间排序、文本非空", () => {
    for (const name of ["qwen3-asr-flash-filetrans", "qwen-audio-3.0-asr-flash-filetrans"]) {
      const t = parseTranscript(fixture(name));
      for (let i = 1; i < t.sentences.length; i++) {
        expect(t.sentences[i].beginMs).toBeGreaterThanOrEqual(t.sentences[i - 1].beginMs);
      }
      expect(t.sentences.every((s) => s.text.length > 0)).toBe(true);
    }
  });

  it("空句跳过、乱序句子排好、end < begin 夹到 begin", () => {
    const t = parseTranscript({
      transcripts: [{ channel_id: 0, sentences: [
        { begin_time: 5000, end_time: 6000, text: "二" },
        { begin_time: 1000, end_time: 500, text: "一" },
        { begin_time: 3000, end_time: 4000, text: "   " },
      ] }],
    });
    expect(t.sentences.map((s) => s.text)).toEqual(["一", "二"]);
    expect(t.sentences[0].endMs).toBe(1000);
  });

  it("不是 JSON / 没有 transcripts[] 抛错，而不是回一份空稿", () => {
    expect(() => parseTranscript("<html>")).toThrow(/not JSON/);
    expect(() => parseTranscript({ file_url: "x" })).toThrow(/transcripts/);
  });
});

describe("transcriptionUrlOf / taskStatusOf", () => {
  it("qwen3 一代：output.result.transcription_url", () => {
    expect(transcriptionUrlOf({ task_status: "SUCCEEDED", result: { transcription_url: "https://a" } })).toBe("https://a");
  });
  it("qwen-audio-3.0：output.output.transcription_url，或 results[0]", () => {
    expect(transcriptionUrlOf({ task_status: "SUCCEEDED", output: { transcription_url: "https://b" } })).toBe("https://b");
    expect(transcriptionUrlOf({ task_status: "SUCCEEDED", output: { results: [{ transcription_url: "https://c", subtask_status: "SUCCEEDED" }] } })).toBe("https://c");
  });
  it("都没有 → null；未知状态 → UNKNOWN", () => {
    expect(transcriptionUrlOf({ task_status: "SUCCEEDED" })).toBeNull();
    expect(transcriptionUrlOf(undefined)).toBeNull();
    expect(taskStatusOf({ task_status: "CANCELED" })).toBe("UNKNOWN");
    expect(taskStatusOf({ task_status: "RUNNING" })).toBe("RUNNING");
  });
});

describe("taskFailureOf", () => {
  it("code + message；没 message 只给 code", () => {
    expect(taskFailureOf({ code: "InvalidParameter", message: "bad url" })).toBe("InvalidParameter: bad url");
    expect(taskFailureOf({ code: "X" })).toBe("X");
  });
  it("FILE_DOWNLOAD_FAILED / SERVER_ERROR 附上 oss:// 未解析的线索（实测两代漏头就是这两种）", () => {
    expect(taskFailureOf({ code: "FILE_DOWNLOAD_FAILED", message: "FILE_DOWNLOAD_FAILED" })).toMatch(/resolve header/);
    expect(taskFailureOf({ code: "SERVER_ERROR" })).toMatch(/resolve header/);
  });
});
