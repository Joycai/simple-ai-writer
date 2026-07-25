import { describe, it, expect } from "vitest";
import {
  CONTEXT_SIZE_STOPS,
  contextStopIndex,
  exactStopIndex,
  formatContextSize,
} from "../ai/contextSize";

describe("formatContextSize", () => {
  it("uses the binary stops the models actually ship", () => {
    expect(formatContextSize(131_072)).toBe("128k");
    expect(formatContextSize(1_048_576)).toBe("1M");
    expect(formatContextSize(512)).toBe("512");
  });
});

describe("contextStopIndex", () => {
  it("reports 0 for unset / unparseable values", () => {
    expect(contextStopIndex(undefined)).toBe(0);
    expect(contextStopIndex("")).toBe(0);
    expect(contextStopIndex(0)).toBe(0);
    expect(contextStopIndex("abc")).toBe(0);
  });

  it("maps a stop to its own slider position", () => {
    CONTEXT_SIZE_STOPS.forEach((n, i) => expect(contextStopIndex(n)).toBe(i + 1));
  });

  it("snaps an in-between value so the thumb has somewhere to sit", () => {
    expect(contextStopIndex(200_000)).toBe(contextStopIndex(262_144));
  });
});

describe("exactStopIndex", () => {
  it("agrees with contextStopIndex on exact stops and on unset", () => {
    expect(exactStopIndex(undefined)).toBe(0);
    expect(exactStopIndex("")).toBe(0);
    CONTEXT_SIZE_STOPS.forEach((n, i) => expect(exactStopIndex(n)).toBe(i + 1));
  });

  it("refuses to claim an in-between value belongs to a stop", () => {
    // Claude's 200,000 must not light up the "256k" chip while the number field
    // beside it plainly reads 200,000.
    expect(exactStopIndex(200_000)).toBe(-1);
    expect(exactStopIndex("65536")).toBe(-1);
  });
});
