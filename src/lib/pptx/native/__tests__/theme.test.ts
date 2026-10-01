import { expect, it } from "vitest";
import { DECK_THEMES, type DeckTheme } from "../theme";
it("keeps built-in themes immutable with explicit font requirements and point units", () => {
  for (const theme of Object.values(DECK_THEMES) as DeckTheme[]) {
    expect(theme.canvas.widthPt / theme.canvas.heightPt).toBe(16 / 9);
    expect(theme.type.minimumPt).toBeGreaterThanOrEqual(18);
    expect(theme.type.bodyPt).toBeGreaterThanOrEqual(theme.type.minimumPt);
    expect(theme.fonts.latin.length).toBeGreaterThan(0);
    expect(theme.fonts.cjk.length).toBeGreaterThan(0);
    expect(theme.fonts.onMissing).toBe("error");
    for (const color of Object.values(theme.colors)) expect(color).toMatch(/^[0-9A-F]{6}$/);
    expect(Object.isFrozen(theme)).toBe(true);
    expect(Object.isFrozen(theme.fonts.cjk)).toBe(true);
    expect(Object.isFrozen(theme.colors)).toBe(true);
  }
});
