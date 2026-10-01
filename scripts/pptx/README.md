# PPTX export regression harness

This development harness runs the existing `harvestDeck` and `deckToPptx` functions in a real browser. It is not part of the application bundle. The fixture covers six planned layouts plus unsupported legacy effects. Content is synthetic; the raster is the repository's own logo.

## Browser export

Requires Node, the repository's installed dependencies, Chrome, Arial and PingFang SC. Install Playwright and Sharp in a separate development tools directory, or use an existing runtime providing them. Pass its **node_modules** directory as the optional last argument. No extra browser download is needed (`channel: chrome`).

```sh
node scripts/pptx/baseline.mjs /tmp/pptx-baseline /path/to/tools/node_modules
```

Use a new output directory each time. The script fails rather than overwriting evidence. It saves the self-contained HTML, seven browser PNGs, harvested model/diagnostics, environment metadata with actual title fonts, and three PPTX files:

- `baseline.pptx`: unmodified legacy conversion.
- `missing-image.pptx`: image removed from slide 4 after harvesting.
- `clipped-text.pptx`: slide 2's title moved below the canvas after harvesting.

The browser loads trusted repository fixtures, runs at 1280 × 720 and uses the production sandboxed harvest iframe. This harness does **not** reproduce Tauri's complete CSP or WebView runtime; existing CSP guards remain necessary. `document.fonts.check` is insufficient by itself, so the harness also records Chromium's actual font selection.

## Real rendering

Open the three PPTX files in PowerPoint and export all slides to PDF/PNG. Record the PowerPoint/OS/font versions, check for repair prompts, and inspect every slide. Windows and macOS PowerPoint remain release requirements. Never use HTML screenshots as evidence that PowerPoint output passed.

LibreOffice is an auxiliary renderer, not PowerPoint equivalence. Use an explicitly selected development renderer; when working in Codex use the bundled absolute path returned by `load_workspace_dependencies`, never the user's desktop LibreOffice. For example:

```sh
"$PPTX_SOFFICE" -env:UserInstallation=file:///tmp/pptx-render-profile --headless \
  --convert-to pdf --outdir /tmp/pptx-baseline /tmp/pptx-baseline/baseline.pptx
"$PPTX_PDFTOPPM" -png -scale-to-x 1280 -scale-to-y 720 \
  /tmp/pptx-baseline/baseline.pdf /tmp/pptx-baseline/lo
```

Headless font discovery may differ from desktop discovery. Supply `FONTCONFIG_FILE` with the selected font directories and a writable cache if needed. Record those font hashes and inspect the rendered CJK glyphs. Do not accept an empty-glyph render as a baseline or fix it by loosening comparison tolerances.

## Comparing repeat renders

```sh
node scripts/pptx/compare-renders.mjs baseline.png candidate.png /tmp/pptx-diff /path/to/tools/node_modules
```

Only compare renders from the **same** renderer, font environment, resolution and content. Dimensions must match. Exit 0 means no region exceeded the threshold; exit 1 means review required. Other errors are not successful defect detection. The script writes JSON plus a pink difference image.

The initial threshold is a maximum RGB-channel difference of 24, with more than 5% changed pixels in any 128 × 128 tile requiring review. This avoids diluting a missing image or clipped title across an entire white slide. It is a smoke guard, not OCR or proof against all clipping, text loss or antialiasing differences. Calibrate separately for each renderer; do not compare HTML against Office using these tolerances.

For a new baseline, render the unchanged PPTX twice independently (expect no flagged tiles), then render the two injected defects (expect nonzero flagged tiles on slides 4 and 2 respectively). Inspect every page and the difference images before accepting. Never regenerate an accepted baseline automatically in CI. The committed legacy baseline records existing failures; it is not an approved visual target for the future native exporter.

Current evidence and remaining verification: `docs/feature/pptx-plan.md` §8.7.

## Native layout fixtures

Run `node scripts/pptx/native-baseline.mjs NEW_OUTPUT_DIR EXTERNAL_NODE_MODULES [SOURCE_JSON]`
with the bundled Node package path from `load_workspace_dependencies` (Playwright + Chrome).
The harness uses the complete six-layout source by default and calls the production
native resolver/writer; only the fixed logo read replaces Tauri IPC. It records selected fonts
and leaves Office validation pending. Open `native.pptx` in PowerPoint, inspect each slide in
slide show mode, then export PDF with **Best for printing** (local). Render that PDF with
PDFium and inspect all pages. P3 found that bundled Poppler omitted some slash glyphs
from the same PowerPoint PDF; cross-check suspected missing glyphs in Office and a second
PDF renderer before changing layout code. Never compare baselines across PDF renderers.
The accepted macOS evidence is in `docs/feature/pptx-baseline/2026-10-01-native/`.
Chrome measurements alone cannot catch the PingFang missing-glyph failure recorded there.

For capacity coverage, pass `src/lib/pptx/native/__tests__/fixtures/capacity.slides.json`
as the optional source. This midnight-theme deck covers four bullets per comparison column,
six metrics, six columns/seven body rows, and bilingual table paragraphs with blank cells/lines.
The original P2 evidence remains a three-layout snapshot; it is not overwritten by this harness.

P3 evidence is in `docs/feature/pptx-baseline/2026-10-01-native-p3/` (six standard
slides and four capacity slides). Render the local Office PDF at 1280 × 720 using a
Python runtime providing `pypdfium2` (5.13.0 for this baseline):

```python
from pathlib import Path
import pypdfium2 as pdfium

output = Path("/tmp/pptx-native")
pdf = pdfium.PdfDocument(output / "native.pdf")
for i in range(len(pdf)):
    pdf[i].render(scale=4 / 3).to_pil().save(output / f"powerpoint-{i + 1}.png")
```


## Native agent approval smoke test (P4)

```sh
node scripts/pptx/approval-smoke.mjs /tmp/pptx-approval-new /path/to/runtime/node_modules
```

Requires local Chrome and Playwright, like the native baseline runner. The output directory must be new.
Runs production `export_pptx`, native font/layout/writer, `ApprovalCard` and `applyProposal` against fictional
files through mocked Tauri IPC. Captures English/Chinese, light/dark, wide/240px approval cards, then
clicks Approve and saves the six-slide PPTX plus a report showing the previous-file backup.
This verifies browser integration; it does not exercise a live model, Tauri filesystem permissions or Office rendering.
The P3 evidence remains the unchanged writer/layout's PowerPoint baseline.
