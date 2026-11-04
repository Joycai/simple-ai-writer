// A separate target directory prevents a store bundle from reusing a direct
// binary (or overwriting the direct release artifacts). No credentials on disk.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("Mac App Store bundles must be built on macOS.");
  process.exit(1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync("pnpm", ["tauri", "build", "--config", "src-tauri/tauri.appstore.conf.json", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, CARGO_TARGET_DIR: fileURLToPath(new URL("../src-tauri/target/app-store", import.meta.url)) },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
