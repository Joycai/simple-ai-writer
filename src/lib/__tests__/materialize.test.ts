/**
 * The pure half of landing a cached conversion in the project
 * (lib/import/materialize.ts): where it goes and how its picture links move.
 * docs/feature/agent/document-read-plan.md §10.
 */
import { describe, expect, it } from "vitest";
import { conversionTargetFor, encodeRelDir, relinkAssets } from "../import/materialize";

describe("conversionTargetFor", () => {
  it("is the same folder, the markdown name", () => {
    expect(conversionTargetFor("/p/招标/招标文件.docx")).toBe("/p/招标/招标文件.md");
    expect(conversionTargetFor("/p/a.b.PDF")).toBe("/p/a.b.md");
  });
});

describe("relinkAssets", () => {
  it("moves picture links from the cache's assets/ to the document's own folder, percent-encoded", () => {
    const md = "前言\n\n![图](assets/p1-1.jpg)\n\n![](assets/p2-3.png \"t\")\n";
    const out = relinkAssets(md, "assets", "assets/招标文件");
    const dir = encodeRelDir("assets/招标文件");
    expect(dir).toBe(`assets/${encodeURIComponent("招标文件")}`);
    expect(out).toBe(`前言\n\n![图](${dir}/p1-1.jpg)\n\n![](${dir}/p2-3.png \"t\")\n`);
  });

  it("leaves prose that mentions a path, and links elsewhere, alone", () => {
    const md = "见 assets/p1-1.jpg 一图。[站点](https://x.test/assets/a.png) ![](other/assets/b.png)";
    expect(relinkAssets(md, "assets", "assets/doc")).toBe(md);
  });

  it("is a no-op for a document without pictures", () => {
    expect(relinkAssets("只有文字", "assets", "assets/doc")).toBe("只有文字");
  });
});
