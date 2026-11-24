/** Capture reviewed crate license files from the locked local Cargo registry. No network. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.slice(2).some(x => x !== '--check')) throw new Error('Use --check or no arguments');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--offline', '--filter-platform', 'aarch64-apple-darwin', '--features', 'app-store', '--format-version', '1'], { cwd: join(root, 'src-tauri'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const appNode = metadata.resolve.nodes.find(n => n.id === metadata.resolve.root);
const directIds = new Set(appNode.deps.filter(d => d.dep_kinds.some(k => k.kind === null)).map(d => d.pkg));
const direct = metadata.packages.filter(p => directIds.has(p.id));
const names = direct.filter(p => p.source).map(p => p.name);
const choices = { MIT: 'MIT', 'MIT OR Apache-2.0': 'MIT', 'Apache-2.0 OR MIT': 'MIT', 'Apache-2.0': 'Apache-2.0', '(Apache-2.0 OR MIT) AND BSD-3-Clause': 'MIT AND BSD-3-Clause', 'Zlib OR Apache-2.0 OR MIT': 'MIT' };
const entries = direct.filter(p => p.source).map(p => {
  if (!choices[p.license]) throw new Error(`Review changed license: ${p.name}`);
  const dir = dirname(p.manifest_path);
  const archive = join(dirname(dirname(dirname(dir))), 'cache', basename(dirname(dir)), `${p.name}-${p.version}.crate`);
  const checksum = digest(readFileSync(archive));
  const blocks = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8').split('[[package]]');
  if (!blocks.some(b => b.includes(`name = "${p.name}"\nversion = "${p.version}"`) && b.includes(`checksum = "${checksum}"`))) throw new Error(`Archive does not match lock: ${p.name}`);
  if (!checksum || !p.source?.startsWith('registry+')) throw new Error(`Registry evidence missing: ${p.name}`);
  const files = readdirSync(dir).filter(n => /^(license|notice)([._-]|$)/i.test(n)).sort().map(name => {
    const text = execFileSync('tar', ['-xOf', archive, `${p.name}-${p.version}/${name}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (text !== readFileSync(join(dir, name), 'utf8')) throw new Error(`Extracted source differs: ${p.name}/${name}`);
    return { name, sha256: digest(text), text };
  });
  if (p.name.startsWith('objc2')) {
    const vcs = JSON.parse(execFileSync('tar', ['-xOf', archive, `${p.name}-${p.version}/.cargo_vcs_info.json`], { encoding: 'utf8' }));
    const name = `objc2-${vcs.git.sha1}.md.txt`;
    const text = readFileSync(join(root, 'docs/feature/app-store/license-sources', name), 'utf8');
    files.push({ name: 'LICENSE.md (upstream license declaration)', source: `https://github.com/madsmtm/objc2/blob/${vcs.git.sha1}/LICENSE.md`, sha256: digest(text), text });
  } else if (!files.some(f => f.text.includes(p.license === 'Apache-2.0' ? 'Apache License' : 'Permission is hereby granted'))) throw new Error(`Full notice missing: ${p.name}`);
  if (p.name === 'encoding_rs' && !files.some(f => f.name === 'LICENSE-WHATWG')) throw new Error('Missing encoding_rs BSD notice');
  return { name: p.name, version: p.version, license: choices[p.license], declaredLicense: p.license, source: `https://crates.io/crates/${p.name}/${p.version}`, registrySource: p.source, crateChecksum: checksum, files };
});
for (const name of names) if (!entries.some(e => e.name === name)) throw new Error(`Missing ${name}`);
entries.sort((a,b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
const output = JSON.stringify({ scope: 'macOS app-store direct normal dependencies only; objc2 upstream declarations retained, original full MIT copyright text remains unconfirmed.', entries }, null, 2) + '\n';
const target = join(root, 'docs/feature/app-store/license-sources/rust-notices.json');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('Rust notice sources changed; review before regenerating.');
} else writeFileSync(target, output);
console.log(`Verified ${entries.length} Rust source notices.`);
