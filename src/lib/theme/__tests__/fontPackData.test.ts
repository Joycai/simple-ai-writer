import { describe, expect, it } from "vitest";
import { FONT_PACK_DATA } from "../fontPackData";
import { FONT_PACK_IDS, FONT_PACK_SOURCES, packBytes } from "../fontPacks";

/** 锁定表是生成的（scripts/gen-font-packs.ts）；这里只守它的形状，让手改或半截生成当场露出来。 */
describe("FONT_PACK_DATA", () => {
  it("pins exactly the packs the app offers, each with 400 / 500 / 700", () => {
    expect(FONT_PACK_DATA.map((p) => p.id).sort()).toEqual([...FONT_PACK_IDS].sort());
    for (const p of FONT_PACK_DATA) {
      expect(p.weights.map((w) => w.weight)).toEqual([400, 500, 700]);
      expect(FONT_PACK_SOURCES[p.id].length).toBeGreaterThan(1);
    }
  });

  it("gives every file a plain name, a size and a sha256", () => {
    for (const p of FONT_PACK_DATA) {
      for (const w of p.weights) {
        expect(w.sheet[0]).toMatch(/^[\w/.-]+\.css$/);
        expect(w.chunks.length).toBeGreaterThan(0);
        for (const [name, size, sha] of [w.sheet, ...w.chunks]) {
          expect(name).not.toContain("..");
          expect(size).toBeGreaterThan(0);
          expect(sha).toMatch(/^[0-9a-f]{64}$/);
        }
        for (const [name] of w.chunks) expect(name).toMatch(/^[\w.-]+\.woff2$/);
      }
    }
  });

  it("stays in the sizes the settings card promises (≈15 MB and ≈6 MB)", () => {
    const mb = (id: string) => packBytes(FONT_PACK_DATA.find((p) => p.id === id)!) / 1e6;
    expect(mb("harmonyos")).toBeGreaterThan(10);
    expect(mb("harmonyos")).toBeLessThan(20);
    expect(mb("misans")).toBeGreaterThan(4);
    expect(mb("misans")).toBeLessThan(8);
  });
});
