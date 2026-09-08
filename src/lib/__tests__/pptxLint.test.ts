/**
 * The generation-side half of PPTX fidelity (pptx-plan.md §7): what the
 * exporter is known to lose, found in the page's source.
 *
 * One positive and one negative example per rule. The negatives matter as
 * much as the positives — a check that fires on `content: none` or on
 * `opacity: .9` teaches the model to ignore the whole paragraph.
 *
 * The last block is a source guard on `export_pptx`'s description: the rules
 * the model reads there and the rules this file enforces have to be the same
 * set (tool-presence.md), and the description must not keep saying things the
 * converter stopped doing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatLintFindings, lintDeckSource } from "../pptx/lint";

const page = (style: string, body = "") =>
  `<!doctype html>\n<html><head>\n<style>\n${style}\n</style>\n</head>\n<body>\n<section class="slide">\n${body}\n</section>\n</body></html>`;

const rules = (html: string) => lintDeckSource(html).map((f) => f.rule);

describe("lintDeckSource", () => {
  it("is empty for a page that converts as it looks", () => {
    const html = page(
      `.slide { width: 1280px; height: 720px; font-family: "PingFang SC", "Microsoft YaHei", Arial, sans-serif; }
       .card { background: linear-gradient(135deg, #3b82f6, #8b5cf6); border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.3); opacity: .9; }
       .badge { transform: rotate(-12deg); }
       li::marker { color: red; }`,
      `<h1 style="letter-spacing: .02em">Title</h1><img src="a.png" style="object-fit: cover">`,
    );
    expect(lintDeckSource(html)).toEqual([]);
    expect(formatLintFindings([])).toBe("");
  });

  it("P1: pseudo-element content is lost; `content: none` is not", () => {
    const html = page(`li::before { content: "•"; color: #3b82f6; }\n.bar:after { content: ""; width: 40px; height: 4px; }`);
    const found = lintDeckSource(html);
    expect(found.map((f) => [f.rule, f.level, f.line])).toEqual([
      ["P1", "lost", 4],
      ["P1", "lost", 5],
    ]);
    expect(found[0].what).toContain("`li::before`");
    expect(rules(page(`li::before { content: none; }\n.x::after { color: red; }`))).toEqual([]);
  });

  it("P2: an entrance animation starting at opacity 0 is lost; a translucent element is not", () => {
    expect(rules(page(`.reveal { opacity: 0; animation: fadeIn .6s forwards; }`))).toEqual(["P2"]);
    expect(rules(page(`.reveal { opacity: 0; transition: opacity .4s; }\n.reveal.in { opacity: 1 }`))).toEqual(["P2"]);
    // Keyframes elsewhere on the page make a bare `opacity: 0` suspect too —
    // the animation-name is often on a sibling rule.
    expect(rules(page(`@keyframes up { from { opacity: 0 } to { opacity: 1 } }\n.item { opacity: 0 }`))).toEqual(["P2"]);
    // The keyframe steps themselves are not findings.
    expect(rules(page(`@keyframes up { from { opacity: 0 } to { opacity: 1 } }`))).toEqual([]);
    expect(rules(page(`.glass { opacity: .9; }\n.ghost { opacity: 0.0; }`))).toEqual([]);
  });

  it("P3: media elements are lost", () => {
    expect(rules(page("", `<video src="a.mp4"></video>`))).toEqual(["P3"]);
    expect(rules(page("", `<iframe src="x"></iframe><audio src="y"></audio>`)).sort()).toEqual(["P3", "P3"]);
    expect(rules(page("", `<img src="a.png">`))).toEqual([]);
  });

  it("P4: a font PowerPoint does not have shifts the layout; the system stack does not", () => {
    const found = lintDeckSource(page(`body { font-family: 'Inter', system-ui, sans-serif; }\nh1 { font-family: Inter; }`));
    expect(found.map((f) => [f.rule, f.level])).toEqual([["P4", "shifted"]]);
    expect(found[0].what).toContain('"Inter"');
    expect(rules(page(`body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif }\ncode { font-family: Consolas, monospace }\n.zh { font-family: "微软雅黑" }`))).toEqual([]);
    // Loading one is the same finding, however it is loaded.
    expect(rules(`<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"><style>body{font-family:Arial}</style>`)).toEqual(["P4"]);
    expect(rules(`<style>@font-face { font-family: "Brand"; src: url(brand.woff2); }</style>`)).toEqual(["P4", "P4"]);
  });

  it("P5: a composite transform loses its angle; a pure rotate does not", () => {
    expect(rules(page(`.a { transform: rotate(-6deg) translate(-50%, -50%); }`))).toEqual(["P5"]);
    expect(rules(page(`.b { transform: skewX(12deg); }`))).toEqual(["P5"]);
    expect(rules(page(`.c { transform: rotate(45deg); }\n.d { transform: translateY(-4px); }\n.e { transform: scale(1.1) }`))).toEqual([]);
  });

  it("P6: vertical writing comes out horizontal", () => {
    expect(rules(page(`.side { writing-mode: vertical-rl; }`))).toEqual(["P6"]);
    expect(rules(page(`.side { writing-mode: horizontal-tb; }`))).toEqual([]);
  });

  it("P7 / P8: text-shadow, filters, blend modes are dropped", () => {
    expect(rules(page(`h1 { text-shadow: 0 2px 8px rgba(0,0,0,.4); }`))).toEqual(["P7"]);
    expect(rules(page(`.glass { backdrop-filter: blur(12px); }\n.dim { filter: brightness(.8) }\n.mul { mix-blend-mode: multiply }`))).toEqual(["P8", "P8", "P8"]);
    expect(rules(page(`h1 { text-shadow: none; }\n.x { filter: none; mix-blend-mode: normal; box-shadow: 0 1px 2px #000 }`))).toEqual([]);
    expect(lintDeckSource(page(`.glass { backdrop-filter: blur(12px); }`))[0].what).toContain("frosted-glass");
  });

  it("P9: only a plain linear-gradient is faithful", () => {
    expect(rules(page(`.a { background: radial-gradient(circle at top, #fff, #000); }`))).toEqual(["P9"]);
    expect(rules(page(`.b { background-image: url(hero.jpg); background-size: cover; }`))).toEqual(["P9"]);
    expect(rules(page(`.c { background: linear-gradient(#fff, #000), url(noise.png); }`))).toEqual(["P9"]);
    expect(rules(page(`.d { background: linear-gradient(135deg, #3b82f6, #8b5cf6); }\n.e { background: rgba(255,255,255,.12) }`))).toEqual([]);
  });

  it("P10: words inside an SVG become a picture", () => {
    expect(rules(page("", `<svg viewBox="0 0 10 10"><text x="1" y="5">42%</text></svg>`))).toEqual(["P10"]);
    expect(rules(page("", `<svg viewBox="0 0 10 10"><circle r="4"/></svg><p>42%</p>`))).toEqual([]);
  });

  it("ignores comments, reads inline styles, and reports each line where it is", () => {
    const html = [
      "<style>",
      "/* h1::before { content: 'x' } */",
      "h1 { color: red }",
      "</style>",
      "<!-- <video></video> -->",
      `<div style="text-shadow: 0 0 4px #000; font-family: Poppins">x</div>`,
    ].join("\n");
    const found = lintDeckSource(html);
    expect(found.map((f) => [f.rule, f.line])).toEqual([
      ["P4", 6],
      ["P7", 6],
    ]);
  });

  it("orders lost before shifted before approximated, and says each thing once", () => {
    const html = page(
      `h1 { text-shadow: 0 0 1px #000; font-family: Inter }
       h2 { font-family: Inter }
       li::before { content: "•" }`,
    );
    expect(lintDeckSource(html).map((f) => f.rule)).toEqual(["P1", "P4", "P7"]);
  });
});

