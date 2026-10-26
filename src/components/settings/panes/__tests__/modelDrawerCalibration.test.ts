import { describe, expect, it } from "vitest";
import { modelMediaCalibration } from "../ModelDrawer";

describe("manual model media calibration", () => {
  it.each(["openai", "responses"] as const)("prefills Seed 2.1 Pro media on %s", (family) => {
    expect(modelMediaCalibration("volcengine-plan", "doubao-seed-2.1-pro", family))
      .toEqual({ type: "multimodal", pdfInput: true });
    expect(modelMediaCalibration("volcengine-plan", "doubao-seed-2.1-pro", "anthropic"))
      .toEqual({ type: undefined, pdfInput: undefined });
  });
  it.each(["openai", "responses"] as const)("uses Kimi Plan's measured %s route for manual additions", (family) => {
    expect(modelMediaCalibration("volcengine-plan", "kimi-k3.1-pro", family))
      .toEqual({ type: "multimodal", pdfInput: true });
  });

  it("retains platform-wide Doubao media defaults", () => {
    expect(modelMediaCalibration("volcengine-plan", "doubao-seed-2.0-lite", "responses"))
      .toEqual({ type: "multimodal", pdfInput: true });
  });

  it("does not promote the unmeasured Anthropic route or pay-as-you-go platform", () => {
    expect(modelMediaCalibration("volcengine-plan", "kimi-k3.1-pro", "anthropic"))
      .toEqual({ type: undefined, pdfInput: undefined });
    expect(modelMediaCalibration("volcengine", "kimi-k3.1-pro", "responses"))
      .toEqual({ type: undefined, pdfInput: undefined });
  });
});
