import { describe, expect, it } from "vitest";
import { computeContextBreakdown, type ContextBreakdown } from "../../../lib/agent/contextBreakdown";
import { contextPopoverPosition, contextRingArcs } from "../contextRingGeometry";

const base = computeContextBreakdown(null, null, 0, 1000, 2000);
function context(usedTokens: number, contextSize = 2000): ContextBreakdown {
  return { ...base, usedTokens, contextSize, segments: [
    { key: "system", tokens: usedTokens / 4 }, { key: "conversation", tokens: usedTokens * 3 / 4 },
    { key: "free", tokens: Math.max(0, 1000 - usedTokens) },
  ] };
}
describe("context ring scale", () => {
  it.each([0, 30, 890, 1000, 1500])("preserves composition for %i tokens and caps only the drawing", used => {
    const arcs = contextRingArcs(context(used));
    expect(arcs.reduce((sum, arc) => sum + arc.length, 0)).toBeCloseTo(Math.min(used / 10, 100));
    if (used) {
      expect(arcs[1].offset).toBeCloseTo(arcs[0].length);
      expect(arcs[1].length / arcs[0].length).toBeCloseTo(3);
    }
  });
  it("does not fabricate a percentage for unknown windows", () => {
    expect(contextRingArcs(context(500, 0))).toEqual([]);
  });
  it("keeps tiny segments proportional rather than imposing minimum arc lengths", () => {
    expect(contextRingArcs(context(0.1))[0].length).toBeCloseTo(0.0025);
  });
});
describe("context popover placement", () => {
  it("opens above the composer and stays within a narrow viewport", () => {
    const result = contextPopoverPosition({ left: 270, top: 600, bottom: 632 }, 320, 700);
    expect(result).toMatchObject({ left: 8, width: 304, bottom: 108, maxHeight: 584 });
  });
  it("uses the space below when the composer is near the top", () => {
    expect(contextPopoverPosition({ left: 2, top: 40, bottom: 72 }, 900, 600))
      .toMatchObject({ left: 8, top: 80, maxHeight: 512 });
  });
});
