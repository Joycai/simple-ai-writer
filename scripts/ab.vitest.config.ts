/**
 * Config for the manual prompt A/B harness only.
 *
 * Separate from the repo's vitest.config.ts on purpose: that one includes
 * `src/**` and is what CI runs, and prompt-ab.ts talks to a live local model —
 * it must never join that suite. Vitest is only the runner here because the
 * project has no standalone TS runner and adding one for a single manual
 * script isn't worth a devDependency.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/prompt-ab.ts"],
    testTimeout: 3 * 60 * 60 * 1000,
  },
});
