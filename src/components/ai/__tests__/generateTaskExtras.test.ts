import { describe, expect, it } from "vitest";
import { generateTaskExtras } from "../generateTaskExtras";

describe("Generate task input", () => {
  it("passes pins and requirements for workspace tasks without a reference-window picker", () => {
    expect(generateTaskExtras({}, ["/kb/product", "/kb/service#terms.md"], "  cite evidence  ", 2000)).toEqual({
      manualLorePaths: ["/kb/product", "/kb/service#terms.md"], requirement: "cite evidence",
    });
  });
  it("passes pins to freeform/agent tasks without leaking a hidden requirement or window", () => {
    expect(generateTaskExtras({ freeform: true }, ["/kb/product"], "hidden", 2000)).toEqual({
      manualLorePaths: ["/kb/product"],
    });
  });
  it("keeps continuation's outline and knowledge independent from edit requirements", () => {
    expect(generateTaskExtras({ continuation: true }, [], "hidden", 2000)).toEqual({ manualLorePaths: undefined });
  });
  it("honors an explicit zero reference window and omits empty requirements", () => {
    expect(generateTaskExtras({ referenceWindow: true }, [], "  ", 0)).toEqual({
      manualLorePaths: undefined, requirement: undefined, contextChars: 0,
    });
  });
});
