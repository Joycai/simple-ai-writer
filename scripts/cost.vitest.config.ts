/**
 * Config for the manual read/search cost harness only.
 *
 * Separate from the repo's vitest.config.ts for the same reason
 * `ab.vitest.config.ts` is: that one includes `src/**` and is what CI runs,
 * and this harness is a benchmark — its numbers move with the machine, so it
 * must never become a gate. Vitest is only the runner because the project has
 * no standalone TS runner.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/read-cost.ts"],
    testTimeout: 30 * 60 * 1000,
  },
});
