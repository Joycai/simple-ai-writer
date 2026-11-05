/** Read-only audit of a packaged app. Static checks never imply native acceptance. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
let app = join(root, "src-tauri/target/app-store/aarch64-apple-darwin/release/bundle/macos/Simple AI Writer Store.app");
let output;
let expectedBuild;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--app" && args[i + 1]) app = resolve(args[++i]);
  else if (args[i] === "--build-number" && args[i + 1]) expectedBuild = args[++i];
  else if (args[i] === "--output" && args[i + 1]) output = resolve(args[++i]);
  else throw new Error("Usage: node scripts/audit-appstore.mjs [--app path.app] [--output report.json] [--build-number N]");
}
if (process.platform !== "darwin") throw new Error("Run the bundle audit on macOS.");
const run = (bin, argv, input) => execFileSync(bin, argv, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).trim();
const plist = (path) => JSON.parse(run("plutil", ["-convert", "json", "-o", "-", path]));
const checks = [];
const check = (name, fn) => {
  try { const detail = fn(); checks.push({ name, passed: true, detail }); }
  catch (error) { checks.push({ name, passed: false, detail: String(error.message) }); }
};
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.appstore.conf.json")));
expectedBuild ??= config.bundle.macOS.bundleVersion;
if (!/^[1-9]\d{0,3}$/.test(expectedBuild)) throw new Error("Invalid expected build number");
const version = JSON.parse(readFileSync(join(root, "package.json"))).version;
let info, binary;
check("bundle-identity", () => {
  info = plist(join(app, "Contents/Info.plist"));
  requireValue(info.CFBundleIdentifier === config.identifier, "Bundle ID mismatch");
  requireValue(info.CFBundleShortVersionString === version, "Bundle version mismatch");
  requireValue(info.CFBundleVersion === expectedBuild, "Build number mismatch");
  requireValue(info.LSMinimumSystemVersion === config.bundle.macOS.minimumSystemVersion, "Minimum macOS mismatch");
  requireValue(info.LSApplicationCategoryType === "public.app-category.productivity", "Category mismatch");
  requireValue(typeof info.NSLocalNetworkUsageDescription === "string" && info.NSLocalNetworkUsageDescription.trim(), "Local network disclosure missing");
  requireValue(info.CFBundleExecutable === "simple-ai-writer", "Unexpected executable name");
  binary = join(app, "Contents/MacOS", info.CFBundleExecutable);
  return { id: info.CFBundleIdentifier, version, buildNumber: info.CFBundleVersion, minimumMacOS: info.LSMinimumSystemVersion };
});
check("signature-integrity", () => run("codesign", ["--verify", "--deep", "--strict", app]) || "verified");
check("sandbox-entitlements", () => {
  const xml = run("codesign", ["-d", "--entitlements", ":-", app]);
  const entitlements = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", "-"], xml));
  const expected = plist(join(root, "src-tauri/Entitlements.appstore.plist"));
  for (const [key, value] of Object.entries(expected)) requireValue(entitlements[key] === value, `Missing/mismatched entitlement: ${key}`);
  const signingKeys = ["com.apple.application-identifier", "com.apple.developer.team-identifier"];
  const unexpected = Object.keys(entitlements).filter(key => !(key in expected) && !signingKeys.includes(key));
  requireValue(unexpected.length === 0, `Unexpected entitlements: ${unexpected.join(", ")}`);
  return entitlements;
});
check("architecture-and-deployment-target", () => {
  requireValue(!!binary, "Identity check failed");
  const arch = run("lipo", ["-archs", binary]);
  requireValue(arch === "arm64", `Expected arm64 only, got ${arch}`);
  const load = run("otool", ["-l", binary]);
  const minimum = load.match(/\bminos\s+(\S+)/)?.[1] ?? load.match(/LC_VERSION_MIN_MACOSX[\s\S]*?\bversion\s+(\S+)/)?.[1];
  requireValue(minimum === config.bundle.macOS.minimumSystemVersion, `Mach-O minOS ${minimum} differs from configured minimum`);
  return { arch, minimum, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex") };
});
check("linked-libraries", () => {
  requireValue(!!binary, "Identity check failed");
  const libraries = run("otool", ["-L", binary]).split("\n").slice(1).map(line => line.trim().split(" (compatibility")[0]);
  const external = libraries.filter(path => !path.startsWith("/System/Library/") && !path.startsWith("/usr/lib/"));
  requireValue(external.length === 0, `Review non-system libraries: ${external.join(", ")}`);
  return libraries;
});
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Review bundle symlink: ${relative(app, path)}`);
    if (stat.isDirectory()) walk(path); else files.push(relative(app, path));
  }
};
check("bundle-resources", () => {
  walk(app);
  requireValue(files.some(path => path.endsWith(".icns")), "App icon missing");
  const forbidden = files.filter(path => /(?:^|\/)(?:node_modules|\.git|\.env)(?:\/|$)|\.(?:p8|p12|pfx|key)$/.test(path));
  requireValue(!forbidden.length, `Unexpected private/development resources: ${forbidden.join(", ")}`);
  return { files, privacyManifests: files.filter(path => path.endsWith("PrivacyInfo.xcprivacy")) };
});
const details = spawnSync("codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
const signing = details.stderr ?? "";
const report = {
  generatedAt: new Date().toISOString(), app, localStaticChecksPassed: checks.every(c => c.passed),
  checks, signing: { adHoc: /Signature=adhoc/.test(signing), teamPresent: /TeamIdentifier=(?!not set)/.test(signing),
    provisioningProfilePresent: existsSync(join(app, "Contents/embedded.provisionprofile")) },
  submissionReady: false,
  pending: ["P1 native file/bookmark/restart acceptance", "P2 native consent/cancellation and public policy publication",
    "P3 native feature/failure/OS matrix", "Privacy collection manifest and SDK review", "P4 metadata, screenshots, review service and license notices", "Distribution certificate/profile validation (P4)"],
};
const json = JSON.stringify(report, null, 2) + "\n";
if (output) writeFileSync(output, json); else process.stdout.write(json);
process.exitCode = report.localStaticChecksPassed ? 0 : 1;
