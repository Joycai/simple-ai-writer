#!/usr/bin/env node
/**
 * Bump the app version across every manifest that carries it.
 *
 * The version lives in four places that must agree, or the built app reports a
 * different version than the installer that delivered it:
 *   - package.json                 (frontend / pnpm)
 *   - src-tauri/tauri.conf.json    (what the bundled app actually reports)
 *   - src-tauri/Cargo.toml         ([package] section only)
 *   - src-tauri/Cargo.lock         (the simple-ai-writer entry)
 *
 * Two user-facing surfaces also show the version — the in-app "About" tab and the
 * README badges — but both read it DYNAMICALLY (About via getVersion() off the
 * bundle, README via a shields.io release badge), so they need no edit here. To
 * keep it that way, after bumping the manifests we SWEEP those surfaces for a
 * stray *hardcoded* copy of the old version and heal it, warning if one is found
 * (a hardcoded version there is a bug — it silently goes stale). Today the sweep
 * finds nothing, which is the point.
 *
 * Usage:
 *   node bump-version.mjs <patch|minor|major|X.Y.Z> [--dry-run] [--allow-drift]
 *                         [--repo-root <path>]
 *
 * Exits non-zero on drift (manifests disagree) so the caller notices rather than
 * silently picking a winner. Pass an explicit X.Y.Z with --allow-drift to
 * force every file onto one version and heal the drift.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CRATE_NAME = "simple-ai-writer";
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

// ── Locate the repo root ───────────────────────────────────────────────
// Default: walk up from this script (skill lives at .claude/skills/bump-version/scripts/).
function findRepoRoot(explicit) {
  if (explicit) return resolve(explicit);
  let dir = resolve(dirname(fileURLToPath(import.meta.url)));
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(dir, "package.json"), "utf8");
      readFileSync(join(dir, "src-tauri", "Cargo.toml"), "utf8");
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    "Could not locate the repo root (looked for package.json + src-tauri/Cargo.toml). " +
      "Pass --repo-root <path>."
  );
}

// ── Per-file read/write strategies ─────────────────────────────────────
// Each target reads to validate and writes via a targeted replacement, so the
// diff is one line rather than a whole-file reformat.

/** JSON files: parse to read, targeted replace to write, re-parse to verify. */
function jsonTarget(label, path) {
  return {
    label,
    path,
    read() {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed.version !== "string") {
        throw new Error(`${label}: no top-level "version" string`);
      }
      return parsed.version;
    },
    write(next) {
      const src = readFileSync(path, "utf8");
      // Only the first top-level "version" — dependency pins are never spelled
      // with a bare "version" key, so the first hit is the package's own.
      const re = /"version"(\s*):(\s*)"[^"]*"/;
      // Check the pattern matched, not that the text changed: when healing
      // drift a file may already sit at the target, and that is success.
      if (!re.test(src)) throw new Error(`${label}: version field not matched`);
      writeFileSync(path, src.replace(re, `"version"$1:$2"${next}"`));
      if (JSON.parse(readFileSync(path, "utf8")).version !== next) {
        throw new Error(`${label}: post-write verification failed`);
      }
    },
  };
}

/** Cargo.toml: scope strictly to the [package] section. */
function cargoTomlTarget(path) {
  const label = "src-tauri/Cargo.toml";
  // Capture the [package] section: from [package] up to the next [section].
  const sectionRe = /(\[package\][\s\S]*?)(?=\n\[|$)/;
  return {
    label,
    path,
    read() {
      const section = readFileSync(path, "utf8").match(sectionRe)?.[1];
      if (!section) throw new Error(`${label}: no [package] section`);
      const m = section.match(/^version\s*=\s*"([^"]*)"/m);
      if (!m) throw new Error(`${label}: no version in [package]`);
      return m[1];
    },
    write(next) {
      const src = readFileSync(path, "utf8");
      const section = src.match(sectionRe)?.[1];
      if (!section || !/^version\s*=\s*"[^"]*"/m.test(section)) {
        throw new Error(`${label}: version line not matched in [package]`);
      }
      writeFileSync(
        path,
        src.replace(sectionRe, (s) => s.replace(/^version\s*=\s*"[^"]*"/m, `version = "${next}"`))
      );
    },
  };
}

