import { describe, expect, it } from "vitest";
import { formatClock, formatDuration, transcriptToMarkdown } from "../render";
import type { Transcript } from "../result";

const base: Transcript = {
  format: "wav",
  durationMs: 48_000,
  speakers: true,
  sentences: [
    { beginMs: 160, endMs: 1600, text: "第一章 雨夜。", speaker: 0 },
    { beginMs: 2480, endMs: 7280, text: "林小满推开旧书店的门。", speaker: 1 },
    { beginMs: 8220, endMs: 12860, text: "", speaker: 1 },
  ],
};

describe("formatClock", () => {
  it("一小时以内 mm:ss，够一小时 h:mm:ss；小时位由整份稿的时长决定", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(2480)).toBe("00:02");
    expect(formatClock(61_000)).toBe("01:01");
    expect(formatClock(3_599_999)).toBe("59:59");
    expect(formatClock(3_600_000)).toBe("1:00:00");
    // 第 5 秒的一句，在一个两小时的稿里也带小时位，列才对得齐。
    expect(formatClock(5_000, 7_200_000)).toBe("0:00:05");
    expect(formatDuration(48_390)).toBe("00:48");
  });
});

describe("transcriptToMarkdown", () => {
  it("frontmatter 四个键 + 每句一段 + 时间戳 + 说话人（从 1 数）", () => {
    const md = transcriptToMarkdown(base, {
      source: "采访: 第三次.wav",
      model: "qwen-audio-3.0-asr-flash-filetrans",
      timestamps: true,
      speakers: true,
      transcribedAt: "2026-09-06T12:00:00.000Z",
    });
    expect(md).toBe([
      "---",
      'source: "采访: 第三次.wav"',
      "transcribed: 2026-09-06T12:00:00.000Z",
      'model: "qwen-audio-3.0-asr-flash-filetrans"',
      "duration: 00:48",
      "---",
      "",
      "[00:00] 说话人 1：第一章 雨夜。",
      "",
      "[00:02] 说话人 2：林小满推开旧书店的门。",
      "",
    ].join("\n"));
  });

  it("关时间戳、关说话人 → 只剩正文；稿里本来没有 speaker 时开了也不写", () => {
    const md = transcriptToMarkdown(base, { source: "a.mp3", model: "m", timestamps: false, speakers: false, transcribedAt: "t" });
    expect(md.split("\n---\n")[1]).toBe("\n第一章 雨夜。\n\n林小满推开旧书店的门。\n");
    const plain = transcriptToMarkdown({ ...base, speakers: false, sentences: base.sentences.map(({ speaker: _s, ...rest }) => rest) }, {
      source: "a.mp3", model: "m", timestamps: false, speakers: true, transcribedAt: "t",
    });
    expect(plain).not.toMatch(/说话人/);
  });

  it("说话人的措辞可替换（i18n）", () => {
    const md = transcriptToMarkdown(base, { source: "a", model: "m", timestamps: false, speakers: true, transcribedAt: "t", speakerWord: "Speaker" });
    expect(md).toMatch(/^Speaker 1：第一章/m);
  });
});
