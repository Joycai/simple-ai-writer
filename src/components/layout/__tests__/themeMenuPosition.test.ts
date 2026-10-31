import { describe, expect, it } from "vitest";
import { themeMenuPosition } from "../themeMenuPosition";

const input = {
  viewport: { width: 500, height: 240 },
  anchor: { right: 456, bottom: 36 },
  root: { width: 264, height: 193 },
  child: { width: 264, height: 224 },
  rowOffset: 49,
};

describe("theme menu positioning", () => {
  it("keeps a taller stacked submenu inside a short viewport", () => {
    const position = themeMenuPosition(input);
    expect(position.stacked).toBe(true);
    expect(position.childTop).toBe(8);
    expect(position.childTop + input.child.height).toBeLessThanOrEqual(input.viewport.height - 8);
    expect(position.childTop).toBeLessThan(position.top);
  });

  it("flips a right-aligned submenu to the left", () => {
    const position = themeMenuPosition({ ...input, viewport: { width: 900, height: 600 }, anchor: { right: 856, bottom: 36 } });
    expect(position.stacked).toBe(false);
    expect(position.childLeft + input.child.width).toBe(position.left);
    expect(position.childTop).toBe(position.top + input.rowOffset);
  });

  it("uses the right side when space is available", () => {
    const position = themeMenuPosition({ ...input, viewport: { width: 900, height: 600 }, anchor: { right: 280, bottom: 36 } });
    expect(position.stacked).toBe(false);
    expect(position.childLeft).toBe(position.left + input.root.width);
  });

  it("clamps a scrolled parent item above the viewport", () => {
    const position = themeMenuPosition({ ...input, viewport: { width: 900, height: 600 }, rowOffset: -100 });
    expect(position.childTop).toBe(8);
  });

  it("keeps both panels within the viewport across short and narrow sizes", () => {
    for (const width of [280, 320, 500, 540, 900]) {
      for (const height of [160, 240, 420, 600]) {
        const root = { width: Math.min(264, width - 16), height: Math.min(193, height - 16) };
        const child = { width: root.width, height: Math.min(500, height - 16) };
        const position = themeMenuPosition({ ...input, viewport: { width, height }, root, child, anchor: { right: width - 24, bottom: 36 } });
        expect(position.left).toBeGreaterThanOrEqual(8);
        expect(position.left + root.width).toBeLessThanOrEqual(width - 8);
        expect(position.top + root.height).toBeLessThanOrEqual(height - 8);
        expect(position.childLeft).toBeGreaterThanOrEqual(8);
        expect(position.childLeft + child.width).toBeLessThanOrEqual(width - 8);
        expect(position.childTop + child.height).toBeLessThanOrEqual(height - 8);
      }
    }
  });
});
