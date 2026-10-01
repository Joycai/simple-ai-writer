/** Developer-only real-browser fixture export. No app IPC or project data. */
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [outputArg, toolsDir] = process.argv.slice(2);
if (!outputArg) throw new Error('Usage: node scripts/pptx/baseline.mjs OUTPUT_DIR [EXTERNAL_NODE_MODULES]');
const require = createRequire(toolsDir ? resolve(toolsDir, '../package.json') : import.meta.url);
const { chromium } = require('playwright');
const output = resolve(outputArg);
await mkdir(output, { recursive: false }); // Never overwrite an accepted baseline.
const sourcePath = 'src/lib/pptx/__tests__/fixtures/baseline.html';
const source = await readFile(resolve(root, sourcePath), 'utf8');
const logo = await readFile(resolve(root, 'public/logo.png'));
const html = source.replace('__BASELINE_IMAGE__', `data:image/png;base64,${logo.toString('base64')}`);
await writeFile(resolve(output, 'source.html'), html);
const server = await createServer({
  configFile: false, root, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { include: ['pptxgenjs', 'nanoid'] },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.goto(server.resolvedUrls.local[0] + 'src/lib/pptx/__tests__/fixtures/baseline.html');
  await page.setContent(html);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode()));
  });
  const fontStatus = await page.evaluate(() => ({
    latin: document.fonts.check('28px Arial'), cjk: document.fonts.check('28px "PingFang SC"'),
  }));
  // fonts.check alone can succeed via fallback. Record the actual fonts used
  // by the bilingual title via Chromium's inspection API.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root: dom } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: dom.nodeId, selector: 'h1' });
  const { fonts: renderedFonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  if (!renderedFonts.some(font => font.familyName === 'Arial') ||
      !renderedFonts.some(font => /PingFang/.test(font.familyName))) {
    throw new Error(`Baseline requires Arial and PingFang SC; actual: ${JSON.stringify(renderedFonts)}`);
  }
  const slides = page.locator('section.slide');
  for (let i = 0; i < await slides.count(); i++) {
    await slides.nth(i).screenshot({ path: resolve(output, `html-${i + 1}.png`) });
  }
  const result = await page.evaluate(async (html) => {
    const { harvestDeck } = await import('/src/lib/pptx/harvest.ts');
    const { deckToPptx } = await import('/src/lib/pptx/write.ts');
    const { inspectDeck, formatDeckReport } = await import('/src/lib/pptx/inspect.ts');
    const { lintDeckSource } = await import('/src/lib/pptx/lint.ts');
    const deck = await harvestDeck(html, null);
    const missingImage = structuredClone(deck);
    missingImage.slides[3].blocks = missingImage.slides[3].blocks.filter(b => b.kind !== 'image');
    const clippedText = structuredClone(deck);
    const title = clippedText.slides[1].blocks.find(b => b.kind === 'text');
    if (!title) throw new Error('Fixture has no title to mutate');
    title.y = deck.canvas.height - 12;
    return {
      deck, report: formatDeckReport(inspectDeck(deck), 'baseline.html', 'section.slide'),
      lint: lintDeckSource(html),
      clippedReport: formatDeckReport(inspectDeck(clippedText), 'clipped.html', 'section.slide'),
      files: {
        'baseline.pptx': Array.from(await deckToPptx(deck)),
        'missing-image.pptx': Array.from(await deckToPptx(missingImage)),
        'clipped-text.pptx': Array.from(await deckToPptx(clippedText)),
      },
    };
  }, html);
  for (const [name, bytes] of Object.entries(result.files)) await writeFile(resolve(output, name), Buffer.from(bytes));
  delete result.files;
  await writeFile(resolve(output, 'harvest.json'), JSON.stringify(result, null, 2));
  await writeFile(resolve(output, 'environment.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    node: process.version, browser: browser.version(),
    pptxgenjs: JSON.parse(await readFile(resolve(root, 'node_modules/pptxgenjs/package.json'), 'utf8')).version,
    sourceSha256: createHash('sha256').update(html).digest('hex'),
    fonts: { requested: ['Arial', 'PingFang SC'], browserCheck: fontStatus, actualTitleFonts: renderedFonts },
    renderer: 'UNVERIFIED: export these PPTX files in PowerPoint and record its version',
  }, null, 2));
  console.log(result.report);
  console.log(`Artifacts: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
