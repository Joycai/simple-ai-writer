// A separate target directory prevents a store bundle from reusing a direct
// binary (or overwriting the direct release artifacts). No credentials on disk.
import { readFileSync } from "node:fs";
import { parseStoreBuildArgs, storeBuildConfig } from "./lib/appstore-build.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("Mac App Store bundles must be built on macOS.");
  process.exit(1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.appstore.conf.json", import.meta.url)));
let parsed;
try { parsed = parseStoreBuildArgs(process.argv.slice(2), config.bundle.macOS.bundleVersion); }
catch (error) { console.error(error.message); process.exit(1); }
const { buildNumber, flags } = parsed;
console.log(`Store CFBundleVersion: ${buildNumber} (local default is not an upload reservation)`);
const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: "14.0", CARGO_TARGET_DIR: fileURLToPath(new URL("../src-tauri/target/app-store", import.meta.url)) };
delete env.TAURI_CONFIG;
const result = spawnSync("pnpm", ["tauri", "build", "--config", JSON.stringify(storeBuildConfig(config, buildNumber)), "--target", "aarch64-apple-darwin", ...flags], {
  cwd: root,
  stdio: "inherit",
  env,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
