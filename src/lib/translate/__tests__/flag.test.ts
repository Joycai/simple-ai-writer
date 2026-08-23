import { describe, expect, it, vi } from "vitest";

const prefs = new Map<string, string>();
vi.mock("../../prefs", () => ({
  readPref: vi.fn((k: string) => prefs.get(k)),
  writePref: vi.fn((k: string, v: string) => void prefs.set(k, v)),
}));

import { DEFAULT_LINES_PER_CHUNK } from "../chunk";
import { clampChunkLines, setTranslateLinesPerChunk, translateLinesPerChunk } from "../flag";

describe("clampChunkLines", () => {
  it("1–100 之间的整数；解析不出来回默认", () => {
    expect(clampChunkLines(10)).toBe(10);
    expect(clampChunkLines("25")).toBe(25);
    expect(clampChunkLines(0)).toBe(1);
    expect(clampChunkLines(999)).toBe(100);
    expect(clampChunkLines(7.9)).toBe(7);
    expect(clampChunkLines("abc")).toBe(DEFAULT_LINES_PER_CHUNK);
    expect(clampChunkLines(undefined)).toBe(DEFAULT_LINES_PER_CHUNK);
  });
});

describe("translateLinesPerChunk", () => {
  it("未设置时是实测默认，设置后按夹取值走", () => {
    prefs.clear();
    expect(translateLinesPerChunk()).toBe(DEFAULT_LINES_PER_CHUNK);
    setTranslateLinesPerChunk(5);
    expect(translateLinesPerChunk()).toBe(5);
    setTranslateLinesPerChunk(0);
    expect(translateLinesPerChunk()).toBe(1);
  });
});
