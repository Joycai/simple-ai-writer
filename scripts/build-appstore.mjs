// A separate target directory prevents a store bundle from reusing a direct
// binary (or overwriting the direct release artifacts). No credentials on disk.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("Mac App Store bundles must be built on macOS.");
  process.exit(1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const extra = process.argv.slice(2);
if (extra.some(arg => !["--verbose", "-v", "--ci"].includes(arg))) {
  console.error("Store target/config/features are frozen by this build entry point.");
  process.exit(1);
}
const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: "14.0", CARGO_TARGET_DIR: fileURLToPath(new URL("../src-tauri/target/app-store", import.meta.url)) };
delete env.TAURI_CONFIG;
const result = spawnSync("pnpm", ["tauri", "build", "--config", "src-tauri/tauri.appstore.conf.json", "--target", "aarch64-apple-darwin", ...extra], {
  cwd: root,
  stdio: "inherit",
  env,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
