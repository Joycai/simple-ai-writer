import test from "node:test";
import assert from "node:assert/strict";
import { parseStoreBuildArgs, storeBuildConfig } from "../lib/appstore-build.mjs";

test("explicit build iteration preserves marketing version and sandbox policy", () => {
  const config = { identifier: "store", build: { features: ["app-store"] }, bundle: { targets: ["app"], macOS: { entitlements: "sandbox.plist", bundleVersion: "1" } } };
  const { buildNumber, flags } = parseStoreBuildArgs(["--ci", "--build-number", "42"]);
  const result = storeBuildConfig(config, buildNumber);
  assert.equal(result.bundle.macOS.bundleVersion, "42");
  assert.equal(config.bundle.macOS.bundleVersion, "1");
  assert.equal(result.bundle.macOS.entitlements, "sandbox.plist");
  assert.deepEqual(result.build.features, ["app-store"]);
  assert.equal(result.version, undefined);
  assert.deepEqual(flags, ["--ci"]);
});
test("local default and allowed range", () => {
  assert.equal(parseStoreBuildArgs([]).buildNumber, "1");
  assert.equal(parseStoreBuildArgs(["--build-number", "9999"]).buildNumber, "9999");
});
test("invalid or injected parameters cannot override store policy", () => {
  for (const value of ["0", "01", "10000", "1.2", "-1", "$(id)", "1;id", " ", ""]) {
    assert.throws(() => parseStoreBuildArgs(["--build-number", value]));
  }
  for (const args of [["--target", "x86_64-apple-darwin"], ["--config", "evil.json"], ["--features", "x"], ["--build-number"], ["--build-number", "2", "--build-number", "3"]]) {
    assert.throws(() => parseStoreBuildArgs(args));
  }
});
