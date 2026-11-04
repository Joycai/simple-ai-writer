/** Store-only build policy. No shell interpolation or mutation of version manifests. */
export function parseStoreBuildArgs(args, defaultBuild = "1") {
  let buildNumber = defaultBuild;
  let seen = false;
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--build-number" && !seen && args[i + 1]) {
      buildNumber = args[++i]; seen = true;
    } else if (["--verbose", "-v", "--ci"].includes(args[i])) flags.push(args[i]);
    else throw new Error("Use --build-number 1..9999, --verbose or --ci; store target/config/features are frozen.");
  }
  if (!/^[1-9]\d{0,3}$/.test(buildNumber)) throw new Error("Build number must be an integer from 1 to 9999 without leading zeros.");
  return { buildNumber, flags };
}

export function storeBuildConfig(config, buildNumber) {
  return { ...config, bundle: { ...config.bundle, macOS: { ...config.bundle.macOS, bundleVersion: buildNumber } } };
}