/** Cargo.lock: the version line belonging to our crate's [[package]] block. */
function cargoLockTarget(path) {
  const label = "src-tauri/Cargo.lock";
  // Tolerate CRLF: Cargo.lock is checked out with \r\n on Windows, so anchoring
  // to a bare \n between the name and version lines would never match there.
  const entryRe = new RegExp(`(name = "${CRATE_NAME}"\\r?\\nversion = ")([^"]*)(")`);
  return {
    label,
    path,
    read() {
      const m = readFileSync(path, "utf8").match(entryRe);
      if (!m) throw new Error(`${label}: no [[package]] entry for ${CRATE_NAME}`);
      return m[2];
    },
    write(next) {
      const src = readFileSync(path, "utf8");
      if (!entryRe.test(src)) throw new Error(`${label}: entry not matched`);
      writeFileSync(path, src.replace(entryRe, `$1${next}$3`));
    },
  };
}

function buildTargets(root) {
  return [
    jsonTarget("package.json", join(root, "package.json")),
    jsonTarget("src-tauri/tauri.conf.json", join(root, "src-tauri", "tauri.conf.json")),
    cargoTomlTarget(join(root, "src-tauri", "Cargo.toml")),
    cargoLockTarget(join(root, "src-tauri", "Cargo.lock")),
  ];
}

// ── Secondary surfaces: the About tab + README ─────────────────────────
// These show the version but read it dynamically, so they normally carry NO
// literal version. The sweep exists to catch the day someone hardcodes one:
// it rewrites any standalone occurrence of the old version to the new one and
// reports the hit so a human can look. Files are optional (a missing one is
// skipped, not an error) — the skill shouldn't break if the UI is refactored.
function secondarySurfaces(root) {
  return [
    { label: "README.md", path: join(root, "README.md") },
    { label: "src/i18n/locales/en.json", path: join(root, "src", "i18n", "locales", "en.json") },
    { label: "src/i18n/locales/zh-CN.json", path: join(root, "src", "i18n", "locales", "zh-CN.json") },
  ];
}

/**
 * Rewrite standalone occurrences of `current` to `next` in each secondary
 * surface. The version is matched as a whole token — not as a substring of a
 * longer number — so a `0.1.0` bump never mangles a `10.1.0` dependency pin or
 * a bare year. Returns per-file hit counts for reporting.
 */
