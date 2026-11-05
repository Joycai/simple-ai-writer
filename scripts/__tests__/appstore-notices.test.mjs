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

test('all direct frontend dependencies have notices without unresolved exceptions', () => {
  const data = JSON.parse(readFileSync(new URL('../../src/assets/legal/third-party-notices.json', import.meta.url)));
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
  for (const name of Object.keys(pkg.dependencies)) {
    assert.ok(data.entries.some(e => e.name === name && e.source?.startsWith('https://www.npmjs.com/')), name);
  }
});

test('six JS plugins retain full version-pinned source licenses and package evidence', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../legal/tauri-js-notices.json', import.meta.url)));
  const data = JSON.parse(readFileSync(new URL('../../src/assets/legal/third-party-notices.json', import.meta.url)));
  assert.equal(snapshot.entries.length, 6);
  for (const plugin of snapshot.entries) {
    const entry = data.entries.find(e => e.name === plugin.name);
    assert.equal(entry.version, plugin.version);
    assert.equal(entry.license, 'MIT');
    assert.ok(entry.files.find(f => f.name === 'LICENSE_MIT').text.includes('Copyright'));
    assert.ok(entry.files.find(f => f.name === 'LICENSE_APACHE-2.0').text.includes('END OF TERMS AND CONDITIONS'));
    for (const file of [...plugin.files, ...plugin.evidence]) {
      assert.ok(file.source.includes(`/blob/${plugin.commit}/`));
      assert.equal(createHash('sha256').update(file.text).digest('hex'), file.sha256);
    }
    for (const file of plugin.evidence) {
      const local = readFileSync(new URL(`../../node_modules/${plugin.name}/${file.name}`, import.meta.url), 'utf8');
      if (file.name === 'package.json') assert.deepEqual(JSON.parse(local), JSON.parse(file.text));
      else assert.equal(local, file.text);
    }
  }
});

test('KaTeX fonts preserve their embedded OFL copyright and reserved names', () => {
  const data = JSON.parse(readFileSync(new URL('../../src/assets/legal/third-party-notices.json', import.meta.url)));
  const entry = data.entries.find(e => e.name === 'katex' && e.version === '0.18.10');
  const indirect = data.entries.find(e => e.name === 'katex' && e.version === '0.16.47');
  assert.deepEqual(indirect.resources, entry.resources);
  assert.deepEqual(indirect.files.slice(1), entry.files.slice(1));
  assert.equal(entry.license, 'MIT (code) + OFL-1.1 (fonts)');
  assert.equal(entry.resources.length, 60);
  let ttfCount = 0;
  for (const resource of entry.resources) {
    const bytes = readFileSync(new URL(`../../node_modules/katex/${resource.name}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), resource.sha256);
    if (!resource.name.endsWith('.ttf')) continue;
    ttfCount++;
    const records = [];
    for (let i = 0; i < bytes.readUInt16BE(4); i++) {
      const row = 12 + i * 16;
      if (bytes.toString('ascii', row, row + 4) !== 'name') continue;
      const offset = bytes.readUInt32BE(row + 8);
      const strings = offset + bytes.readUInt16BE(offset + 4);
      for (let j = 0; j < bytes.readUInt16BE(offset + 2); j++) {
        const pos = offset + 6 + j * 12;
        const platform = bytes.readUInt16BE(pos), id = bytes.readUInt16BE(pos + 6);
        if (![0, 13, 14].includes(id)) continue;
        const start = strings + bytes.readUInt16BE(pos + 10), length = bytes.readUInt16BE(pos + 8);
        const text = new TextDecoder([0, 3].includes(platform) ? 'utf-16be' : 'macintosh').decode(bytes.subarray(start, start + length));
        const record = `name ID ${id}\n${text}`;
        if (!records.includes(record)) records.push(record);
      }
    }
    const notice = entry.files.find(f => f.name === `${resource.name} (embedded name IDs 0, 13, 14)`);
    assert.equal(notice?.text, records.join('\n\n') + '\n');
    assert.match(notice.text, /Reserved Font Name KaTeX_/);
    assert.match(notice.text, /Design Science, Inc\./);
    assert.match(notice.text, /Khan Academy/);
  }
  assert.equal(ttfCount, 20);
  assert.ok(entry.files.some(f => f.text.includes('SIL OPEN FONT LICENSE Version 1.1') && f.text.includes('TERMINATION') && f.text.includes('DISCLAIMER')));
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
