# CI / PR Quality Gate

The [`CI`](../.github/workflows/ci.yml) workflow runs on every pull request targeting `main`
(and on pushes to `main`). It is the merge gate: a PR may only be merged once CI is green.

> Release builds (signed installers for macOS/Windows/Linux) are produced separately by the
> manually-triggered [`Release`](../.github/workflows/release.yml) workflow — not by CI.

## What it checks

| Job | Steps | Purpose |
| --- | --- | --- |
| **Frontend** | `pnpm install --frozen-lockfile` → `tsc --noEmit` → `pnpm test` → `pnpm build` | Lockfile integrity, TypeScript type-check (the project's lint gate — strict mode, no unused locals/params), Vitest smoke tests, production bundle builds |
| **Backend (Rust)** | `cargo fmt --check` → `cargo clippy -- -D warnings` → `cargo test` → `cargo build` | Formatting, lints (warnings fail the build), tests, backend compiles |
| **CI Success** | aggregates the two jobs | Single status check to require in branch protection |

Notes:
- Frontend tests run with Vitest (`src/**/*.test.ts`, config in `vitest.config.ts`) — currently smoke tests for RAG context assembly and OpenAI/Gemini SSE parsing.
- Rust unit tests live inline in `src-tauri/src/secrets.rs` and `protocol.rs`.
- The Rust job installs `libdbus-1-dev` — required by the `keyring` crate's Secret Service backend on Linux.
- `clippy` is enforced with `-D warnings`: any new warning fails CI.

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
(Requiring only `CI Success` is enough — it transitively depends on the `frontend` and `rust` jobs.)

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
