import { describe, it, expect } from "vitest";
import {
  formatPreviewZoom,
  PREVIEW_ZOOM_DEFAULT,
  PREVIEW_ZOOM_MAX,
  PREVIEW_ZOOM_MIN,
  PREVIEW_ZOOM_STEPS,
  snapPreviewZoom,
  stepPreviewZoom,
} from "../editor/previewZoom";

describe("preview zoom ladder", () => {
  it("holds 100% and stays sorted", () => {
    expect(PREVIEW_ZOOM_STEPS).toContain(PREVIEW_ZOOM_DEFAULT);
    expect([...PREVIEW_ZOOM_STEPS]).toEqual([...PREVIEW_ZOOM_STEPS].sort((a, b) => a - b));
  });

  it("steps exactly one rung at a time", () => {
    expect(stepPreviewZoom(1, 1)).toBe(1.1);
    expect(stepPreviewZoom(1.1, 1)).toBe(1.25);
    expect(stepPreviewZoom(1, -1)).toBe(0.9);
  });

  it("stops at both ends instead of running off the ladder", () => {
    expect(stepPreviewZoom(PREVIEW_ZOOM_MAX, 1)).toBe(PREVIEW_ZOOM_MAX);
    expect(stepPreviewZoom(PREVIEW_ZOOM_MIN, -1)).toBe(PREVIEW_ZOOM_MIN);
  });

  it("steps one rung from a value that fell between rungs", () => {
    // A stored preference from an older ladder, or a hand-edited prefs row.
    expect(stepPreviewZoom(1.13, 1)).toBe(1.25);
    expect(stepPreviewZoom(1.13, -1)).toBe(1);
  });

  it("falls back to 100% for a value that isn't a number", () => {
    expect(snapPreviewZoom(NaN)).toBe(PREVIEW_ZOOM_DEFAULT);
  });

  it("shows whole percents", () => {
    expect(formatPreviewZoom(1)).toBe("100%");
    expect(formatPreviewZoom(1.25)).toBe("125%");
    expect(formatPreviewZoom(0.5)).toBe("50%");
  });
});
