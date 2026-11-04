/** Offline inventory, not a legal approval or an assertion of shipped-code reachability. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output-dir") throw new Error("Use --output-dir <new-directory>");
const output = resolve(args[1]);
// Do not overwrite a reviewed notice set or include user workspace files.
mkdirSync(output, { recursive: false });
const run = (bin, argv, cwd = root) => JSON.parse(execFileSync(bin, argv, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
const npm = run("pnpm", ["licenses", "list", "--prod", "--json"]);
const cargo = run("cargo", ["metadata", "--locked", "--offline", "--filter-platform", "aarch64-apple-darwin", "--features", "app-store", "--format-version", "1"], join(root, "src-tauri"));
const notices = [];
function licenseFiles(dir, declared) {
  const candidates = readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && /^(licen[cs]e|copying|notice|ofl)([._-]|$)/i.test(e.name)).map(e => e.name);
  if (declared && !candidates.includes(declared) && existsSync(join(dir, declared))) candidates.push(declared);
  return candidates.sort().map(name => {
    const text = readFileSync(join(dir, name), "utf8");
    return { name, sha256: createHash("sha256").update(text).digest("hex"), text };
  });
}
function entry(ecosystem, name, version, license, location, declared) {
  const files = licenseFiles(location, declared);
  for (const file of files) notices.push(`\n===== ${ecosystem}: ${name}@${version} / ${file.name} =====\n${file.text}\n`);
  return { ecosystem, name, version, license: license || null, files: files.map(({ name, sha256 }) => ({ name, sha256 })),
    review: !license || !files.length ? "missing-license-or-text" : "unreviewed" };
}
const packages = [];
for (const group of Object.values(npm)) for (const item of group) for (const path of item.paths) {
  const manifest = JSON.parse(readFileSync(join(path, "package.json")));
  packages.push(entry("npm-production", manifest.name, manifest.version, item.license, path));
}
// Cargo metadata includes build/dev dependencies. Intentionally over-inclusive;
// reviewers must reconcile this with the shipped arm64 feature graph.
for (const pkg of cargo.packages) packages.push(entry("cargo-metadata", pkg.name, pkg.version, pkg.license, dirname(pkg.manifest_path), pkg.license_file));
packages.sort((a,b) => `${a.ecosystem}/${a.name}/${a.version}`.localeCompare(`${b.ecosystem}/${b.name}/${b.version}`));
const digest = path => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
const inventory = { version: JSON.parse(readFileSync(join(root, "package.json"))).version,
  scope: "npm production closure; cargo arm64 metadata including build/dev dependencies; not proof of final bundle contents",
  approvedForDistribution: false, lockHashes: { pnpm: digest("pnpm-lock.yaml"), cargo: digest("src-tauri/Cargo.lock") },
  packageCount: packages.length, missingLicenseOrText: packages.filter(p => p.review !== "unreviewed").length, packages };
writeFileSync(join(output, "inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
writeFileSync(join(output, "NOTICES.unreviewed.txt"), "UNREVIEWED — reconcile scope and obligations before distribution.\n" + notices.join(""));
console.log(JSON.stringify({ output, packages: inventory.packageCount, missingLicenseOrText: inventory.missingLicenseOrText, approvedForDistribution: false }));
