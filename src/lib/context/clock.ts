/**
 * The current date and time, as one line the model can read.
 *
 * Nothing on the wire carried a clock before this: the system prompt is a
 * static identity, the briefing is a static rule sheet, and no tool answers
 * "what time is it". A model with no clock guesses from its training cutoff,
 * so 「今天几号」 comes back a year stale and 「下周」 in a weekly report lands on
 * the wrong week. A line is cheaper than a tool — a tool costs its schema on
 * every request whether or not it is called, and the model still has to
 * think to call it; the line is ~25 tokens and needs no round.
 *
 * **Where it goes is decided by caching, not by tidiness.** Prompt caches are
 * prefix caches (OpenAI's automatic one, Anthropic's block breakpoints): a
 * request hits for the longest prefix identical to an earlier request. For a
 * *single-shot* run — an AiPanel task, a subagent, a pack sub-run, the writer
 * — the system layer is built once per run, so the line lives at the END of
 * it (`withCurrentTime`): the static text before it still hits, the rounds of
 * one tool loop share the same stamp, and nothing later depends on it.
 *
 * A *multi-turn* chat is the opposite case. Its history persists across
 * sends, and turn N's whole history is turn N+1's cache prefix. A clock in
 * the system message would change on every send and invalidate everything
 * after it — every earlier turn, every tool result, every picture — for the
 * sake of 25 tokens. So the chat stamps the **current user turn** instead
 * (`currentTimeLine` through `withDirective`, the same seam 计划模式 uses):
 * appended to the newest message, it sits *after* the cached prefix, and the
 * history keeps every turn's own send time, which is what the model should
 * see anyway when the author comes back to a conversation the next morning.
 *
 * Deliberately not stamped: the roleplay agents — a character lives in the
 * story's time, and the author's wall clock in its context is exactly the
 * kind of fact that leaks into the prose (the narrator's tools already read
 * the transcript's real timestamps when they want them); the consistency
 * reviewer, the summarizers (compaction, digest, memory) and the structured
 * one-shots, which compare or condense text and have nothing to date; and
 * Sakura, whose system prompt is a training-time template. The source guard
 * in `__tests__/currentTime.test.ts` keeps that list explicit.
 *
 * Formatting is `Intl` in the author's own time zone — a wall clock, never
 * UTC: the author writes 「今晚八点」 in their zone, and a UTC line would have
 * the model correct them.
 */

import i18n from "../../i18n";

export interface ClockOptions {
  /** Injectable for tests; defaults to the wall clock. */
  now?: Date;
  /** BCP 47 tag for the weekday's spelling; defaults to the UI language. */
  locale?: string;
  /** IANA zone; defaults to the environment's. */
  timeZone?: string;
}

function resolve(opts: ClockOptions = {}) {
  return {
    now: opts.now ?? new Date(),
    locale: opts.locale ?? (i18n.language === "zh-CN" ? "zh-CN" : "en-US"),
    timeZone: opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/**
 * `2026-09-04 星期五 14:32` — ISO-ordered date, localised weekday, 24-hour
 * clock. Digits are forced to Latin (`-u-nu-latn`) so the line is the same
 * shape in every locale, and the weekday comes from the locale because that
 * is the part the author reads back.
 */
export function formatClock(now: Date, locale: string, timeZone: string): string {
  const numeric = new Intl.DateTimeFormat("en-US-u-nu-latn", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    numeric.find((p) => p.type === type)?.value ?? "";
  const weekday = new Intl.DateTimeFormat(locale, { timeZone, weekday: "long" }).format(now);
  return `${get("year")}-${get("month")}-${get("day")} ${weekday} ${get("hour")}:${get("minute")}`;
}

/** The one line: `当前时间：2026-09-04 星期五 14:32（时区 Asia/Shanghai）`. */
export function currentTimeLine(opts?: ClockOptions): string {
  const { now, locale, timeZone } = resolve(opts);
  return i18n.t("ai.instructions.currentTime", {
    time: formatClock(now, locale, timeZone),
    zone: timeZone,
  });
}

/**
 * A system prompt with the clock appended — for single-shot runs only (see
 * the module comment for why a multi-turn chat must not use this).
 */
export function withCurrentTime(systemPrompt: string, opts?: ClockOptions): string {
  return `${systemPrompt}\n\n${currentTimeLine(opts)}`;
}
