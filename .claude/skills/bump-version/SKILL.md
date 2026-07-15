---
name: bump-version
description: Bump this app's version across all four Tauri manifests (package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock) and commit the result on a branch. Use this whenever the user wants to raise, set, or check the app version — "bump the version", "bump patch/minor/major", "cut 0.2.0", "prep a release", "update the version number", "are the version files in sync?" — even if they never name the files. The four manifests must move in lockstep or the running app reports a different version than the installer that shipped it, so prefer this skill over hand-editing any version string.
---

# Bump the app version

This is a Tauri app, so the version is duplicated across four files that must
agree. Hand-editing is how they drift: someone bumps `package.json`, the bundler
reads `tauri.conf.json`, and the shipped app reports a version nobody released.
This skill moves all four together and verifies the result.

## The four manifests

| File | Why it carries the version |
| --- | --- |
| `package.json` | Frontend/pnpm package metadata |
| `src-tauri/tauri.conf.json` | **What the bundled app actually reports** and what names the installer |
| `src-tauri/Cargo.toml` | The Rust crate version (`[package]` section only) |
| `src-tauri/Cargo.lock` | The `simple-ai-writer` entry; cargo rewrites it on build if it disagrees with Cargo.toml, producing a surprise diff |

## Scheme

SemVer `MAJOR.MINOR.PATCH`, computed from the current version. The repo is the
source of truth. Note the existing release tags (`v26.6.16`) are CalVer from an
older date-stamp default — don't let that mislead you into date-stamping a bump.

## Workflow

**1. Dry-run first — always.** This is how you learn the current version *and*
whether the manifests have drifted, both of which you need before you can even
name the branch. Don't skip it because the bump seems obvious:

```bash
node .claude/skills/bump-version/scripts/bump-version.mjs patch --dry-run
```

Accepts `patch`, `minor`, `major`, or an explicit `X.Y.Z`. If it reports drift,
stop and jump to [Handling drift](#handling-drift). Otherwise it prints the
`0.1.0 -> 0.1.1` line that gives you the new version.

**2. Branch from an explicit base.** The bump should be a standalone reviewable
change, and PRs gate on CI into `main`. A bare `git checkout -b` branches from
whatever HEAD happens to be — which silently drags an in-progress feature commit
into the bump if the user is mid-branch. Name the base:

```bash
git diff --cached --stat                  # expect empty: no unrelated staged work
git fetch origin
git checkout -b chore/bump-<new-version> origin/main
```

If the working tree has uncommitted edits, or the user is deliberately mid-feature
and might want the bump on *that* branch, ask rather than assume. (`origin/HEAD`
in this repo has pointed at a feature branch before, so don't infer the base from
it — `origin/main` is the right base unless the user says otherwise.)

**3. Apply, and read the diff.** Re-run without `--dry-run`:

```bash
node .claude/skills/bump-version/scripts/bump-version.mjs patch
git diff
```

Expect exactly four one-line changes — one per manifest. More than that means a
replacement hit something unintended: stop and investigate rather than commit.
(Healing drift is the one exception: a file already at the target won't show a
change, so you'll see fewer than four.)

The script re-reads all four files afterward and fails loudly if they disagree,
so a successful run is its own verification — no need to re-grep.

**4. Commit those four files only.**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump version to <new-version>"
```

If the tree had unrelated edits, leave them out — a version bump tangled into a
feature diff is hard to revert.

Stop here unless the user asked to release. Pushing and releasing are separate
decisions.

## Handling drift

If the manifests disagree, the script exits non-zero listing each file's version
and refuses to pick a winner. That refusal is the point: silently choosing is how
a wrong version ships.

Don't bounce the bare question "which is right?" back at the user — come with
evidence, since they usually don't know either:

- **Find out which file moved and when.** `git log --oneline -- package.json`
  (and the same for the others) usually shows one manifest edited alone. That
  commit is the drift.
- **Weigh the files by what they control.** `tauri.conf.json` is what the bundle
  actually reports, so it reflects what users are really running. A version that
  appears *only* in `package.json` is more often a stray hand-edit than a real
  release — resist the pull toward "just take the highest number."
- **Then present the options.** Say which version ships today, which file
  disagrees, and what each choice implies for the bump the user asked for.

Once they decide, heal all four in one commit:

```bash
node .claude/skills/bump-version/scripts/bump-version.mjs 0.3.0 --allow-drift
```

`--allow-drift` requires an explicit `X.Y.Z`. A relative bump can't work here —
`patch`/`minor` need one unambiguous current version to count from, and under
drift there isn't one. So if the user asked for "the next minor", you must go
back and convert that into a literal version with them before healing.

This is also the answer to "are the versions in sync?" — run any `--dry-run` and
the drift report either fires or it doesn't.

## If the user also wants to release

Releasing is `.github/workflows/release.yml`, dispatched manually. One gotcha
worth flagging to the user, because it silently ignores the repo:

> The workflow rewrites the manifests **inside its own CI checkout** and never
> commits them back. Its `version` input defaults to a `YY.M.D` date stamp. So
> dispatching it without an explicit version builds `26.7.15`, **not** the
> version you just committed.

Pass the version explicitly so the tag, the release, and the repo agree:

```bash
gh workflow run release.yml -f version=<new-version>
```

The bumped commit should be merged to `main` first, since the workflow builds
from the branch it's dispatched on (default `main`).