function sweepSecondary(root, current, next, { dryRun }) {
  const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Reject only digit/dot neighbours, so `10.1.0` (longer number) and `0.1.00`
  // are left alone, while `v0.1.0`, `"0.1.0"`, and `version-0.1.0` still match —
  // a leading `v` is the common README/badge form and must be caught.
  const re = new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`, "g");
  const results = [];
  for (const { label, path } of secondarySurfaces(root)) {
    let src;
    try {
      src = readFileSync(path, "utf8");
    } catch {
      continue; // surface doesn't exist in this checkout — fine
    }
    const hits = src.match(re);
    const count = hits ? hits.length : 0;
    if (count > 0 && !dryRun) writeFileSync(path, src.replace(re, next));
    results.push({ label, count });
  }
  return results;
}

function bump(current, kind) {
  const m = current.match(SEMVER_RE);
  if (!m) {
    throw new Error(
      `Current version "${current}" is not semver (X.Y.Z), so "${kind}" is ambiguous. ` +
        `Pass an explicit version instead.`
    );
  }
  const [major, minor, patch] = m.slice(1).map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const allowDrift = argv.includes("--allow-drift");
  const rootIdx = argv.indexOf("--repo-root");
  const rootArg = rootIdx !== -1 ? argv[rootIdx + 1] : undefined;
  const spec = argv.find((a) => !a.startsWith("--") && a !== rootArg);

  if (!spec) {
    console.error(
      "Usage: node bump-version.mjs <patch|minor|major|X.Y.Z> [--dry-run] [--allow-drift] [--repo-root <path>]"
    );
    process.exit(2);
  }
  // Validate the bump spec before touching any file, so a typo reports itself
  // as a typo rather than surfacing as a confusing downstream error.
  if (!SEMVER_RE.test(spec) && !["patch", "minor", "major"].includes(spec)) {
    console.error(`Invalid bump "${spec}" — expected patch, minor, major, or X.Y.Z.`);
    process.exit(2);
  }

  const root = findRepoRoot(rootArg);
  const targets = buildTargets(root);
  const found = targets.map((t) => ({ target: t, version: t.read() }));

  // Drift check — the whole point of touching four files from one place.
  const distinct = [...new Set(found.map((f) => f.version))];
  if (distinct.length > 1) {
    console.error("Version drift — manifests disagree:\n");
    for (const { target, version } of found) {
      console.error(`  ${version.padEnd(12)} ${target.label}`);
    }
    // Deliberately not suggesting a value here. Nudging toward (say) the
    // highest would be a guess wearing a recommendation's clothes, and the
    // most common drift is a lone package.json edit — where the highest
    // number is precisely the wrong answer.
    console.error(
      `\nThe app currently ships as ${found[1].version} — src-tauri/tauri.conf.json is\n` +
        "what the bundle reports, so a version that appears only in another file\n" +
        "is more often a stray edit than the truth. Check the history of whichever\n" +
        "file disagrees (git log -- <file>) before deciding."
    );
    if (!allowDrift) {
      console.error(
        "\nRefusing to guess which is authoritative. Once you know, force all four\n" +
          "onto that value:\n  node bump-version.mjs <X.Y.Z> --allow-drift"
      );
      process.exit(1);
    }
    // A relative bump needs one unambiguous "current" to add to, and under
    // drift there isn't one. Computing from whichever manifest happens to be
    // first in the list would silently pick package.json — the least
    // authoritative of the four. Make the user state the target outright.
    if (!SEMVER_RE.test(spec)) {
      console.error(
        `\n"${spec}" needs a single current version to count from, and the manifests\n` +
          "disagree. Re-run with an explicit target, e.g. 0.2.0 --allow-drift"
      );
      process.exit(2);
    }
    console.error(`\n--allow-drift: forcing all manifests to ${spec}\n`);
  }

  // Safe: under drift we exited above unless spec is an explicit X.Y.Z, so
  // `current` is only ever used to compute a relative bump when all four agree.
  const current = found[0].version;
  const next = SEMVER_RE.test(spec) ? spec : bump(current, spec);

  if (next === current && distinct.length === 1) {
    console.error(`Already at ${current} — nothing to do.`);
    process.exit(1);
  }

  console.log(`${distinct.length > 1 ? "(drift)" : current} -> ${next}\n`);
  for (const { target } of found) {
    if (!dryRun) target.write(next);
    console.log(`  ${dryRun ? "would update" : "updated"}  ${target.label}`);
  }

  if (dryRun) {
    console.log("\nDry run — nothing written.");
  } else {
    // Re-read as an independent confirmation that all four now agree.
    const after = [...new Set(buildTargets(root).map((t) => t.read()))];
    if (after.length !== 1 || after[0] !== next) {
      console.error(`\nVerification failed — manifests now read: ${after.join(", ")}`);
      process.exit(1);
    }
    console.log(`\nAll four manifests verified at ${next}.`);
  }

  // Sweep the About tab + README for a stray hardcoded version. `current` is the
  // pre-bump value; under drift we only reach here with an explicit target, so
  // there's no single "old" version to sweep for — skip it then and let the diff
  // speak. Otherwise report: silence (0 hits) is the healthy state; any hit is a
  // hardcoded version that should be made dynamic instead.
  if (distinct.length === 1) {
    const swept = sweepSecondary(root, current, next, { dryRun });
    const touched = swept.filter((s) => s.count > 0);
    console.log("");
    if (touched.length === 0) {
      console.log("About tab + README carry no hardcoded version (read dynamically) — nothing to sweep.");
    } else {
      for (const { label, count } of touched) {
        console.log(`  ${dryRun ? "would rewrite" : "rewrote"} ${count} hardcoded ${current} → ${next}  ${label}`);
      }
      console.warn(
        "\n⚠ A hardcoded version was found in a surface that should read it dynamically.\n" +
          "  Swept it for now, but consider wiring that surface to getVersion() / the\n" +
          "  release badge so it can't drift again. Review the diff before committing."
      );
    }
  }
}

main();
