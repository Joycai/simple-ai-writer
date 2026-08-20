# CI / PR Quality Gate

The [`CI`](../.github/workflows/ci.yml) workflow runs on every pull request targeting `main`
(and on pushes to `main`). It is the merge gate: a PR may only be merged once CI is green.

> Release builds (signed installers for macOS/Windows/Linux) are produced separately by the
> manually-triggered [`Release`](../.github/workflows/release.yml) workflow — not by CI.

## What it checks

| Job | Steps | Purpose |
| --- | --- | --- |
| **Detect changed areas** | `dorny/paths-filter` | Decides whether the Rust job has anything to do |
| **Frontend** | `pnpm install --frozen-lockfile` → `tsc --noEmit` → `pnpm test` → `pnpm build` | Lockfile integrity, TypeScript type-check (the project's lint gate — strict mode, no unused locals/params), Vitest smoke tests, production bundle builds |
| **Backend (Rust)** | `cargo fmt --check` → `cargo clippy -- -D warnings` → `cargo test` → `cargo build` | Formatting, lints (warnings fail the build), tests, backend compiles |
| **Sync server** | the same four cargo steps, in `server/` | The knowledge-base backup server (`server/`) — a plain axum binary, so it needs none of the webview apt packages the Tauri job installs |
| **CI Success** | aggregates the four jobs | Single status check to require in branch protection |

Notes:
- Frontend tests run with Vitest (`src/**/*.test.ts`, config in `vitest.config.ts`) — currently smoke tests for RAG context assembly and OpenAI/Gemini SSE parsing.
- Rust unit tests live inline in `src-tauri/src/secrets.rs` and `protocol.rs`; the sync server's live inline in `server/src/ids.rs` and `store.rs`.
- `clippy` is enforced with `-D warnings`: any new warning fails CI.

### Why the Rust and server jobs are conditional

Most PRs here are frontend-only, and the Rust job spends nearly all of its ~2–3 minutes on
setup that proves nothing when no Rust file moved: ~30–80 s installing the webkit dev tree
via apt, plus ~40–70 s restoring the cargo cache. So it is gated on the diff touching
`src-tauri/**` or `.github/workflows/ci.yml`; a frontend-only PR finishes in about 35 s.

`server/**` gates the sync-server job the same way, and it shares nothing with the Tauri
job — no apt step, its own cargo cache — so a server-only PR is also about half a minute.

`CI Success` therefore treats a **skipped** Rust or server job as a pass — it only fails on an actual
non-success. Keep it that way if you add more conditional jobs: `needs: [...]` with
`if: always()` reports skipped jobs as `skipped`, not `success`, so a naive
`!= "success"` check would fail every frontend-only PR.

### Why the apt list is short

The Rust job links, it does not bundle — no AppImage or `.deb` comes out of CI — so it
installs only what `cargo build` needs to link:

- `libwebkit2gtk-4.1-dev` — the webview; the bulk of the install time.
- `libdbus-1-dev` — `libdbus-sys` really is in the build graph, reached via `tao → dbus`.
  (Not for `keyring`: v4 talks to Secret Service through `zbus`, which is pure Rust.)

Deliberately **absent**, and they should stay absent:

- `librsvg2-dev`, `patchelf` — bundler-only. `release.yml` still installs them.
- `libappindicator3-dev` — the `libappindicator` crate is not in the Linux dependency graph
  at all (this app has no tray icon). Verify with:
  ```bash
  cd src-tauri && cargo tree --target x86_64-unknown-linux-gnu -e normal -i libappindicator
  ```

If a link error ever points at a missing `-dev` package, add that one package rather than
reinstating the whole old list.

### Why the packages come from a cache

The step is installed through [`awalsh128/cache-apt-pkgs-action`] rather than a plain
`apt-get install`, because its problem was the **tail**, not the average. Measured across
40 successful runs before the change:

```
21 21 22 23 23 23 24 26 27 27 27 27 28 29 29 29 29 31 31 33
34 35 35 36 37 38 41 41 42 44 44 45 45 49 49 55 57 78 165 445
```

Median 33 s, p90 ~50 s — but 78 / 165 / 445 s at the top, because it fetches from the public
Ubuntu mirrors and those occasionally crawl. Restoring from the Actions cache swaps that for
GitHub's own infrastructure; on a cache **miss** the action just runs apt, i.e. exactly the
old behaviour, so the worst case is unchanged and the common case loses its tail.

Bump the action's `version:` input to force the cache to rebuild (e.g. after changing the
package list). If a restore ever produces a subtly broken install, that surfaces as a link
error in `cargo build`, not as a silent pass.

One thing was given up in the trade: the action resolves dependencies itself and exposes no
`--no-install-recommends`, so recommended packages come back. That makes the short package
list above matter *more*, not less — it is now what keeps the cache small.

[`awalsh128/cache-apt-pkgs-action`]: https://github.com/awalsh128/cache-apt-pkgs-action

## Enforcing "must pass before merge"

The workflow defines the checks; **GitHub branch protection** is what makes them required.
Enable it once per repository (requires admin):

### Option A — GitHub UI
Settings → Branches → Add branch ruleset (or protect `main`) → enable
**Require status checks to pass before merging** → search and add **`CI Success`**.
Also recommended: **Require branches to be up to date before merging**.

### Option B — `gh` CLI
```bash
gh api -X PUT repos/Joycai/simple-ai-writer/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=CI Success' \
  -f 'enforce_admins=true' \
  -f 'required_pull_request_reviews[required_approving_review_count]=0' \
  -f 'restrictions=' 2>/dev/null
```
(Requiring only `CI Success` is enough — it transitively depends on the `changes`, `frontend` and
`rust` jobs. Requiring `Backend (fmt, clippy, test, build)` directly would deadlock every
frontend-only PR, since that job is skipped rather than run.)

## Keeping CI green locally

Run the same checks before pushing:

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm test
pnpm build

cd src-tauri
cargo fmt --all -- --check     # or `cargo fmt --all` to auto-fix
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```