describe("formatLintFindings", () => {
  it("says where it looked, names the level, and caps the list", () => {
    const one = formatLintFindings(lintDeckSource(page(`li::before { content: "•" }`)));
    expect(one).toMatch(/^Found in the SOURCE \(not measured\)/);
    expect(one).toContain("- LOST line 4: `li::before` draws pseudo-element content");
    expect(one).toContain("Fix: draw it with a real element");

    const many = Array.from({ length: 15 }, (_, i) => `.f${i}::before { content: "${i}" }`).join("\n");
    const text = formatLintFindings(lintDeckSource(page(many)));
    expect(text.split("\n")).toHaveLength(1 + 12 + 1);
    expect(text).toMatch(/- and 3 more\.$/);
  });
});

describe("export_pptx's description", () => {
  const registry = readFileSync(resolve(__dirname, "../agent/registry.ts"), "utf8");
  const description = registry.match(/name: "export_pptx",\s*description:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";

  it("tells the model the rules the source check enforces", () => {
    // tool-presence.md: a tool's words match what the pipeline can do. The
    // two constructs the harvester can never see are the two that must be
    // said up front; everything else the check names after the fact.
    expect(description).toContain("::before/::after");
    expect(description).toContain("opacity 0");
    expect(description).toContain("SYSTEM fonts");
    expect(description).toContain("inspect_html");
  });

  it("stopped describing degradations the converter no longer makes", () => {
    // A gradient is rasterized and a box-shadow carried since §6.7; saying
    // otherwise would steer the model away from things that now work.
    expect(description).not.toMatch(/average solid colou?r/);
    expect(description).not.toMatch(/shadows? .* dropped/);
  });
});
