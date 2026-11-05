/** Collect a deliberately limited, reviewed set. This is not a release approval. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.slice(2).some(x => x !== '--check')) throw new Error('Use --check or no arguments');
const check = process.argv.includes('--check');
const digest = text => createHash('sha256').update(text).digest('hex');
const selected = new Set(['react', 'react-dom', 'react-i18next', 'i18next', 'zustand', 'lucide-react', 'katex', 'markdown-it', 'docx', 'pptxgenjs', 'mammoth', 'jszip', '@tauri-apps/api']);
const wanted = name => selected.has(name) || name.startsWith('@codemirror/') || name.startsWith('@fontsource/');
const choices = { 'Apache-2.0 OR MIT': 'MIT', '(MIT OR GPL-3.0-or-later)': 'MIT' };
const markers = { MIT: 'Permission is hereby granted', ISC: 'Permission to use, copy, modify', 'OFL-1.1': 'SIL OPEN FONT LICENSE', 'BSD-2-Clause': 'Redistribution and use in source and binary forms' };
const groups = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const entries = [];
const seen = new Set();
for (const group of Object.values(groups)) for (const item of group) for (const path of item.paths) {
  const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  if (!wanted(pkg.name)) continue;
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const license = choices[pkg.license] ?? pkg.license;
  if (!markers[license]) throw new Error(`Unreviewed license for ${key}: ${pkg.license}`);
  const files = readdirSync(path, { withFileTypes: true }).filter(e => e.isFile() && /^(license|copying|notice|ofl)([._-]|$)/i.test(e.name)).map(e => e.name).sort().map(name => {
    const text = readFileSync(join(path, name), 'utf8');
    return { name, sha256: digest(text), text };
  });
  if (!files.some(f => f.text.includes(markers[license]))) throw new Error(`Full license text missing: ${key}`);
  entries.push({ name: pkg.name, version: pkg.version, license, declaredLicense: pkg.license, source: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`, files });
}
for (const name of [...selected, '@fontsource/spectral', '@fontsource/inter-tight', '@fontsource/jetbrains-mono']) {
  if (!entries.some(e => e.name === name)) throw new Error(`Required notice missing: ${name}`);
}
entries.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
const output = JSON.stringify({ scope: 'Partial npm notice collection; includes indirect dependencies. Not a complete distribution clearance.', pnpmLockSha256: digest(readFileSync(resolve(root, 'pnpm-lock.yaml'))), entries }, null, 2) + '\n';
const target = resolve(root, 'src/assets/legal/third-party-notices.json');
if (check) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('Notices are stale or altered. Regenerate and review the diff.');
} else writeFileSync(target, output);
console.log(`${check ? 'Verified' : 'Collected'} ${entries.length} notices, preserving original license text and hashes.`);
