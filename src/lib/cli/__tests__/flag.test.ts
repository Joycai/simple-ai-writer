import { describe, expect, it, vi } from "vitest";

const channel = vi.hoisted(() => ({ terminal: true }));
vi.mock("../../distribution", () => ({ terminalAvailable: () => channel.terminal, distributionAllows: () => true }));

const prefs = new Map<string, string>();
vi.mock("../../prefs", () => ({
  readPref: vi.fn((k: string) => prefs.get(k)),
  writePref: vi.fn((k: string, v: string) => void prefs.set(k, v)),
}));

import { isCliEnabled, setCliEnabled } from "../flag";

describe("cli flag", () => {
  it("缺席＝关", () => {
    prefs.clear();
    expect(isCliEnabled()).toBe(false);
  });
  it("写入后读回，键是 app:cliBeta", () => {
    prefs.clear();
    setCliEnabled(true);
    expect(isCliEnabled()).toBe(true);
    expect(prefs.get("app:cliBeta")).toBe("1");
    setCliEnabled(false);
    expect(isCliEnabled()).toBe(false);
  });
});

it("store ignores imported terminal preferences and preserves them without allowing toggles", () => {
  channel.terminal = false;
  try {
    prefs.set("app:cliBeta", "1");
    expect(isCliEnabled()).toBe(false);
    setCliEnabled(false);
    expect(prefs.get("app:cliBeta")).toBe("1");
    prefs.set("app:cliBeta", "0");
    setCliEnabled(true);
    expect(prefs.get("app:cliBeta")).toBe("0");
  } finally { channel.terminal = true; }
});
