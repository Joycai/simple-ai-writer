import { describe, expect, it } from "vitest";
import source from "./fixtures/six-layouts.slides.json?raw";
import { parseDeckSpec, validateDeckSpec } from "../validate";
import { DECK_LIMITS as L, type DeckSpec } from "../model";

const fixture = (): DeckSpec => JSON.parse(source);
const errors = (input: unknown) => {
  const result = validateDeckSpec(input);
  expect(result.ok).toBe(false);
  return result.diagnostics;
};

describe("DeckSpec v1", () => {
  it("validates all six bilingual layouts without a DOM and preserves content", () => {
    expect(typeof document).toBe("undefined");
    const result = parseDeckSpec(source);
    expect(result).toEqual({ ok: true, value: fixture(), diagnostics: [] });
  });
  it.each([0, 2, "1", null, undefined])("rejects unknown version %s", version => {
    expect(errors({ ...fixture(), version })).toEqual([{ code: "unsupported_version", path: "/version" }]);
  });
  it.each([null, [], false, 1, "deck"])("rejects a non-object root %s", value => {
    expect(errors(value)[0].code).toBe("invalid_type");
  });
  it("rejects unknown fields instead of dropping style, coordinates or scripts", () => {
    const input = fixture();
    Object.assign(input.slides[0], { css: "color:red", "a/b~c": 12 });
    expect(errors(input)).toEqual([
      { code: "unknown_field", path: "/slides/0/css", slideId: "intro" },
      { code: "unknown_field", path: "/slides/0/a~1b~0c", slideId: "intro" },
    ]);
  });
  it("rejects unknown theme, language and inherited layout names", () => {
    expect(errors({ ...fixture(), theme: "unknown" })[0].path).toBe("/theme");
    expect(errors({ ...fixture(), language: "unknown" })[0].path).toBe("/language");
    for (const layout of ["constructor", "toString", "__proto__", "chart"]) {
      expect(errors({ ...fixture(), slides: [{ id: "x", title: "x", layout }] })[0].path).toBe("/slides/0/layout");
    }
  });
  it("rejects duplicate slide/asset IDs, unresolved references and ragged tables", () => {
    const input = fixture();
    input.assets.push({ id: "logo", path: "other.png" });
    input.slides[1].id = "intro";
    const image = input.slides[3];
    if (image.layout === "image-text") image.image.assetId = "absent";
    const table = input.slides[5];
    if (table.layout === "table") table.rows[1].pop();
    expect(errors(input).map(d => [d.code, d.path])).toEqual([
      ["duplicate_id", "/assets/1/id"], ["duplicate_id", "/slides/1/id"],
      ["missing_asset", "/slides/3/image/assetId"], ["table_width", "/slides/5/rows/1"],
    ]);
  });
  it.each(["../a.png", "/a.png", "C:/a.png", "\\\\host\\a.png", "a/../b.png", "a//b.png", "./a.png", "https://x/a.png", "a%2fb.png", "a.png?q=1", "a.svg", "a/ b.png", "a\u0000.png"])("rejects unsafe image path %s", path => {
    expect(errors({ ...fixture(), assets: [{ id: "logo", path }] })[0]).toEqual({ code: "unsafe_path", path: "/assets/0/path" });
  });
  it.each([NaN, Infinity, -Infinity, -0.1, 1.1, "0.5", null])("rejects invalid crop coordinate %s", x => {
    const input = fixture();
    const s = input.slides[3];
    if (s.layout === "image-text") Object.assign(s.image.anchor, { x });
    expect(errors(input)[0]).toEqual({ code: "invalid_value", path: "/slides/3/image/anchor/x", slideId: "picture" });
  });
  it.each(["", "  ", "a\u0000", "a\u000B", "\uD800", "\uDC00"])("rejects invalid text %j", title => {
    const input = fixture(); input.slides[0].title = title;
    expect(errors(input)[0].path).toBe("/slides/0/title");
  });
  it("accepts emoji, CJK, line breaks and empty table cells/notes", () => {
    const input = fixture(); input.slides[0].title = "中文 😀\nTitle"; input.slides[0].notes = "";
    const table = input.slides[5]; if (table.layout === "table") table.rows[0][0] = "";
    expect(validateDeckSpec(input).ok).toBe(true);
  });
  it("requires every nested field and rejects explicit undefined or sparse arrays", () => {
    const input = fixture(); Object.assign(input.slides[0], { notes: undefined });
    expect(errors(input)[0].code).toBe("invalid_type");
    expect(errors({ ...fixture(), slides: Array(1) })[0].path).toBe("/slides/0");
    const broken = JSON.parse(source); delete broken.slides[3].image.anchor.y;
    expect(errors(broken)[0].path).toBe("/slides/3/image/anchor/y");
  });
  it("enforces slide, asset, text and collection ceilings", () => {
    const input = fixture();
    expect(errors({ ...input, slides: [] })[0].code).toBe("limit_exceeded");
    expect(errors({ ...input, slides: Array(L.slides + 1).fill(input.slides[0]) })[0].path).toBe("/slides");
    expect(errors({ ...input, assets: Array(L.assets + 1).fill(input.assets[0]) })[0].path).toBe("/assets");
    input.slides[0].title = "a".repeat(L.title + 1);
    expect(errors(input)[0].path).toBe("/slides/0/title");
    for (const [layout, content] of [
      ["bullets", { bullets: Array(L.bullets + 1).fill("x") }],
      ["metrics", { metrics: Array(L.metrics + 1).fill({ label: "x", value: "1" }) }],
      ["table", { columns: ["x"], rows: Array(L.rows + 1).fill(["x"]) }],
      ["table", { columns: Array(L.columns + 1).fill("x"), rows: [["x"]] }],
    ] as const) expect(errors({ ...fixture(), slides: [{ id: "s", title: "x", layout, ...content }] })[0].code).toBe("limit_exceeded");
  });
  it("bounds UTF-8 bytes before parsing and returns controlled parse failures", () => {
    expect(parseDeckSpec("{" )).toEqual({ ok: false, diagnostics: [{ code: "invalid_json", path: "" }] });
    expect(parseDeckSpec("中".repeat(Math.ceil(L.sourceBytes / 3))).diagnostics[0].code).toBe("source_limit");
    expect(parseDeckSpec(" ".repeat(L.sourceBytes + 1)).diagnostics[0].code).toBe("source_limit");
  });
});
