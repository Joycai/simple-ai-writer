import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));

test('bundled notice texts retain their recorded source hashes', () => {
  const data = JSON.parse(readFileSync(new URL('../../src/assets/legal/third-party-notices.json', import.meta.url)));
  for (const entry of data.entries) for (const file of entry.files) {
    assert.equal(createHash('sha256').update(file.text).digest('hex'), file.sha256, `${entry.name}/${file.name}`);
  }
});

test('notice collection agrees with installed locked dependencies', () => {
  execFileSync(process.execPath, ['scripts/appstore-notices.mjs', '--check'], { cwd: root, stdio: 'pipe' });
});

test('every bundled Fontsource import has an OFL notice with original copyright', () => {
  const data = JSON.parse(readFileSync(new URL('../../src/assets/legal/third-party-notices.json', import.meta.url)));
  const imports = readFileSync(new URL('../../src/styles/fonts.ts', import.meta.url), 'utf8');
  const names = new Set([...imports.matchAll(/import "(@fontsource\/[^/]+)\//g)].map(m => m[1]));
  assert.ok(names.size > 0);
  for (const name of names) {
    const entry = data.entries.find(e => e.name === name);
    assert.equal(entry?.license, 'OFL-1.1', name);
    assert.ok(entry.files.some(f => f.text.includes('Copyright') && f.text.includes('SIL OPEN FONT LICENSE')), name);
  }
});

test('direct frontend dependencies have notices or an explicit unresolved JS-plugin exception', () => {
  const data = JSON.parse(readFileSync(new URL('../../src/assets/legal/third-party-notices.json', import.meta.url)));
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
  // LICENSE.spdx alone has not yet supplied full original terms for these JS packages.
  const pending = new Set(['@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs', '@tauri-apps/plugin-http',
    '@tauri-apps/plugin-notification', '@tauri-apps/plugin-opener', '@tauri-apps/plugin-sql']);
  for (const name of Object.keys(pkg.dependencies)) {
    assert.ok(pending.has(name) || data.entries.some(e => e.name === name && e.source?.startsWith('https://www.npmjs.com/')), name);
  }
});

test('PDF preview resource glob has complete byte-preserving notice and resource inventory', () => {
  const data = JSON.parse(readFileSync(new URL('../../src/assets/legal/third-party-notices.json', import.meta.url)));
  const entry = data.entries.find(e => e.name === 'pdfjs-dist');
  const preview = readFileSync(new URL('../../src/components/editor/PdfPreview.tsx', import.meta.url), 'utf8');
  assert.ok(preview.includes('/node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*'), 'Review changed PDF asset scope');
  for (const resource of entry.resources) {
    const bytes = readFileSync(new URL(`../../node_modules/pdfjs-dist/${resource.name}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), resource.sha256, resource.name);
    if (/\/(LICENSE|NOTICE|COPYING)/i.test(resource.name)) {
      const notice = entry.files.find(f => f.name === resource.name);
      assert.equal(notice?.text, bytes.toString('utf8'), resource.name);
    }
  }
  assert.ok(entry.files.find(f => f.name === 'standard_fonts/LICENSE_LIBERATION').text.includes('GNU GENERAL PUBLIC LICENSE'));
  assert.ok(entry.files.find(f => f.name === 'wasm/LICENSE_JBIG2').text.includes('Apache License'));
});

test('PDF source supplements remain bound to the reviewed binary resources and immutable sources', () => {
  const supplement = JSON.parse(readFileSync(new URL('../legal/pdfjs-resource-notices.json', import.meta.url)));
  const data = JSON.parse(readFileSync(new URL('../../src/assets/legal/third-party-notices.json', import.meta.url)));
  const entry = data.entries.find(e => e.name === 'pdfjs-dist');
  assert.equal(entry.version, supplement.packageVersion);
  assert.equal(supplement.resources.length, 10);
  for (const resource of supplement.resources) {
    assert.deepEqual(entry.resources.find(r => r.name === resource.name), resource);
  }
  for (const file of supplement.files) {
    assert.match(file.source, /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[a-f0-9]{40}\//);
    assert.deepEqual(entry.files.find(f => f.name === file.name), file);
  }
  assert.match(entry.files.find(f => f.name === 'QuickJS/LICENSE').text, /Fabrice Bellard[\s\S]*Charlie Gordon/);
  assert.match(entry.files.find(f => f.name === 'pdf.js.qcms/src/lib.rs (original license header)').text, /Copyright \(c\) 2005 Mozilla Foundation/);
  assert.match(entry.files.find(f => f.name === 'PDF.js/external/standard_fonts/README.md').text, /1\.07\.4/);
});
