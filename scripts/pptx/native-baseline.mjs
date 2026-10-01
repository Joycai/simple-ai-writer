/** Run the production native resolver/writer in Chrome; Office remains a separate check. */
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
const [outputArg, modules] = process.argv.slice(2);
if (!outputArg || !modules) throw new Error('Usage: node scripts/pptx/native-baseline.mjs NEW_OUTPUT_DIR EXTERNAL_NODE_MODULES');
const require = createRequire(resolve(modules, '../package.json'));
const { chromium } = require('playwright');
const output = resolve(outputArg);
await mkdir(output, { recursive: false });
const source = JSON.parse(await readFile('src/lib/pptx/native/__tests__/fixtures/six-layouts.slides.json', 'utf8'));
source.slides = source.slides.filter(s => ['title','bullets','image-text'].includes(s.layout));
const logo = (await readFile('public/logo.png')).toString('base64');
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  const result = await page.evaluate(async ({source, logo}) => {
    const { nativeEnvironment } = await import('/src/lib/pptx/native/environment.ts');
    const { resolveDeck } = await import('/src/lib/pptx/native/resolve.ts');
    const { nativeDeckToPptx } = await import('/src/lib/pptx/native/write.ts');
    const { imageHeader } = await import('/src/lib/pptx/native/imageHeader.ts');
    const env = nativeEnvironment('/fixture');
    env.loadImage = async (_, assetId) => {
      const bytes = Uint8Array.from(atob(logo), c => c.charCodeAt(0));
      const data = `data:image/png;base64,${logo}`;
      const image = new Image(); image.src = data; await image.decode();
      return { assetId, byteLength: bytes.length, ...imageHeader(bytes), data };
    };
    const result = await resolveDeck(source, env);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    return { bytes: Array.from(await nativeDeckToPptx(result.value)), fonts: result.value.fonts, risks: result.value.risks };
  }, {source,logo});
  await writeFile(resolve(output,'native.pptx'),Buffer.from(result.bytes));
  await writeFile(resolve(output,'source.slides.json'),JSON.stringify(source,null,2));
  await writeFile(resolve(output,'environment.json'),JSON.stringify({browser:browser.version(),fonts:result.fonts,risks:result.risks,office:'pending'},null,2));
  console.log(output);
} finally { await browser?.close(); await server.close(); }
