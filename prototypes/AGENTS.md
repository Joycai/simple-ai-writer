# Prototype workspace instructions

Follow the root `AGENTS.md`. This directory is a UX/UI review environment,
not the application boot path.

- Read `docs/reference/design-system.md` and `terminology.md` before design work.
  The existing Manuscript language remains authoritative: square corners,
  token-based colours, one restrained accent, clear focus, and reduced motion.
- Import the app's tokens and suitable pure controls instead of copying them.
  Write theme attributes only through `src/lib/theme/scheme.ts`.
- Keep fixtures fictional and state in memory. Do not import application
  stores, Tauri APIs, provider clients, preference storage, or project data.
- Label simulated AI behaviour. Every displayed action must work locally;
  empty/error states are explicit scenarios, not hidden failures.
- Record briefs and design decisions in `docs/feature/` or the relevant living
  reference. Keep old Claude Design artifacts as historical design evidence.
- Review the rendered result in the browser: light/dark, narrow/wide, keyboard,
  reduced motion, and the full interaction sequence. A build alone is not
  visual verification.
- Run `pnpm prototypes:check`, `pnpm prototypes:build`, and the relevant
  documentation guards. Production changes additionally follow root checks.
