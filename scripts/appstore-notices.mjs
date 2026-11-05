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
const tauriJs = JSON.parse(readFileSync(join(root, 'scripts/legal/tauri-js-notices.json'), 'utf8')).entries;
const selected = new Set(['react', 'react-dom', 'react-i18next', 'i18next', 'zustand', 'lucide-react', 'katex', 'markdown-it', 'docx', 'pptxgenjs', 'mammoth', 'jszip', '@tauri-apps/api', '@joplin/turndown-plugin-gfm', '@lezer/highlight', '@vscode/markdown-it-katex', 'codemirror', 'gray-matter', 'mermaid', 'motion', 'nanoid', 'turndown', 'pdfjs-dist']);
const wanted = name => selected.has(name) || name.startsWith('@codemirror/') || name.startsWith('@fontsource/');
for (const entry of tauriJs) selected.add(entry.name);
const choices = { 'Apache-2.0 OR MIT': 'MIT', 'MIT OR Apache-2.0': 'MIT', '(MIT OR GPL-3.0-or-later)': 'MIT' };
const markers = { 'Apache-2.0': 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION', MIT: 'Permission is hereby granted', ISC: 'Permission to use, copy, modify', 'OFL-1.1': 'SIL OPEN FONT LICENSE', 'BSD-2-Clause': 'Redistribution and use in source and binary forms' };
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
  const plugin = tauriJs.find(e => e.name === pkg.name);
  if (plugin) {
    if (plugin.version !== pkg.version) throw new Error(`Review JS plugin version: ${key}`);
    const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
    if (walk(path).length !== plugin.packageFiles.length) throw new Error(`Review JS plugin file set: ${key}`);
    for (const file of plugin.packageFiles) {
      if (digest(readFileSync(join(path, file.name))) !== file.sha256) throw new Error(`Review JS plugin bytes: ${key}/${file.name}`);
    }
    for (const file of plugin.files) {
      if (digest(file.text) !== file.sha256) throw new Error(`Invalid JS plugin source notice: ${key}/${file.name}`);
      files.push(file);
    }
  }
  if (!files.some(f => f.text.includes(markers[license]))) throw new Error(`Full license text missing: ${key}`);
  let resources;
  let displayLicense = license;
  if (pkg.name === 'katex') {
    const fonts = JSON.parse(readFileSync(join(root, 'scripts/legal/katex-font-notices.json'), 'utf8'));
    if (!fonts.packageVersions.includes(pkg.version)) throw new Error('Review KaTeX font version');
    resources = readdirSync(join(path, 'dist/fonts')).sort().map(name => ({ name: `dist/fonts/${name}`, sha256: digest(readFileSync(join(path, 'dist/fonts', name))) }));
    if (JSON.stringify(resources) !== JSON.stringify(fonts.resources)) throw new Error('Review KaTeX font bytes or file set');
    for (const file of fonts.files) {
      if (digest(file.text) !== file.sha256) throw new Error(`Invalid KaTeX font notice: ${file.name}`);
      files.push(file);
    }
    displayLicense = 'MIT (code) + OFL-1.1 (fonts)';
  }
  if (pkg.name === 'pdfjs-dist') {
    displayLicense = 'Apache-2.0 + bundled resource licenses (see files)';
    // Preserve mixed resource terms verbatim; collection is not clearance.
    const expected = ['cmaps/LICENSE', 'standard_fonts/LICENSE_FOXIT', 'standard_fonts/LICENSE_LIBERATION',
      'wasm/LICENSE_JBIG2', 'wasm/LICENSE_OPENJPEG', 'wasm/LICENSE_PDFJS_JBIG2',
      'wasm/LICENSE_PDFJS_OPENJPEG', 'wasm/LICENSE_PDFJS_QCMS', 'wasm/LICENSE_QCMS'].sort();
    const resourceNames = ['cmaps', 'standard_fonts', 'wasm'].flatMap(dir =>
      readdirSync(join(path, dir), { withFileTypes: true }).map(e => {
        if (!e.isFile()) throw new Error(`Review new PDF resource directory: ${dir}/${e.name}`);
        return `${dir}/${e.name}`;
      })).sort();
    const notices = resourceNames.filter(name => /\/(license|notice|copying)([._-]|$)/i.test(name));
    if (JSON.stringify(notices) !== JSON.stringify(expected)) throw new Error('Review PDF resource notice set');
    for (const name of notices) {
      const text = readFileSync(join(path, name), 'utf8');
      files.push({ name, sha256: digest(text), text });
    }
    // The distributed JavaScript carries attribution absent from the generic Apache template.
    const code = readFileSync(join(path, 'build/pdf.mjs'), 'utf8');
    const header = code.match(/^\/\*\*[\s\S]*?@licend[\s\S]*?\*\//)?.[0];
    if (!header?.includes('Copyright 2024 Mozilla Foundation')) throw new Error('Review PDF.js attribution header');
    files.push({ name: 'build/pdf.mjs (original license header)', sha256: digest(header), text: header });
    resources = resourceNames.map(name => ({ name, sha256: digest(readFileSync(join(path, name))) }));
    // Source notices absent from npm's resource directories, pinned to reviewed bytes.
    const supplement = JSON.parse(readFileSync(join(root, 'scripts/legal/pdfjs-resource-notices.json'), 'utf8'));
    if (supplement.packageVersion !== pkg.version) throw new Error('Review PDF.js source notices for new version');
    for (const resource of supplement.resources) {
      if (!resources.some(r => r.name === resource.name && r.sha256 === resource.sha256)) {
        throw new Error(`Review PDF.js source binding: ${resource.name}`);
      }
    }
    for (const file of supplement.files) {
      if (!file.source.startsWith('https://github.com/') || digest(file.text) !== file.sha256) {
        throw new Error(`Invalid PDF.js source notice: ${file.name}`);
      }
      files.push(file);
    }
  }
  entries.push({ name: pkg.name, version: pkg.version, license: displayLicense, declaredLicense: pkg.license, ...(resources ? { resources } : {}), source: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`, files });
}
for (const name of [...selected, '@fontsource/spectral', '@fontsource/inter-tight', '@fontsource/jetbrains-mono']) {
  if (!entries.some(e => e.name === name)) throw new Error(`Required notice missing: ${name}`);
}
// A checked-in source snapshot keeps frontend CI independent of a local Cargo cache.
// Re-capture / verify original archives with appstore-rust-notices.mjs on a prepared host.
const rust = JSON.parse(readFileSync(join(root, 'scripts/legal/rust-notices.json'), 'utf8'));
const cargoLock = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8');
for (const entry of rust.entries) {
  const block = cargoLock.split('[[package]]').find(b => b.includes(`name = "${entry.name}"\nversion = "${entry.version}"`));
  if (entry.vendorPath) {
    if (entry.vendorPath !== 'src-tauri/vendor/tauri-plugin-http' || !block || /^source = /m.test(block)) throw new Error('Vendor source changed');
    const manifest = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
    if (!manifest.includes('tauri-plugin-http = { version = "=2.6.0", path = "vendor/tauri-plugin-http"')) throw new Error('Review vendor dependency binding');
    for (const file of entry.localFiles) {
      if (file.name.split('/').includes('..') || file.name.startsWith('/')) throw new Error('Invalid vendor evidence path');
      if (digest(readFileSync(join(root, entry.vendorPath, file.name))) !== file.sha256) throw new Error(`Vendor changed; review notices: ${file.name}`);
    }
    const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
    if (walk(join(root, entry.vendorPath)).length !== entry.localFiles.length) throw new Error('Vendor file set changed');
    for (const file of entry.files) if (!entry.localFiles.some(f => f.name === file.name && f.sha256 === file.sha256)) throw new Error('Vendor notice differs from source');
  } else if (!block?.includes(`checksum = "${entry.crateChecksum}"`) || !block.includes(`source = "${entry.registrySource}"`)) throw new Error(`Rust notice no longer matches lock: ${entry.name}`);
  for (const file of entry.files) if (digest(file.text) !== file.sha256) throw new Error(`Rust text hash mismatch: ${entry.name}/${file.name}`);
  entries.push(entry);
}
entries.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
const output = JSON.stringify({ scope: 'Partial npm and Rust notice collection; includes indirect dependencies. Not a complete distribution clearance.', pnpmLockSha256: digest(readFileSync(resolve(root, 'pnpm-lock.yaml'))), cargoLockSha256: digest(cargoLock), entries }, null, 2) + '\n';
const target = resolve(root, 'src/assets/legal/third-party-notices.json');
if (check) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('Notices are stale or altered. Regenerate and review the diff.');
} else writeFileSync(target, output);
console.log(`${check ? 'Verified' : 'Collected'} ${entries.length} notices, preserving original license text and hashes.`);
