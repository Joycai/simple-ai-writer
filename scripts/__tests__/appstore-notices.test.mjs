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
