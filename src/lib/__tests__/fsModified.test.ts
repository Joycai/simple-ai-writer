/**
 * 「最后改于 8 月 3 日」 — how a file's modification time reads on a card, and
 * that a stat that cannot answer leaves the clause out rather than failing.
 */
import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import zh from "../../i18n/locales/zh-CN.json";
import en from "../../i18n/locales/en.json";

const h = vi.hoisted(() => ({
  stat: vi.fn(async (_path: string): Promise<unknown> => null),
}));

vi.mock("../fs/fileio", () => ({ statPath: h.stat }));

import { modifiedAt, modifiedLabel } from "../fs/modified";

/** A `t` over the real locale file, so a missing key fails here and not on a card. */
function tOf(dict: unknown): TFunction {
  return ((key: string, params: Record<string, unknown> = {}) => {
    const value = key
      .split(".")
      .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], dict);
    if (typeof value !== "string") throw new Error(`missing locale key ${key}`);
    return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name]));
  }) as unknown as TFunction;
}

const NOW = new Date(2026, 8, 10, 15, 0).getTime();

describe("modifiedLabel", () => {
  const zhT = tOf(zh);
  const enT = tOf(en);

  it("says the clock for today and yesterday, where the date is already known", () => {
    expect(modifiedLabel(zhT, new Date(2026, 8, 10, 14, 3).getTime(), { locale: "zh-CN", now: NOW })).toBe("今天 14:03");
    expect(modifiedLabel(zhT, new Date(2026, 8, 9, 9, 5).getTime(), { locale: "zh-CN", now: NOW })).toBe("昨天 09:05");
    expect(modifiedLabel(enT, new Date(2026, 8, 10, 14, 3).getTime(), { locale: "en", now: NOW })).toBe("today 14:03");
  });

  it("says the date for anything older, and the year only when it is not this one", () => {
    const aug3 = new Date(2026, 7, 3, 9, 5).getTime();
    expect(modifiedLabel(zhT, aug3, { locale: "zh-CN", now: NOW })).toBe("8 月 3 日");
    expect(modifiedLabel(enT, aug3, { locale: "en", now: NOW })).toBe("Aug 3");

    const lastYear = new Date(2025, 11, 30, 22, 0).getTime();
    expect(modifiedLabel(zhT, lastYear, { locale: "zh-CN", now: NOW })).toBe("2025 年 12 月 30 日");
    expect(modifiedLabel(enT, lastYear, { locale: "en", now: NOW })).toBe("Dec 30, 2025");
  });

  it("adds the clock to an older date when asked — the undo refusal's form", () => {
    const aug12 = new Date(2026, 7, 12, 14, 3).getTime();
    expect(modifiedLabel(zhT, aug12, { locale: "zh-CN", now: NOW, withTime: true })).toBe("8 月 12 日 14:03");
    expect(modifiedLabel(enT, aug12, { locale: "en", now: NOW, withTime: true })).toBe("Aug 12, 14:03");
  });
});

describe("modifiedAt", () => {
  it("reads the time off the stat", async () => {
    h.stat.mockResolvedValue({ isDir: false, size: 3, modifiedMs: 1_725_000_000_000 });
    expect(await modifiedAt("/proj/a.md")).toBe(1_725_000_000_000);
  });

  it("has no answer for a missing file, a filesystem without the time, or a failed stat", async () => {
    h.stat.mockResolvedValue(null);
    expect(await modifiedAt("/proj/gone.md")).toBeUndefined();
    h.stat.mockResolvedValue({ isDir: false, size: 3, modifiedMs: null });
    expect(await modifiedAt("/proj/a.md")).toBeUndefined();
    h.stat.mockImplementation(async () => {
      throw new Error("denied");
    });
    expect(await modifiedAt("/proj/a.md")).toBeUndefined();
  });
});
