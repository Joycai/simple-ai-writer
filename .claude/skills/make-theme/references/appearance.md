# Appearance themes (外观主题)

An appearance theme is **a set of tokens, not a stylesheet**. The app's colours
come in three tiers: *scale* (spacing, radii, type size — not a theme's),
*core* (41 tokens), and *derived* (~200 more, `color-mix`ed out of the core in
`src/styles/tokens.css`'s derive layer). Write the 41 and the whole app is
retinted; that is all the built-in Stone / Ink / Frost / Indigo do.

## The fence

| Allowed | Dropped (rule by rule, listed on the Settings card) |
|---|---|
| `:root { … }` (also `[data-theme="<id>"]`, but it breaks on rename — use `:root`) | any other selector: `body`, `.sidebar`, `:root .x` |
| core and derived token names | scale tokens (`--radius-*`, `--font-size-*`, `--space-*` …), unknown names, plain properties (`background: …`) |
| — | **every** at-rule, `@media (prefers-color-scheme)` included — polarity is `--theme-scheme`'s call, not the OS's |

So a light + dark scheme is two files. The only "whole file unusable" cases are
a missing `--theme-name` / `--theme-scheme`, a reserved id, or an appearance
theme placed in a project folder.

## Metadata

```css
:root {
  --theme-name: 物理猫 · 薄荷青;  /* required — the card's name; one name, any language */
  --theme-kind: ui;               /* required */
  --theme-scheme: light;          /* required — light | dark: which band it sits in */
  --theme-extends: paper;         /* light → paper, dark → night. Anything else is a problem */
  --theme-version: 1;             /* optional */
  --theme-author: …;              /* optional — credit a source palette here too */
}
```

## The 41, and what each is *for*

The names `sienna` and `amber` are the built-in Paper theme's words. Read them
as **the one accent** and **the companion**; they need not be brown.

| Group | Tokens | What to know |
|---|---|---|
| Grounds | `--color-bg-base` | the page / editor ground — the colour the theme "is" |
| | `--color-bg-surface` | sidebar, rail, cards, popovers. Light: *lighter* than base. Dark: slightly *darker* |
| | `--color-bg-elevated` `--color-bg-hover` | two steps away from base (light: darker, dark: lighter). The step size is what makes hover visible — keep the ramp |
| | `--color-bg-tinted` | light: = base; dark: = elevated |
| | `--color-bg-overlay` | modal scrim, an `rgba()` |
| Text | `--color-text-primary` … `-secondary` `-muted` `-faint` `-ghost` | five steps. Targets over base: ≥ 7, ≥ 4.5, ≥ 3; faint and ghost are decoration (placeholders, disabled) |
| Accent | `--color-sienna` | **a 1px hairline, a filled button and the focus ring at once** — under 4.5:1 on base one of the three stops reading. `--color-bg-surface` is the label on the filled button, so it must read over the accent as well |
| | `--color-sienna-hover` | light: darker. **Dark: lighter** ("pressed = brighter" on a dark ground) |
| | `--color-amber` `--color-amber-soft` | the companion: strong rules, tags, the other end of a gradient; soft is its wash (light: a pale hex; dark: `rgba(companion, .28)`) |
| Rules | `--color-border` `--color-border-soft` `--color-border-strong` | strong = the companion on light, = text-faint on dark |
| Status | `--color-success` `--color-warning` `--color-error` | semantic hues — keep green / amber / red unless the source scheme defines its own |
| Model-type tags | `--color-type-{text,multimodal,image,video,vision,asr}-{bg,fg}` | six hue-coded chips; each fg ≥ 4.5:1 on its bg. Light: pale hex bg. Dark: `rgba(…, .18)` wash + light fg |
| Elevation, glass | `--shadow-sm/md/lg/xl/drawer` `--glass-bg` `--glass-bg-strong` `--glass-border` | light shadows are tinted with the text colour at low alpha; dark shadows are plain black at high alpha. Glass = the surface colour at .85 / .72 (light) or .80 / .62 (dark) |

Write all 41. A partial file installs, but the missing tokens inherit Paper's
or Night's *hues* — warm brown borders under a cold blue ground read as a bug.

## How the shipped set was made (and what the generator automates)

`scripts/palette.mjs` encodes the method behind the Phycat suite
(`docs/feature/theme-system-plan.md` §13 S7):

1. **Hue from the source, lightness ramp from the built-ins.** Every neutral
   keeps the OKLCH lightness of Stone (light) or Ink (dark) and takes the
   theme's hue at a small chroma. `--tint` is that chroma: ~0.005 reads as grey,
   0.012–0.02 as tinted paper (Phycat), above ~0.03 the chrome starts competing
   with the text. With `--ground "#hex"` the base lands exactly on the source's
   colour and the other grounds shift with it, steps intact.
2. **The accent is re-computed, not copied.** A source's brand colour was
   chosen for headings and icons; here it is also a hairline. The generator
   keeps hue and chroma and moves lightness until it clears `--contrast`
   (default 4.6) over base. On dark grounds vivid accents usually pass as they
   are and are left alone.
3. **Status and tag colours are copied from the built-in.** Override by hand
   only when the source scheme really has its own (Solarized's, Nord's aurora).

After generating, the hand-tuning that is usually worth doing:

- a real second colour for `--color-amber` (`--companion`) when the source has
  one — otherwise it is a lighter shade of the accent, which is fine but quiet;
- schemes with a fixed, famous palette (Nord, Dracula, Gruvbox, Solarized,
  Catppuccin): pin the grounds and text to the published hexes where they fit
  the ramp's *order* (base → elevated → hover monotonic), and let the generator
  fill what the scheme does not define. Say in the header which values are the
  scheme's and which are derived;
- a low-contrast "soft" look is a legitimate request — honour it in the grounds
  and secondary text, but keep accent ≥ 4.5 and primary ≥ 7; those two are what
  the shipped-sample test enforces and what keeps the app usable.

## File header

Bilingual (中文 first, then English), matching `themes/phycat-mint.css`: what
it is and where the colours came from (with licence if borrowed), the paired
typography theme if any, how to install, how to make it yours. The generator
writes the install / customise boilerplate and leaves two `TODO` lines for the
part only you know.
