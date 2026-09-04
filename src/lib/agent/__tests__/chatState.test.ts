/**
 * 三家记号 (设计稿 23 屏 1d): which mark a conversation wears, and which one the
 * mode tab wears for all of them.
 */
import { describe, expect, it } from "vitest";
import { chatState, isResultState, mostUrgent } from "../chatState";
import { elapsedClock, liveLabel, roundsOf, rowLabel } from "../chatLabel";

const st = (o: Partial<Parameters<typeof chatState>[0]>) =>
  chatState({ running: false, queued: false, waiting: false, unread: false, error: false, ...o });

describe("chatState", () => {
  it("a waiting card outranks its own run — the run stopped for it", () => {
    expect(st({ running: true, waiting: true })).toBe("waiting");
    expect(st({ running: true })).toBe("running");
    expect(st({ queued: true })).toBe("queued");
  });
  it("a finished run's error outranks its new reply — the reply is the error", () => {
    expect(st({ unread: true, error: true })).toBe("error");
    expect(st({ unread: true })).toBe("unread");
    // An error the author has already seen is not a mark.
    expect(st({ error: true })).toBeNull();
    expect(st({})).toBeNull();
  });
  it("the mode tab: 竖条 over 方块 over 圆", () => {
    expect(mostUrgent(["running", "waiting", "unread"])).toBe("waiting");
    expect(mostUrgent(["running", "unread"])).toBe("unread");
    expect(mostUrgent(["running", "error", "unread"])).toBe("error");
    expect(mostUrgent(["queued", "running"])).toBe("running");
    expect(mostUrgent([null, null])).toBeNull();
    expect(isResultState("unread")).toBe(true);
    expect(isResultState("running")).toBe(false);
  });
});

describe("chatLabel", () => {
  it("两种字: the author's title, else the first question, else nothing", () => {
    expect(rowLabel({ title: "时间线", preview: "第一句" })).toEqual({ text: "时间线", kind: "title" });
    expect(rowLabel({ title: "", preview: "第一句" })).toEqual({ text: "第一句", kind: "preview" });
    expect(rowLabel({ title: "", preview: "" })).toEqual({ text: "", kind: "none" });
    expect(liveLabel({ title: "", turns: [{ role: "user", text: "帮我  查一下\n漕运纪" }] }))
      .toEqual({ text: "帮我 查一下 漕运纪", kind: "preview" });
    expect(liveLabel({ title: "", turns: [] })).toEqual({ text: "", kind: "none" });
  });
  it("counts rounds and formats the wait clock", () => {
    expect(roundsOf([{ kind: "round-start" }, { kind: "tool-step" }, { kind: "round-start" }])).toBe(2);
    expect(elapsedClock(1000, 43_000)).toBe("00:42");
    expect(elapsedClock(0, 61_000)).toBe("01:01");
    expect(elapsedClock(5000, 1000)).toBe("00:00");
  });
});
