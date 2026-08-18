/**
 * The .html file kind: which paths the editor treats as HTML documents, and
 * the inliner's no-work fast paths. The DOM walk itself needs a browser
 * (same stance as exportImages.test.ts) — these are the pure decisions.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

const { isHtmlPath, isImagePath } = await import("../fs/images");
const { inlineHtmlImages } = await import("../fs/htmlDoc");

describe("isHtmlPath", () => {
  it("accepts .html and .htm, case-insensitively", () => {
    expect(isHtmlPath("/proj/图示/架构.html")).toBe(true);
    expect(isHtmlPath("/proj/promo.HTM")).toBe(true);
    expect(isHtmlPath("C:\\proj\\page.Html")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isHtmlPath("/proj/第1章.md")).toBe(false);
    expect(isHtmlPath("/proj/notes.txt")).toBe(false);
    expect(isHtmlPath("/proj/a.png")).toBe(false);
    // The suffix must be the extension, not part of the name.
    expect(isHtmlPath("/proj/html")).toBe(false);
    expect(isHtmlPath("/proj/page.html.bak")).toBe(false);
  });

  it("never overlaps the image kind — EditorArea branches on both", () => {
    for (const p of ["/p/a.html", "/p/a.htm"]) {
      expect(isImagePath(p)).toBe(false);
    }
  });
});

describe("inlineHtmlImages", () => {
  it("returns the source untouched when there is no base directory", async () => {
    const html = "<!DOCTYPE html><html><body><img src='assets/a.png'></body></html>";
    const reader = vi.fn();
    expect(await inlineHtmlImages(html, null, reader)).toBe(html);
    expect(reader).not.toHaveBeenCalled();
  });
});
