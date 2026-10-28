import { describe, expect, it } from "vitest";
import { canSplitEditor, effectiveViewMode, type ViewMode } from "../layout";

describe("editor width budget", () => {
  it("requires room for both 360px panes and their dividing border", () => {
    expect(canSplitEditor(720)).toBe(false);
    expect(canSplitEditor(721)).toBe(true);
  });

  it("temporarily falls back to editing and restores the requested split", () => {
    const state = { viewMode: "split" as ViewMode, canSplit: true };
    expect(effectiveViewMode(state)).toBe("split");
    state.canSplit = canSplitEditor(552); // 900px window with default sidebar.
    expect(effectiveViewMode(state)).toBe("editor");
    expect(state.viewMode).toBe("split");
    state.canSplit = canSplitEditor(1092);
    expect(effectiveViewMode(state)).toBe("split");
  });

  it.each(["editor", "preview"] as const)("honors an explicit %s choice across resize", (viewMode) => {
    expect(effectiveViewMode({ viewMode, canSplit: false })).toBe(viewMode);
    expect(effectiveViewMode({ viewMode, canSplit: true })).toBe(viewMode);
  });
});
