import test from "node:test";
import assert from "node:assert/strict";
import { releasePlan, verifyReleaseIdentity } from "../lib/macos-release.mjs";

test("official release cannot inherit store config, output path or alternate auth", () => {
  const source = { TAURI_CONFIG: "store.json", CARGO_TARGET_DIR: "/store", APPLE_ID: "old", APPLE_PASSWORD: "old", APPLE_API_KEY_PATH: "/outside/key.p8" };
  const plan = releasePlan(["--target", "universal-apple-darwin"], source, "/repo");
  assert.equal(plan.env.TAURI_CONFIG, undefined);
  assert.equal(plan.env.APPLE_ID, undefined);
  assert.equal(plan.env.APPLE_PASSWORD, undefined);
  assert.equal(plan.bundle, "/repo/src-tauri/target/developer-id/universal-apple-darwin/release/bundle");
  assert.equal(plan.env.APPLE_API_KEY_PATH, "/outside/key.p8");
  assert.equal(source.TAURI_CONFIG, "store.json");
  const config = JSON.parse(plan.buildArgs.at(-1));
  assert.deepEqual(config.build.features, []);
  assert.equal(config.bundle.macOS.hardenedRuntime, true);
});

test("override traps and incomplete CI signing material fail before compilation", () => {
  for (const args of [["--no-sign"], ["--skip-stapling"], ["--debug"], ["--config", "store"], ["--features", "app-store"], ["--target", "../../store"], ["--target"], ["--target", "aarch64-apple-darwin", "--target", "x86_64-apple-darwin"]]) {
    assert.throws(() => releasePlan(args, {}, "/repo"));
  }
  for (const identity of ["-", "Apple Distribution: Example (H9WK585493)"]) {
    assert.throws(() => releasePlan([], { APPLE_SIGNING_IDENTITY: identity }, "/repo"));
  }
  assert.throws(() => releasePlan([], { APPLE_CERTIFICATE: "base64" }, "/repo"));
  assert.throws(() => releasePlan([], { APPLE_CERTIFICATE_PASSWORD: "password" }, "/repo"));
  assert.equal(releasePlan(["--check"], {}, "/repo").check, true);
});

test("CI signing and API key overrides stay in environment, never build arguments", () => {
  const plan = releasePlan([], { APPLE_CERTIFICATE: "secret-p12", APPLE_CERTIFICATE_PASSWORD: "secret-password", APPLE_API_KEY: "OTHERKEY01", APPLE_API_ISSUER: "issuer" }, "/repo");
  assert.equal(plan.env.APPLE_CERTIFICATE, "secret-p12");
  assert.match(plan.env.APPLE_API_KEY_PATH, /AuthKey_OTHERKEY01\.p8$/);
  assert.ok(!JSON.stringify(plan.buildArgs).includes("secret-"));
});

test("integrity verification alone cannot pass a wrong team, ad-hoc or store signature", () => {
  const identity = "Developer ID Application: Example (H9WK585493)";
  const details = `Identifier=com.simple-ai-writer.app\nAuthority=${identity}\nTeamIdentifier=H9WK585493\nCodeDirectory v=20500 flags=0x10000(runtime) hashes=1`;
  assert.doesNotThrow(() => verifyReleaseIdentity(details, identity, "H9WK585493", "com.simple-ai-writer.app"));
  for (const bad of [details.replace(identity, "Apple Distribution: Example (H9WK585493)"), details.replace("TeamIdentifier=H9WK585493", "TeamIdentifier=OTHERTEAM1"), details.replace("(runtime)", "(adhoc)"), details.replace("Identifier=com.simple-ai-writer.app", "Identifier=com.simple-ai-writer.store")]) {
    assert.throws(() => verifyReleaseIdentity(bad, identity, "H9WK585493", "com.simple-ai-writer.app"));
  }
});
