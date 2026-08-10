import { describe, expect, it } from "vitest";
import { formatToolArgs, formatToolArgsDetail, formatToolResult } from "../agent/logFormat";

describe("formatToolArgs", () => {
  it("reduces a Windows path argument to its chapter name", () => {
    const raw = JSON.stringify({
      path: "C:\\Users\\reine\\SynologyDrive\\MyDocument\\character design\\MagicalGirlSapphire\\writing\\番外篇.md",
    });
    expect(formatToolArgs(raw)).toBe("番外篇");
  });

  it("reduces a POSIX path the same way", () => {
    expect(formatToolArgs('{"path":"/home/a/project/writing/chapter-01.md"}')).toBe("chapter-01");
  });

  it("shows nothing for a no-argument call", () => {
    expect(formatToolArgs("{}")).toBe("");
    expect(formatToolArgs("")).toBe("");
  });

  it("prefers the identifying key over incidental ones", () => {
    expect(formatToolArgs('{"reason":"checking canon","name":"梅莉"}')).toBe("梅莉");
  });

  it("appends one qualifying detail after the identity", () => {
    expect(formatToolArgs('{"name":"苍蓝宝石","facet":"变身形态"}')).toBe("苍蓝宝石 · 变身形态");
  });

  it("falls back to the first renderable value when nothing is recognised", () => {
    expect(formatToolArgs('{"weird":"value"}')).toBe("value");
  });

  it("clips an over-long value", () => {
    const out = formatToolArgs(JSON.stringify({ query: "x".repeat(120) }));
    expect(out).toHaveLength(44);
    expect(out.endsWith("…")).toBe(true);
  });

  it("degrades to a clipped string when the JSON does not parse", () => {
    const out = formatToolArgs('{"path": "C:\\\\Users\\\\reine\\\\Synology');
    expect(out.length).toBeLessThanOrEqual(44);
    expect(out).toContain("path");
  });

  it("counts array arguments rather than dumping them", () => {
    expect(formatToolArgs('{"paths":["a","b","c"]}')).toBe("3");
  });
});

describe("formatToolArgsDetail", () => {
  it("indents the arguments the expanded row shows", () => {
    expect(formatToolArgsDetail('{"name":"苍蓝宝石","facet":"变身形态"}')).toBe(
      '{\n  "name": "苍蓝宝石",\n  "facet": "变身形态"\n}',
    );
  });

  it("shows a summary truncated mid-JSON verbatim rather than nothing", () => {
    const raw = '{"path": "C:\\\\Users\\\\reine\\\\Synology';
    expect(formatToolArgsDetail(raw)).toBe(raw);
  });

  it("returns empty for a no-argument call", () => {
    expect(formatToolArgsDetail("{}")).toBe("");
    expect(formatToolArgsDetail("")).toBe("");
  });
});

describe("formatToolResult", () => {
  it("collapses a multi-line result onto one clipped line", () => {
    const raw = "# 番外篇：战败魔法少女\n\n耳边传来水声，随后是冰冷的触感。渚悠悠醒来。";
    const out = formatToolResult(raw);
    expect(out).not.toContain("\n");
    expect(out.startsWith("番外篇")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(38);
  });

  it("keeps a short result whole", () => {
    expect(formatToolResult("No story memory exists.")).toBe("No story memory exists.");
  });

  it("returns empty for a missing result", () => {
    expect(formatToolResult(undefined)).toBe("");
  });
});
