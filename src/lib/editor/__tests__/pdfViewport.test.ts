import { describe, expect, it } from "vitest";
import { pdfPageNumber, pdfPixelRatio } from "../pdfViewport";

describe("PDF reader bounds", () => {
  it("bounds canvas memory and dimensions for Retina, poster and narrow pages", () => {
    for (const [width, height] of [[612, 792], [30_000, 40_000], [100_000, 100]]) {
      const ratio = pdfPixelRatio(width, height, 3);
      expect(width * height * ratio ** 2).toBeLessThanOrEqual(16_000_001);
      expect(Math.max(width, height) * ratio).toBeLessThanOrEqual(8192);
      expect(ratio).toBeLessThanOrEqual(2);
    }
    expect(pdfPixelRatio(612, 792, 1)).toBe(1);
  });
  it("keeps manual navigation inside the document and rejects invalid input", () => {
    expect(pdfPageNumber(-3, 12, 4)).toBe(1);
    expect(pdfPageNumber(100, 12, 4)).toBe(12);
    expect(pdfPageNumber(2.8, 12, 4)).toBe(2);
    expect(pdfPageNumber(NaN, 12, 4)).toBe(4);
    expect(pdfPageNumber(Infinity, 12, 4)).toBe(4);
  });
});
