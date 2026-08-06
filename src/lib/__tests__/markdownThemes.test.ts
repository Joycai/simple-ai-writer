import { describe, it, expect } from "vitest";
import {
  DEFAULT_MARKDOWN_THEME,
  MARKDOWN_THEMES,
  MARKDOWN_THEME_IDS,
  findMarkdownTheme,
  markdownThemeCss,
  markdownThemesCss,
} from "../theme/markdownThemes";

describe("markdown themes", () => {
  it("declares exactly one definition per id, including the default", () => {
    expect(MARKDOWN_THEMES.map((t) => t.id).sort()).toEqual([...MARKDOWN_THEME_IDS].sort());
    expect(MARKDOWN_THEME_IDS).toContain(DEFAULT_MARKDOWN_THEME);
  });

  it("falls back to the first theme for unknown or missing ids", () => {
    expect(findMarkdownTheme(null).id).toBe(DEFAULT_MARKDOWN_THEME);
    expect(findMarkdownTheme("no-such-theme").id).toBe(DEFAULT_MARKDOWN_THEME);
  });

  it("generates balanced CSS with every placeholder substituted", () => {
    const css = markdownThemesCss();
    expect(css).not.toContain("&");
    expect((css.match(/{/g) ?? []).length).toBe((css.match(/}/g) ?? []).length);
    for (const id of MARKDOWN_THEME_IDS) expect(css).toContain(`[data-md-theme="${id}"]`);
  });

  it("emits the pinned scope after the inherited one so a pinned container wins", () => {
    // Both selectors have the same specificity, so source order is what keeps a
    // container that names its own theme (the settings samples) from being
    // overridden by whichever theme happens to come later in the list.
    const css = markdownThemesCss();
    for (const id of MARKDOWN_THEME_IDS) {
      expect(css.indexOf(`.md-body[data-md-theme="${id}"]`))
        .toBeGreaterThan(css.indexOf(`[data-md-theme="${id}"] .md-body`));
    }
  });

  it("keeps the base defaults at zero specificity so surfaces can size themselves", () => {
    // The stylesheet is injected after the app's CSS modules; without :where()
    // the base --md-size would beat a surface class like .preview { --md-size }.
    expect(markdownThemesCss()).toContain(":where(.md-body)");
  });

  it("lets themes scale, never set, the base size", () => {
    for (const theme of MARKDOWN_THEMES) {
      expect(Object.keys(theme.vars)).not.toContain("--md-size");
    }
  });

  it("scopes a single theme to an arbitrary container for export", () => {
    const css = markdownThemeCss("wechat", "body");
    expect(css).toContain("body h2::after");
    expect(css).not.toContain(".md-body");
    expect(css).not.toContain("data-md-theme");
  });
});
