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
