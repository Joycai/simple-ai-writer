import { describe, expect, it, vi } from "vitest";

const prefs = new Map<string, string>();
vi.mock("../../prefs", () => ({
  readPref: vi.fn((k: string) => prefs.get(k)),
  writePref: vi.fn((k: string, v: string) => void prefs.set(k, v)),
}));

import {
  isAsrDiarizationDefault,
  isAsrEnabled,
  isAsrTimestampsEnabled,
  setAsrDiarizationDefault,
  setAsrEnabled,
  setAsrTimestampsEnabled,
} from "../flag";

describe("asr flags", () => {
  it("Beta 缺席＝关；时间戳缺席＝开；分离缺席＝关", () => {
    prefs.clear();
    expect(isAsrEnabled()).toBe(false);
    expect(isAsrTimestampsEnabled()).toBe(true);
    expect(isAsrDiarizationDefault()).toBe(false);
  });
  it("写入后读回", () => {
    prefs.clear();
    setAsrEnabled(true);
    setAsrTimestampsEnabled(false);
    setAsrDiarizationDefault(true);
    expect(isAsrEnabled()).toBe(true);
    expect(isAsrTimestampsEnabled()).toBe(false);
    expect(isAsrDiarizationDefault()).toBe(true);
    expect(prefs.get("app:asrBeta")).toBe("1");
  });
});
