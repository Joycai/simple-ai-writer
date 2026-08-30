/**
 * The data-line source anchors the split view's scroll link aligns on.
 *
 * Two contracts pinned here: only *top-level* blocks are stamped (nested
 * ranges overlap, and scrollSync's interpolation assumes anchors ascending in
 * both line and pixel order — disjoint top-level ranges are what guarantee
 * that), and nothing is stamped unless asked (renderMarkdown also produces
 * exported HTML, chat bubbles and approval cards, which must stay free of
 * editor plumbing).
 */
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../fs/markdown";

const SOURCE = "# 标题\n\n第一段。\n\n> 引用里的\n> 两行\n\n```js\nconst x = 1;\n```\n";

describe("renderMarkdown line anchors", () => {
  it("stamps nothing by default, keeping exports and chat clean", () => {
    expect(renderMarkdown(SOURCE)).not.toContain("data-line");
  });

  it("stamps top-level blocks with their token.map range", () => {
    const html = renderMarkdown(SOURCE, { lineAnchors: true });
    expect(html).toContain('<h1 data-line="0" data-line-end="1">');
    expect(html).toContain('<p data-line="2" data-line-end="3">');
    expect(html).toContain('<blockquote data-line="4" data-line-end="6">');
    // The fence keeps its anchors through the language-class render path.
    expect(html).toMatch(/<pre><code[^>]*data-line="7"[^>]*data-line-end="10"/);
  });

  it("does not stamp blocks nested inside another", () => {
    const html = renderMarkdown(SOURCE, { lineAnchors: true });
    // The paragraph inside the blockquote must carry no anchor of its own.
    expect(html).toMatch(/<blockquote[^>]*>\s*<p>/);
  });

  it("keeps anchors ascending in source order for interpolation", () => {
    const html = renderMarkdown("段一\n\n- 甲\n- 乙\n\n段二\n", { lineAnchors: true });
    const lines = [...html.matchAll(/data-line="(\d+)"/g)].map((m) => Number(m[1]));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines).toEqual([...lines].sort((x, y) => x - y));
  });
});
