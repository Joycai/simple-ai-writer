/**
 * Which images an export has to embed, and where it looks for them.
 *
 * An exported file has no relation to the project folder — the HTML lands
 * wherever it was saved, the PDF prints from an iframe with no base URL — so a
 * relative `assets/…` link resolves against nothing and the picture is simply
 * missing. The document looks right on screen and reaches its reader with
 * holes in it, which is the kind of bug nobody reports until it is embarrassing.
 *
 * The DOM walk itself needs a browser; these are its two decisions.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));
vi.mock("./fileio", () => ({ writeFile: vi.fn(), readDir: vi.fn(), readFile: vi.fn() }));

const { needsInlining, assetPathFor } = await import("../fs/export");

describe("needsInlining", () => {
  it("embeds local relative links", () => {
    expect(needsInlining("assets/ch1/a.png")).toBe(true);
    expect(needsInlining("../shared/logo.png")).toBe(true);
  });

  it("leaves anything already self-contained or remote alone", () => {
    // Rewriting a remote link would turn an image that works anywhere into
    // bytes in the file; a data URL is embedded by definition.
    expect(needsInlining("https://example.com/a.png")).toBe(false);
    expect(needsInlining("http://example.com/a.png")).toBe(false);
    expect(needsInlining("data:image/png;base64,aGk=")).toBe(false);
    expect(needsInlining("blob:abc")).toBe(false);
    expect(needsInlining("ai-writer-asset://a.png")).toBe(false);
  });

  it("ignores an absent or empty src", () => {
    expect(needsInlining(null)).toBe(false);
    expect(needsInlining("")).toBe(false);
  });
});

describe("assetPathFor", () => {
  it("resolves against the document's own folder", () => {
    expect(assetPathFor("/proj/writing/vol1", "assets/ch1/a.png"))
      .toBe("/proj/writing/vol1/assets/ch1/a.png");
  });

  it("decodes the percent-encoding the markdown link carries", () => {
    // lib/image/assets.ts encodes each segment, so a Chinese filename arrives
    // here as %E7%AC%AC… and the filesystem wants the characters back.
    expect(assetPathFor("/proj/writing", "assets/%E7%AC%AC%E4%B8%89%E7%AB%A0/%E5%9B%BE%201.png"))
      .toBe("/proj/writing/assets/第三章/图 1.png");
  });

  it("keeps a malformed escape as-is instead of throwing", () => {
    expect(assetPathFor("/proj", "assets/100%.png")).toBe("/proj/assets/100%.png");
  });
});
