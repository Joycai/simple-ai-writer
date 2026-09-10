/**
 * The clock line (lib/context/clock) and the invariant that every system
 * layer a model can *write dated things under* carries it.
 *
 * The line exists because nothing on the wire told the model what day it was
 * — see the module comment for why it is a line and not a tool, and why the
 * chat stamps the turn where a single-shot run stamps its system prompt. The
 * source guard below is the half of that design that would otherwise rot: a
 * new surface that builds its own `role: "system"` message has to decide, in
 * one of the two lists, whether the model behind it needs a clock.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({
  default: {
    language: "zh-CN",
    t: (key: string, params?: Record<string, unknown>) =>
      key === "ai.instructions.currentTime"
        ? `当前时间：${params?.time}（时区 ${params?.zone}）`
        : key,
  },
}));

import { currentTimeLine, formatClock, withCurrentTime } from "../context/clock";

/** 2026-09-04 06:32 UTC — a Friday; 14:32 in Shanghai, 23:32 the day before in Los Angeles. */
const T = new Date(Date.UTC(2026, 8, 4, 6, 32, 45));

describe("formatClock", () => {
  it("is ISO-ordered, in the given zone, with a localised weekday and a 24-hour clock", () => {
    expect(formatClock(T, "zh-CN", "Asia/Shanghai")).toBe("2026-09-04 星期五 14:32");
    expect(formatClock(T, "en-US", "Asia/Shanghai")).toBe("2026-09-04 Friday 14:32");
    expect(formatClock(T, "en-US", "UTC")).toBe("2026-09-04 Friday 06:32");
  });

  it("crosses the date line with the zone, not with UTC", () => {
    expect(formatClock(T, "en-US", "America/Los_Angeles")).toBe("2026-09-03 Thursday 23:32");
  });

  it("spells midnight as 00, never 24", () => {
    const midnight = new Date(Date.UTC(2026, 8, 4, 16, 5));
    expect(formatClock(midnight, "zh-CN", "Asia/Shanghai")).toBe("2026-09-05 星期六 00:05");
  });
});

describe("currentTimeLine / withCurrentTime", () => {
  it("renders through the i18n key with the zone named", () => {
    expect(currentTimeLine({ now: T, timeZone: "Asia/Shanghai" }))
      .toBe("当前时间：2026-09-04 星期五 14:32（时区 Asia/Shanghai）");
  });

  it("appends to a system prompt on its own paragraph, so the static text stays a cache prefix", () => {
    const out = withCurrentTime("你是写作协作者。", { now: T, timeZone: "UTC" });
    expect(out).toBe("你是写作协作者。\n\n当前时间：2026-09-04 星期五 06:32（时区 UTC）");
  });
});

// ── Source guard ─────────────────────────────────────────────────────────────

/**
 * Surfaces whose model may write or reason about dates. Each must reach the
 * clock through the seam — `withCurrentTime` on a single-shot system prompt,
 * `currentTimeLine` on the chat's per-turn directive.
 */
const REQUIRED = [
  "src/stores/agentStore.ts", // chat — stamps the turn, not history[0]
  "src/stores/aiTaskStore.ts", // AiPanel tasks and, through runTask, batch runs
  "src/lib/agent/subagent.ts", // delegates: web search is the one that needs the date most
  "src/lib/agent/packs.ts", // pack sub-runs write the same documents chat does
  "src/lib/agent/handoff.ts", // the writer's text *is* the turn's answer
];

/**
 * Files that build a `role: "system"` message and deliberately carry no
 * clock, with the reason. Anything not here and not in REQUIRED fails.
 */
const EXEMPT = [
  "src/lib/context/rag.ts", // bundleToMessages: the prompt it receives is already stamped by the caller
  "src/lib/agent/run.ts", // runtime seam — takes the caller's system prompt verbatim
  "src/lib/agent/structured.ts", // one-shot JSON extraction; nothing to date
  "src/lib/agent/compactRun.ts", // summarizer — condenses text, must not invent "today"
  "src/lib/ai/types.ts", // applyPrefix, a transport helper
  "src/lib/consistency/review.ts", // compares text to the knowledge base; the date is not a fact it checks
  "src/lib/lore/generator.ts", // structured lore generation
  "src/lib/lore/splitter.ts", // facet split collector
  "src/lib/lore/vision.ts", // image description
  "src/lib/roleplay/context.ts", // a character lives in the story's time — the author's clock would leak into the prose
  "src/lib/translate/run.ts", // Sakura: a training-time template, not a prompt
  "src/stores/digestStore.ts", // display-only digest
  "src/stores/memoryStore.ts", // story-memory summarizer
];

/** Every source file's text — via `import.meta.glob`, see profileSystemPrompt.test.ts for why not node:fs. */
const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

const sources = () =>
  Object.entries(SOURCES)
    .filter(([path]) => !path.includes("/__tests__/"))
    .map(([path, text]) => [path.replace(/^\//, ""), text] as const);

describe("every system layer decides about the clock", () => {
  it("stamps each required surface through the seam", () => {
    const byPath = new Map(sources());
    for (const path of REQUIRED) {
      const text = byPath.get(path);
      expect(text, `${path} missing`).toBeDefined();
      expect(
        /\b(withCurrentTime|currentTimeLine)\(/.test(text ?? ""),
        `${path} builds a system layer for a model that writes dated things but never reaches lib/context/clock`,
      ).toBe(true);
    }
  });

  it("lists every other system-message builder as exempt, with a reason", () => {
    const builders = sources()
      .filter(([, text]) => text.includes('role: "system"'))
      .map(([path]) => path);

    // Prove the scan sees the tree before trusting its verdict.
    expect(builders).toEqual(expect.arrayContaining(["src/lib/agent/subagent.ts", "src/lib/context/rag.ts"]));

    const undecided = builders.filter((p) => !REQUIRED.includes(p) && !EXEMPT.includes(p));
    expect(
      undecided,
      "These files build a role: \"system\" message without deciding whether the " +
        "model behind it needs the current time. Stamp it with withCurrentTime / " +
        "currentTimeLine (lib/context/clock) and add the file to REQUIRED, or add " +
        "it to EXEMPT with the reason.",
    ).toEqual([]);

    const stale = EXEMPT.filter((p) => !builders.includes(p));
    expect(stale, "EXEMPT entries that no longer build a system message").toEqual([]);
  });
});
