// Official direct-distribution entry point. Tauri signs/notarizes the app, then
// we notarize and staple the outer DMG too. Never publish a merely signed image.
import { accessSync, constants, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { releasePlan, verifyReleaseIdentity } from "./lib/macos-release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function run(command, args, env, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr || result.stdout || "");
    throw new Error(`${command} ${args[0]} failed (exit ${result.status}).`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

try {
  if (process.platform !== "darwin") throw new Error("Developer ID releases must be built on macOS.");
  const plan = releasePlan(process.argv.slice(2), process.env, root);
  const { env, auth } = plan;
  accessSync(env.APPLE_API_KEY_PATH, constants.R_OK);
  if (!env.APPLE_CERTIFICATE) {
    const identities = run("security", ["find-identity", "-v", "-p", "codesigning"], env, true);
    if (!identities.includes(`"${env.APPLE_SIGNING_IDENTITY}"`)) throw new Error("Developer ID certificate and private key not found in the unlocked keychain.");
  }
  // Read-only authentication check before spending time compiling.
  run("xcrun", ["notarytool", "history", ...auth, "--output-format", "json"], env, true);
  console.log(`Developer ID / notarization preflight passed (${plan.target}).`);
  if (!plan.check) {
    // Only this entry point's bundles; never retain a previous successful DMG.
    rmSync(plan.bundle, { recursive: true, force: true });
    run("pnpm", plan.buildArgs, env);
    const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
    const app = join(plan.bundle, "macos", `${config.productName}.app`);
    run("codesign", ["--verify", "--deep", "--strict", app], env);
    verifyReleaseIdentity(run("codesign", ["-dvvv", app], env, true), env.APPLE_SIGNING_IDENTITY, plan.team, config.identifier);
    run("xcrun", ["stapler", "validate", app], env);
    run("spctl", ["--assess", "--type", "execute", "--verbose=2", app], env);
    const images = readdirSync(join(plan.bundle, "dmg")).filter(name => name.endsWith(".dmg"));
    if (images.length !== 1) throw new Error("Expected exactly one fresh DMG.");
    const dmg = join(plan.bundle, "dmg", images[0]);
    run("codesign", ["--verify", "--strict", dmg], env);
    const submission = JSON.parse(run("xcrun", ["notarytool", "submit", dmg, ...auth, "--wait", "--output-format", "json"], env, true));
    if (submission.status !== "Accepted") throw new Error(`DMG notarization ${submission.status}; submission ID: ${submission.id}. Retrieve its notarytool log before retrying.`);
    run("xcrun", ["stapler", "staple", dmg], env);
    run("xcrun", ["stapler", "validate", dmg], env);
    run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg], env);
    console.log(`Verified signed and notarized DMG: ${dmg}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
