import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../fs/markdown";

/**
 * Guards the KaTeX wiring in lib/fs/markdown.ts, which has two failure modes
 * that a type-check cannot see and a successful build does not rule out:
 *
 * 1. @vscode/markdown-it-katex is a CommonJS/UMD bundle setting `exports.default`,
 *    so the default import is the plugin function on some loaders and a
 *    `{ default }` wrapper on others; `md.use()` on the wrapper throws
 *    "plugin.apply is not a function".
 * 2. The plugin's own `require("katex")` resolves KaTeX's UMD dist — a second
 *    copy whose symbol tables don't survive re-bundling, so every backslash
 *    command fails with "Undefined control sequence" while bare `x^2` renders
 *    fine. Hence the explicit `{ katex }` injection, and hence the assertions
 *    below use real commands rather than plain exponents.
 */
describe("renderMarkdown + KaTeX", () => {
  const commands = ["\\frac{a}{b}", "\\alpha", "\\sqrt{2}", "\\sum_{i=1}^{n} i"];

  it.each(commands)("renders %s without a KaTeX parse error", (latex) => {
    const html = renderMarkdown(`$${latex}$`);
    expect(html).not.toMatch(/Undefined control sequence|ParseError/);
    expect(html).toContain('class="katex"');
  });

  it("renders inline math into KaTeX markup", () => {
    const html = renderMarkdown("行内 $E=mc^2$ 收尾");
    expect(html).toContain('class="katex"');
    // The MathML branch is the screen-reader copy; katex.min.css visually hides
    // it. Its presence is what makes importing that stylesheet mandatory.
    expect(html).toContain("katex-mathml");
  });

  it("renders block math with the display class Preview.module.css targets", () => {
    const html = renderMarkdown("$$\n\\frac{a}{b}\n$$");
    expect(html).not.toMatch(/Undefined control sequence|ParseError/);
    // `.katex-display` is what the `overflow-x: auto` rule hooks onto, so it
    // has to survive any future swap of the plugin.
    expect(html).toContain("katex-display");
  });

  it("leaves prose and bare dollar amounts alone", () => {
    const html = renderMarkdown("价格 $5 到 $10 之间，没有公式。");
    expect(html).not.toContain("katex");
    expect(html).toContain("价格");
  });

  it("still renders headings and links alongside the plugin", () => {
    const html = renderMarkdown("# 标题\n\n见 https://example.com 链接");
    expect(html).toContain("<h1>");
    expect(html).toContain('<a href="https://example.com"');
  });
});
