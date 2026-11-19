import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function releasePlan(args, source, root) {
  let target = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  let check = false;
  let seenTarget = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") check = true;
    else if (args[i] === "--target" && !seenTarget && args[i + 1]) {
      target = args[++i]; seenTarget = true;
    } else throw new Error("Use --check or --target aarch64-apple-darwin|x86_64-apple-darwin|universal-apple-darwin.");
  }
  if (!["aarch64-apple-darwin", "x86_64-apple-darwin", "universal-apple-darwin"].includes(target)) {
    throw new Error("Unsupported macOS release target.");
  }
  const env = { ...source };
  // Pin the direct-distribution channel and keep artifacts separate from store/dev builds.
  delete env.TAURI_CONFIG;
  delete env.APPLE_ID;
  delete env.APPLE_PASSWORD;
  env.APPLE_SIGNING_IDENTITY ||= "Developer ID Application: Cai Zhengxu (H9WK585493)";
  env.APPLE_API_ISSUER ||= "741a74c0-9e25-4bda-9c86-82e72a54d901";
  env.APPLE_API_KEY ||= "N6CR8R98T2";
  env.APPLE_API_KEY_PATH = resolve(env.APPLE_API_KEY_PATH || join(homedir(), ".appstoreconnect", "private_keys", `AuthKey_${env.APPLE_API_KEY}.p8`));
  if (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(env.APPLE_SIGNING_IDENTITY)) {
    throw new Error("APPLE_SIGNING_IDENTITY must name a Developer ID Application certificate.");
  }
  if (Boolean(env.APPLE_CERTIFICATE) !== Boolean(env.APPLE_CERTIFICATE_PASSWORD)) {
    throw new Error("APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD must be supplied together.");
  }
  env.CARGO_TARGET_DIR = join(root, "src-tauri", "target", "developer-id");
  const bundle = join(env.CARGO_TARGET_DIR, target, "release", "bundle");
  const config = { build: { features: [] }, bundle: { macOS: { signingIdentity: env.APPLE_SIGNING_IDENTITY, hardenedRuntime: true } } };
  return {
    check, target, env, bundle,
    team: env.APPLE_SIGNING_IDENTITY.match(/\(([A-Z0-9]{10})\)$/)[1],
    buildArgs: ["tauri", "build", "--target", target, "--bundles", "app,dmg", "--config", JSON.stringify(config)],
    auth: ["--key", env.APPLE_API_KEY_PATH, "--key-id", env.APPLE_API_KEY, "--issuer", env.APPLE_API_ISSUER],
  };
}

export function verifyReleaseIdentity(details, identity, team, identifier) {
  const lines = details.split(/\r?\n/);
  if (!lines.includes(`Authority=${identity}`) || !lines.includes(`TeamIdentifier=${team}`)
      || !lines.includes(`Identifier=${identifier}`) || !/flags=.*\bruntime\b/.test(details)) {
    throw new Error("App must have the expected Developer ID identity, team, bundle identifier and hardened runtime.");
  }
}
