/** Capture reviewed crate license files from the locked local Cargo registry. No network. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.slice(2).some(x => x !== '--check')) throw new Error('Use --check or no arguments');
const names = ['tauri', 'tauri-runtime', 'tauri-runtime-wry', 'tauri-utils', 'tokio', 'reqwest', 'keyring', 'tauri-plugin-dialog', 'tauri-plugin-fs', 'tauri-plugin-notification', 'tauri-plugin-opener', 'tauri-plugin-sql'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--offline', '--filter-platform', 'aarch64-apple-darwin', '--features', 'app-store', '--format-version', '1'], { cwd: join(root, 'src-tauri'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const entries = metadata.packages.filter(p => names.includes(p.name)).map(p => {
  if (!['MIT', 'MIT OR Apache-2.0', 'Apache-2.0 OR MIT'].includes(p.license)) throw new Error(`Review changed license: ${p.name}`);
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
  if (!files.some(f => f.text.includes('Permission is hereby granted') && f.text.includes('Copyright'))) throw new Error(`Full MIT notice missing: ${p.name}`);
  return { name: p.name, version: p.version, license: 'MIT', declaredLicense: p.license, source: `https://crates.io/crates/${p.name}/${p.version}`, registrySource: p.source, crateChecksum: checksum, files };
});
for (const name of names) if (!entries.some(e => e.name === name)) throw new Error(`Missing ${name}`);
entries.sort((a,b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
const output = JSON.stringify({ scope: 'Selected Rust crate original notices, including indirect/build dependencies. Not a complete binary inventory.', entries }, null, 2) + '\n';
const target = join(root, 'scripts/legal/rust-notices.json');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('Rust notice sources changed; review before regenerating.');
} else writeFileSync(target, output);
console.log(`Verified ${entries.length} Rust source notices.`);
