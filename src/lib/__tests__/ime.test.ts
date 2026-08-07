import { describe, it, expect } from "vitest";
import { imeOwnsKey, type CompositionState } from "../ime";

const idle: CompositionState = { composing: false, endedAt: -Infinity };

describe("imeOwnsKey", () => {
  it("lets a plain Enter through", () => {
    expect(imeOwnsKey({ isComposing: false, keyCode: 13 }, idle, 1000)).toBe(false);
  });

  it("blocks Enter while the candidate window is open", () => {
    expect(imeOwnsKey({ isComposing: true, keyCode: 229 }, idle, 1000)).toBe(true);
  });

  it("blocks Enter when only our own composition flag is set", () => {
    const state = { composing: true, endedAt: -Infinity };
    expect(imeOwnsKey({ isComposing: false, keyCode: 13 }, state, 1000)).toBe(true);
  });

  it("blocks the reordered Windows case: compositionend fires before keydown", () => {
    // WebView2 + Microsoft Pinyin: by keydown time both flags are already clear.
    const state = { composing: false, endedAt: 1000 };
    expect(imeOwnsKey({ isComposing: false, keyCode: 13 }, state, 1001)).toBe(true);
  });

  it("lets a deliberate second Enter through after the word is committed", () => {
    const state = { composing: false, endedAt: 1000 };
    expect(imeOwnsKey({ isComposing: false, keyCode: 13 }, state, 1400)).toBe(false);
  });

  it("blocks the legacy 229 keycode even with no composition events", () => {
    expect(imeOwnsKey({ keyCode: 229 }, idle, 1000)).toBe(true);
  });
});
