/**
 * The unified focus ring's one structural requirement.
 *
 * `global.css` paints keyboard focus with a `box-shadow`, which puts it in
 * competition with every component rule that touches `box-shadow` on the same
 * element — and the app's usual button reset, `.class { all: unset }`, does
 * exactly that at 0-1-0. A single `:focus-visible` is 0-1-0 too, ties are
 * broken by source order, and CSS Modules are injected *after* `global.css`:
 * the reset wins, and the control focuses with nothing on screen.
 *
 * The fix is one character of redundancy — `:focus-visible:focus-visible`,
 * 0-2-0 — and it is exactly the kind of thing a later "cleanup" removes,
 * silently, with no test failing and no visual diff anywhere except under a
 * keyboard. Hence this test: the selector is the contract.
 *
 * Found while reviewing the pin-recents panel, where five `all: unset` buttons
 * had no visible focus at all. See `docs/reference/design-system.md` → 组件模式.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Read as bytes rather than importing: a `.css` import goes through Vite's CSS
// pipeline, and what this test is about is the *source text*.
const globalCss = readFileSync(
  fileURLToPath(new URL("../../styles/global.css", import.meta.url)),
  "utf8",
);

describe("the unified focus ring", () => {
  it("is declared with a doubled selector, so no single class can tie it", () => {
    expect(globalCss).toContain(":focus-visible:focus-visible");
    // And the ring itself is still the token, not an inlined shadow.
    const rule = globalCss.slice(globalCss.indexOf(":focus-visible:focus-visible"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("box-shadow: var(--shadow-focus)");
  });

  it("has no single-pseudo copy left behind that would shadow the doubled one", () => {
    // A leftover `:focus-visible {` at 0-1-0 is not harmful on its own, but it
    // is how the doubling gets quietly undone: someone reads the pair as a
    // duplicate and deletes the wrong half.
    const singles = globalCss.match(/(^|[\s,}])(:focus-visible)\s*\{/g) ?? [];
    expect(singles).toEqual([]);
  });
});
