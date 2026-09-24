// 绑定选择器的纯逻辑:过滤 / 排序 / 推荐 / 相对时间。

import { describe, expect, it } from "vitest";
import type { RemoteKb } from "../client";
import { filterKbs, recommendKb, relativeAge, sortKbs } from "../kbPicker";

const kb = (name: string, over: Partial<RemoteKb> = {}): RemoteKb => ({
  id: name,
  name,
  createdAtMs: 0,
  entryCount: 0,
  updatedAtMs: 0,
  lastDevice: null,
  ...over,
});

describe("filterKbs", () => {
  const list = [kb("Amethyst"), kb("港町物语アリーシャ"), kb("怪盗物语")];

  it("matches a substring of the name, ignoring case and surrounding blanks", () => {
    expect(filterKbs(list, "  meth ").map((k) => k.name)).toEqual(["Amethyst"]);
    expect(filterKbs(list, "AMETHYST")).toHaveLength(1);
    expect(filterKbs(list, "物语").map((k) => k.name)).toEqual(["港町物语アリーシャ", "怪盗物语"]);
  });

  it("keeps everything for a blank query and nothing for a miss", () => {
    expect(filterKbs(list, "   ")).toHaveLength(3);
    expect(filterKbs(list, "nope")).toEqual([]);
  });
});

describe("sortKbs", () => {
  const list = [
    kb("b", { updatedAtMs: 100, entryCount: 5 }),
    kb("a", { updatedAtMs: 300, entryCount: 5 }),
    kb("c", { updatedAtMs: 300, entryCount: 9 }),
  ];

  it("puts the newest first and breaks ties by name", () => {
    expect(sortKbs(list, "recent").map((k) => k.name)).toEqual(["a", "c", "b"]);
  });

  it("sorts by name or by entry count on request", () => {
    expect(sortKbs(list, "name").map((k) => k.name)).toEqual(["a", "b", "c"]);
    expect(sortKbs(list, "entries").map((k) => k.name)).toEqual(["c", "a", "b"]);
  });

  it("does not reorder its input", () => {
    sortKbs(list, "name");
    expect(list.map((k) => k.name)).toEqual(["b", "a", "c"]);
  });
});

describe("recommendKb", () => {
  it("prefers a base named like the project, newest among several", () => {
    const list = [
      kb("x", { id: "old", updatedAtMs: 1 }),
      kb("mine", { lastDevice: "mac", updatedAtMs: 9 }),
      kb(" Amethyst ", { id: "new", updatedAtMs: 5 }),
      kb("amethyst", { id: "older", updatedAtMs: 2 }),
    ];
    expect(recommendKb(list, "Amethyst", "mac")).toEqual({
      kb: list[2],
      reason: "same-name",
    });
  });

  it("falls back to the newest base this machine wrote last", () => {
    const list = [
      kb("a", { lastDevice: "mac", updatedAtMs: 1 }),
      kb("b", { lastDevice: "mac", updatedAtMs: 7 }),
      kb("c", { lastDevice: "pc", updatedAtMs: 9 }),
    ];
    expect(recommendKb(list, "project", "mac")).toEqual({ kb: list[1], reason: "this-device" });
  });

  it("offers nothing rather than a weak guess", () => {
    const list = [kb("a", { lastDevice: "pc", updatedAtMs: 9 })];
    expect(recommendKb(list, "project", "mac")).toBeNull();
    // An unnamed machine must not match bases with no recorded device.
    expect(recommendKb([kb("a")], "", "")).toBeNull();
  });
});

describe("relativeAge", () => {
  const now = new Date(2026, 8, 17, 9, 0).getTime();
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();

  it("counts calendar days, not 24-hour spans", () => {
    expect(relativeAge(at(2026, 8, 17, 1), now)).toEqual({ unit: "today" });
    expect(relativeAge(at(2026, 8, 16, 23), now)).toEqual({ unit: "yesterday" });
    expect(relativeAge(at(2026, 8, 14), now)).toEqual({ unit: "days", n: 3 });
  });

  it("rolls up into months and years", () => {
    expect(relativeAge(at(2026, 7, 1), now)).toEqual({ unit: "months", n: 1 });
    expect(relativeAge(at(2025, 8, 1), now)).toEqual({ unit: "years", n: 1 });
  });

  it("reads a future clock as today and a missing time as never", () => {
    expect(relativeAge(at(2026, 8, 20), now)).toEqual({ unit: "today" });
    expect(relativeAge(0, now)).toEqual({ unit: "never" });
  });
});
