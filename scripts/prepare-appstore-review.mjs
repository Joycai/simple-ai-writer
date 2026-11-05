import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_FILES, sha256, verifyReview } from "./lib/appstore-review.mjs";
import { parseStoreBuildArgs } from "./lib/appstore-build.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const mode = args.shift();
if (!["create", "verify"].includes(mode)) throw new Error("Use create --output-dir NEW --build-number N or verify --dir DIR [--strict]");
let directory, buildNumber, strict = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === (mode === "create" ? "--output-dir" : "--dir") && !directory && args[i + 1]) directory = resolve(args[++i]);
  else if (mode === "create" && args[i] === "--build-number" && !buildNumber && args[i + 1]) buildNumber = parseStoreBuildArgs(["--build-number", args[++i]]).buildNumber;
  else if (mode === "verify" && args[i] === "--strict" && !strict) strict = true;
  else throw new Error("Invalid or duplicate argument");
}
if (!directory || (mode === "create" && !buildNumber)) throw new Error("Directory and explicit build number are required for creation");
const command = (bin, argv) => execFileSync(bin, argv, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
if (mode === "create") {
  const bundle = JSON.parse(command(process.execPath, ["scripts/audit-appstore.mjs", "--build-number", buildNumber]));
  const metadata = JSON.parse(command(process.execPath, ["scripts/check-appstore-metadata.mjs"]));
  const plan = JSON.parse(readFileSync(join(root, "docs/feature/app-store/test-plan.json")));
  plan.cases = plan.cases.map(c => ({ ...c, status: "pending" }));
  const source = { commit: command("git", ["rev-parse", "HEAD"]).trim(),
    dirty: !!command("git", ["status", "--porcelain"]).trim(),
    note: "Source observed at preparation time, not proof this commit produced the binary.",
    hashes: Object.fromEntries(["package.json", "pnpm-lock.yaml", "src-tauri/Cargo.lock", "src-tauri/tauri.appstore.conf.json", "docs/feature/app-store/metadata.json"].map(p => [p, sha256(readFileSync(join(root, p)))])) };
  const identity = bundle.checks.find(c => c.name === "bundle-identity").detail;
  const binary = bundle.checks.find(c => c.name === "architecture-and-deployment-target").detail;
  const files = Object.fromEntries(Object.entries({ "bundle.json": bundle, "metadata.json": metadata, "source.json": source, "test-plan.json": plan }).map(([name, value]) => [name, JSON.stringify(value, null, 2) + "\n"]));
  const manifest = { schemaVersion: 1, kind: "appstore-local-review", generatedAt: new Date().toISOString(), submissionReady: false,
    candidate: { bundleId: identity.id, version: identity.version, buildNumber: identity.buildNumber, binarySha256: binary.sha256 },
    files: Object.fromEntries(REVIEW_FILES.map(name => [name, sha256(files[name])])) };
  const result = verifyReview(manifest, files);
  if (!result.integrityPassed) throw new Error(result.errors.join("\n"));
  mkdirSync(directory); // Must be new; never overwrite previous evidence.
  for (const name of REVIEW_FILES) writeFileSync(join(directory, name), files[name], { flag: "wx" });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
}
const readRegular = name => {
  const path = join(directory, name);
  if (!lstatSync(path).isFile()) throw new Error(`Not a regular evidence file: ${name}`);
  return readFileSync(path, "utf8");
};
const result = verifyReview(JSON.parse(readRegular("manifest.json")), Object.fromEntries(REVIEW_FILES.map(name => [name, readRegular(name)])));
console.log(JSON.stringify(result, null, 2));
process.exitCode = !result.integrityPassed || strict ? 1 : 0;
